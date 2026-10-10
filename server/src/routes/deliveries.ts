import { Router } from 'express';
import type pg from 'pg';
import { z } from 'zod';
import { currentUser, requireAdmin, type AuthUser } from '../auth.js';
import type { AppContext } from '../context.js';
import { queryAs, withSession } from '../db/session.js';
import {
  insertDelivery,
  loadFulfillment,
  lockOrderForDelivery,
} from '../deliveries/queries.js';
import { HttpError } from '../errors.js';
import { todayIn } from '../lib/format.js';
import { optionalQueryId, optionalText, parseId } from '../lib/validation.js';
import { renderRoutePdf, type RoutePdfData } from '../pdf/routePdf.js';

const dateSchema = z.string('Escolha a data.').regex(/^\d{4}-\d{2}-\d{2}$/, 'Data inválida.');
const periodSchema = z.enum(['morning', 'afternoon']).nullable().default(null);

const deliverySchema = z
  .object({
    kind: z.enum(['pickup', 'delivery'], 'Escolha retirada ou entrega.'),
    status: z.enum(['done', 'scheduled']),
    scheduled_date: dateSchema.nullable().default(null),
    period: periodSchema,
    address: optionalText(300),
    receiver_name: optionalText(120),
    notes: optionalText(300),
    items: z
      .array(
        z.object({
          order_item_id: z.number().int().positive(),
          quantity: z.number().min(0).max(9_999_999).transform((v) => Math.round(v * 1000) / 1000),
        }),
      )
      .min(1, 'Informe os itens.')
      .max(300),
  })
  .refine((d) => !(d.kind === 'delivery' && d.status === 'done'), {
    message: 'Entrega no endereço é agendada e confirmada pelo comprovante.',
  });

const rescheduleSchema = z.object({
  scheduled_date: dateSchema,
  period: periodSchema,
  address: optionalText(300),
  notes: optionalText(300),
});

// Assinatura (PNG do canvas) e foto (JPEG reduzido no celular) cabem juntas no limite
// de 1 MB do corpo da requisição.
const MAX_SIGNATURE_BYTES = 150 * 1024;
const MAX_PHOTO_BYTES = 600 * 1024;

const imageData = (mimes: string[], maxBytes: number, label: string) =>
  z
    .string()
    .nullable()
    .default(null)
    .refine(
      (v) => v === null || new RegExp(`^data:(${mimes.join('|')});base64,[A-Za-z0-9+/]+={0,2}$`).test(v),
      `${label} em formato inválido.`,
    )
    .refine((v) => v === null || Buffer.byteLength(v.split(',')[1] ?? '', 'base64') <= maxBytes, `${label} grande demais.`);

const completeSchema = z.object({
  receiver_name: z.string('Informe quem recebeu.').trim().min(2, 'Informe quem recebeu.').max(120),
  receiver_document: optionalText(30),
  signature: imageData(['image/png'], MAX_SIGNATURE_BYTES, 'Assinatura'),
  photo: imageData(['image/jpeg', 'image/png', 'image/webp'], MAX_PHOTO_BYTES, 'Foto'),
  notes: optionalText(300),
});

const cancelSchema = z.object({
  reason: z.string('Informe o motivo.').trim().min(3, 'Informe o motivo.').max(300),
});

const listSchema = z.object({
  from: dateSchema.optional(),
  to: dateSchema.optional(),
  store_id: optionalQueryId,
  overdue: z.enum(['true', 'false']).optional(),
});

const routeSchema = z.object({
  store_id: z.number().int().positive().nullable().default(null),
  route_date: dateSchema,
  vehicle_id: z.number().int().positive().nullable().default(null),
  driver_name: optionalText(80),
  notes: optionalText(300),
  delivery_ids: z.array(z.number().int().positive()).min(1, 'Escolha pelo menos uma entrega.').max(100),
});

const vehicleSchema = z.object({
  name: z.string('Informe o nome do veículo.').trim().min(2, 'Informe o nome do veículo.').max(60),
  plate: z.preprocess(
    (v) => (typeof v === 'string' ? v.replace(/[\s-]/g, '').toUpperCase() || null : (v ?? null)),
    z.string().regex(/^[A-Z]{3}\d[A-Z0-9]\d{2}$/, 'Placa inválida. Ex.: ABC1D23 ou ABC1234.').nullable(),
  ),
  active: z.boolean().default(true),
});

const NOT_FOUND = 'Entrega não encontrada.';
const ROUTE_NOT_FOUND = 'Romaneio não encontrado.';

/** Campos da entrega para listas e telas (sem a assinatura e a foto, que vêm sob demanda). */
const DELIVERY_COLUMNS = `d.id, d.order_id, d.store_id, s.name as store_name, d.kind, d.status, d.scheduled_date, d.period,
  d.address, d.route_id, d.route_position, d.receiver_name, d.receiver_document, d.notes, d.cancel_reason,
  d.created_at, d.completed_at, d.cancelled_at,
  (d.signature_data is not null) as has_signature, (d.photo_data is not null) as has_photo,
  c.name as client_name, c.whatsapp as client_whatsapp, cu.name as created_by_name, co.name as completed_by_name,
  coalesce((
    select json_agg(json_build_object('order_item_id', di.order_item_id, 'product_id', i.product_id,
                                      'product_code', i.product_code, 'product_name', i.product_name,
                                      'unit', i.unit, 'quantity', di.quantity) order by i.position)
      from delivery_items di join order_items i on i.id = di.order_item_id
     where di.delivery_id = d.id), '[]') as items`;

const DELIVERY_FROM = `deliveries d
  join orders o on o.id = d.order_id
  join clients c on c.id = o.client_id
  join stores s on s.id = d.store_id
  join users cu on cu.id = d.created_by
  left join users co on co.id = d.completed_by`;

async function loadDelivery(db: pg.PoolClient, id: number) {
  const { rows } = await db.query(
    `select ${DELIVERY_COLUMNS}, o.notes as order_notes, o.client_site_id
       from ${DELIVERY_FROM} where d.id = $1`,
    [id],
  );
  if (!rows[0]) throw new HttpError(404, NOT_FOUND);
  return rows[0];
}

async function lockDelivery(db: pg.PoolClient, id: number) {
  const { rows } = await db.query<{ id: number; order_id: number; status: string; route_id: number | null; store_id: number }>(
    'select id, order_id, status, route_id, store_id from deliveries where id = $1 for update',
    [id],
  );
  if (!rows[0]) throw new HttpError(404, NOT_FOUND);
  return rows[0];
}

/** Romaneios com as entregas, na ordem de saída. */
async function loadRoutes(db: pg.PoolClient, where: string, params: unknown[]) {
  const { rows } = await db.query(
    `select r.id, r.store_id, s.name as store_name, r.route_date, r.vehicle_id, v.name as vehicle_name, v.plate as vehicle_plate,
            r.driver_name, r.status, r.notes, r.created_at, r.departed_at, r.finished_at
       from delivery_routes r
       join stores s on s.id = r.store_id
       left join vehicles v on v.id = r.vehicle_id
      where ${where}
      order by r.route_date, r.id`,
    params,
  );
  return rows;
}

function storeFilter(user: AuthUser, requested: number | undefined) {
  return user.role === 'admin' ? (requested ?? null) : user.store_id;
}

/** Entregas e retiradas dos pedidos, romaneios de carga e veículos. */
export function deliveriesRouter(ctx: AppContext) {
  const router = Router();
  const { pool } = ctx;

  // ---- Pedido: saldo a entregar e as entregas dele

  router.get('/orders/:id/deliveries', async (req, res) => {
    const user = currentUser(req);
    const orderId = parseId(req.params.id, 'Pedido não encontrado.');
    const data = await withSession(pool, user, async (db) => {
      const { rows } = await db.query<{ delivery_tracking: boolean }>('select delivery_tracking from orders where id = $1', [
        orderId,
      ]);
      if (!rows[0]) throw new HttpError(404, 'Pedido não encontrado.');
      const deliveries = await db.query(
        `select ${DELIVERY_COLUMNS} from ${DELIVERY_FROM} where d.order_id = $1 order by d.created_at, d.id`,
        [orderId],
      );
      return { tracking: rows[0].delivery_tracking, items: await loadFulfillment(db, orderId), deliveries: deliveries.rows };
    });
    res.json(data);
  });

  router.post('/orders/:id/deliveries', async (req, res) => {
    const user = currentUser(req);
    const orderId = parseId(req.params.id, 'Pedido não encontrado.');
    const body = deliverySchema.parse(req.body);
    const delivery = await withSession(pool, user, async (db) => {
      const order = await lockOrderForDelivery(db, orderId);
      const id = await insertDelivery(db, order, user, body);
      return loadDelivery(db, id);
    });
    res.status(201).json({ delivery });
  });

  // ---- Agenda

  router.get('/deliveries', async (req, res) => {
    const user = currentUser(req);
    const query = listSchema.parse(req.query);
    const storeId = storeFilter(user, query.store_id);
    const today = todayIn(ctx.config.timeZone);
    const deliveries = await withSession(pool, user, async (db) => {
      const where = ['($1::bigint is null or d.store_id = $1)'];
      const params: unknown[] = [storeId];
      if (query.overdue === 'true') {
        // Atrasadas: agendadas para antes do dia e ainda não feitas.
        params.push(query.from ?? today);
        where.push(`d.status in ('scheduled', 'in_route') and d.scheduled_date < $${params.length}`);
      } else {
        params.push(query.from ?? today, query.to ?? query.from ?? today);
        where.push(`d.scheduled_date between $${params.length - 1} and $${params.length}`);
      }
      const { rows } = await db.query(
        `select ${DELIVERY_COLUMNS}
           from ${DELIVERY_FROM}
          where ${where.join(' and ')}
          order by d.scheduled_date, d.period nulls last, d.route_id nulls first, d.route_position, d.id`,
        params,
      );
      return rows;
    });
    res.json({ items: deliveries });
  });

  router.get('/deliveries/:id', async (req, res) => {
    const id = parseId(req.params.id, NOT_FOUND);
    const delivery = await withSession(pool, currentUser(req), (db) => loadDelivery(db, id));
    res.json({ delivery });
  });

  /** Assinatura e foto do comprovante, só quando a tela pede. */
  router.get('/deliveries/:id/proof', async (req, res) => {
    const id = parseId(req.params.id, NOT_FOUND);
    const { rows } = await queryAs<{ signature_data: string | null; photo_data: string | null }>(
      pool,
      currentUser(req),
      'select signature_data, photo_data from deliveries where id = $1',
      [id],
    );
    if (!rows[0]) throw new HttpError(404, NOT_FOUND);
    res.setHeader('Cache-Control', 'private, max-age=3600');
    res.json({ signature: rows[0].signature_data, photo: rows[0].photo_data });
  });

  router.put('/deliveries/:id', async (req, res) => {
    const user = currentUser(req);
    const id = parseId(req.params.id, NOT_FOUND);
    const body = rescheduleSchema.parse(req.body);
    const delivery = await withSession(pool, user, async (db) => {
      const current = await lockDelivery(db, id);
      if (current.status !== 'scheduled') throw new HttpError(409, 'Só entregas agendadas (fora de rota) podem ser reagendadas.');
      await db.query(
        `update deliveries
            set scheduled_date = $2, period = $3, address = coalesce($4, address), notes = $5,
                -- Mudou de dia: sai do romaneio.
                route_id = case when scheduled_date = $2 then route_id end,
                route_position = case when scheduled_date = $2 then route_position end
          where id = $1`,
        [id, body.scheduled_date, body.period, body.address, body.notes],
      );
      return loadDelivery(db, id);
    });
    res.json({ delivery });
  });

  /** Comprovante: quem recebeu, assinatura e foto. Fecha a entrega. */
  router.post('/deliveries/:id/complete', async (req, res) => {
    const user = currentUser(req);
    const id = parseId(req.params.id, NOT_FOUND);
    const body = completeSchema.parse(req.body);
    const delivery = await withSession(pool, user, async (db) => {
      const current = await lockDelivery(db, id);
      if (current.status === 'done') throw new HttpError(409, 'Esta entrega já foi confirmada.');
      if (current.status === 'cancelled') throw new HttpError(409, 'Esta entrega foi cancelada.');
      await db.query(
        `update deliveries
            set status = 'done', completed_at = now(), completed_by = $2, receiver_name = $3, receiver_document = $4,
                signature_data = $5, photo_data = $6, notes = coalesce($7, notes)
          where id = $1`,
        [id, user.id, body.receiver_name, body.receiver_document, body.signature, body.photo, body.notes],
      );
      return loadDelivery(db, id);
    });
    res.json({ delivery });
  });

  /**
   * Não entregue, desmarcada ou registrada por engano: a quantidade volta para o saldo
   * a entregar. Estornar uma entrega já confirmada é só do admin.
   */
  router.post('/deliveries/:id/cancel', async (req, res) => {
    const user = currentUser(req);
    const id = parseId(req.params.id, NOT_FOUND);
    const { reason } = cancelSchema.parse(req.body);
    const delivery = await withSession(pool, user, async (db) => {
      const current = await lockDelivery(db, id);
      if (current.status === 'cancelled') throw new HttpError(409, 'Esta entrega já foi cancelada.');
      if (current.status === 'done' && user.role !== 'admin') {
        throw new HttpError(403, 'Só o administrador estorna uma entrega já confirmada.');
      }
      await db.query(
        `update deliveries
            set status = 'cancelled', cancelled_at = now(), cancelled_by = $2, cancel_reason = $3,
                completed_at = null, route_id = null, route_position = null
          where id = $1`,
        [id, user.id, reason],
      );
      return loadDelivery(db, id);
    });
    res.json({ delivery });
  });

  // ---- Romaneios

  router.get('/delivery-routes', async (req, res) => {
    const user = currentUser(req);
    const query = listSchema.parse(req.query);
    const storeId = storeFilter(user, query.store_id);
    const day = query.from ?? todayIn(ctx.config.timeZone);
    const routes = await withSession(pool, user, (db) =>
      loadRoutes(db, '($1::bigint is null or r.store_id = $1) and r.route_date between $2 and $3', [storeId, day, query.to ?? day]),
    );
    res.json({ items: routes });
  });

  /** Valida as entregas do romaneio: agendadas, da mesma loja e fora de outro romaneio. */
  async function assignDeliveries(db: pg.PoolClient, routeId: number, storeId: number, ids: number[]) {
    const { rows } = await db.query<{ id: number; status: string; store_id: number; kind: string; route_id: number | null }>(
      'select id, status, store_id, kind, route_id from deliveries where id = any($1::bigint[]) for update',
      [ids],
    );
    if (rows.length !== new Set(ids).size) throw new HttpError(400, 'Uma das entregas não existe mais. Atualize a página.');
    for (const d of rows) {
      if (d.store_id !== storeId) throw new HttpError(400, 'Todas as entregas do romaneio precisam ser da mesma loja.');
      if (d.kind !== 'delivery') throw new HttpError(400, 'Retirada na loja não vai em romaneio.');
      if (d.status !== 'scheduled') throw new HttpError(409, 'Só entregas agendadas entram no romaneio.');
      if (d.route_id !== null && d.route_id !== routeId) throw new HttpError(409, `A entrega ${d.id} já está em outro romaneio.`);
    }
    await db.query('update deliveries set route_id = null, route_position = null where route_id = $1', [routeId]);
    await db.query(
      `update deliveries d set route_id = $1, route_position = r.position
         from unnest($2::bigint[]) with ordinality as r(id, position)
        where d.id = r.id`,
      [routeId, ids],
    );
  }

  router.post('/delivery-routes', async (req, res) => {
    const user = currentUser(req);
    const body = routeSchema.parse(req.body);
    const route = await withSession(pool, user, async (db) => {
      const { rows: first } = await db.query<{ store_id: number }>('select store_id from deliveries where id = $1', [
        body.delivery_ids[0],
      ]);
      const storeId = user.role === 'admin' ? (body.store_id ?? first[0]?.store_id) : user.store_id;
      if (!storeId) throw new HttpError(400, 'Escolha a loja.');
      const { rows } = await db.query<{ id: number }>(
        `insert into delivery_routes (tenant_id, store_id, route_date, vehicle_id, driver_name, notes, created_by)
         values ($1, $2, $3, $4, $5, $6, $7) returning id`,
        [user.tenant_id, storeId, body.route_date, body.vehicle_id, body.driver_name, body.notes, user.id],
      );
      const id = rows[0]!.id;
      await assignDeliveries(db, id, storeId, body.delivery_ids);
      return (await loadRoutes(db, 'r.id = $1', [id]))[0];
    });
    res.status(201).json({ route });
  });

  router.put('/delivery-routes/:id', async (req, res) => {
    const user = currentUser(req);
    const id = parseId(req.params.id, ROUTE_NOT_FOUND);
    const body = routeSchema.parse(req.body);
    const route = await withSession(pool, user, async (db) => {
      const { rows } = await db.query<{ status: string; store_id: number }>(
        'select status, store_id from delivery_routes where id = $1 for update',
        [id],
      );
      if (!rows[0]) throw new HttpError(404, ROUTE_NOT_FOUND);
      if (rows[0].status !== 'open') throw new HttpError(409, 'Romaneio que já saiu não muda.');
      await db.query(
        'update delivery_routes set route_date = $2, vehicle_id = $3, driver_name = $4, notes = $5 where id = $1',
        [id, body.route_date, body.vehicle_id, body.driver_name, body.notes],
      );
      await assignDeliveries(db, id, rows[0].store_id, body.delivery_ids);
      return (await loadRoutes(db, 'r.id = $1', [id]))[0];
    });
    res.json({ route });
  });

  router.delete('/delivery-routes/:id', async (req, res) => {
    const user = currentUser(req);
    const id = parseId(req.params.id, ROUTE_NOT_FOUND);
    await withSession(pool, user, async (db) => {
      const { rows } = await db.query<{ status: string }>('select status from delivery_routes where id = $1 for update', [id]);
      if (!rows[0]) throw new HttpError(404, ROUTE_NOT_FOUND);
      if (rows[0].status !== 'open') throw new HttpError(409, 'Romaneio que já saiu não é desfeito.');
      await db.query('update deliveries set route_id = null, route_position = null where route_id = $1', [id]);
      await db.query('delete from delivery_routes where id = $1', [id]);
    });
    res.status(204).end();
  });

  /** Saiu para entrega: as entregas do romaneio ficam "em rota". */
  router.post('/delivery-routes/:id/depart', async (req, res) => {
    const user = currentUser(req);
    const id = parseId(req.params.id, ROUTE_NOT_FOUND);
    const route = await withSession(pool, user, async (db) => {
      const { rows } = await db.query<{ status: string }>('select status from delivery_routes where id = $1 for update', [id]);
      if (!rows[0]) throw new HttpError(404, ROUTE_NOT_FOUND);
      if (rows[0].status !== 'open') throw new HttpError(409, 'Este romaneio já saiu.');
      const { rowCount } = await db.query(`update deliveries set status = 'in_route' where route_id = $1 and status = 'scheduled'`, [id]);
      if (!rowCount) throw new HttpError(409, 'O romaneio está sem entregas.');
      await db.query(`update delivery_routes set status = 'in_route', departed_at = now() where id = $1`, [id]);
      return (await loadRoutes(db, 'r.id = $1', [id]))[0];
    });
    res.json({ route });
  });

  /**
   * Veículo voltou: o romaneio fecha. Entrega que ficou sem comprovante volta para
   * "agendada", fora do romaneio, para reagendar.
   */
  router.post('/delivery-routes/:id/finish', async (req, res) => {
    const user = currentUser(req);
    const id = parseId(req.params.id, ROUTE_NOT_FOUND);
    const result = await withSession(pool, user, async (db) => {
      const { rows } = await db.query<{ status: string }>('select status from delivery_routes where id = $1 for update', [id]);
      if (!rows[0]) throw new HttpError(404, ROUTE_NOT_FOUND);
      if (rows[0].status !== 'in_route') throw new HttpError(409, 'Só romaneio em rota é concluído.');
      const { rowCount } = await db.query(
        `update deliveries set status = 'scheduled', route_id = null, route_position = null
          where route_id = $1 and status = 'in_route'`,
        [id],
      );
      await db.query(`update delivery_routes set status = 'done', finished_at = now() where id = $1`, [id]);
      return { route: (await loadRoutes(db, 'r.id = $1', [id]))[0], returned: rowCount ?? 0 };
    });
    res.json(result);
  });

  router.get('/delivery-routes/:id/pdf', async (req, res) => {
    const user = currentUser(req);
    const id = parseId(req.params.id, ROUTE_NOT_FOUND);
    const data = await withSession(pool, user, async (db): Promise<RoutePdfData> => {
      const route = (await loadRoutes(db, 'r.id = $1', [id]))[0];
      if (!route) throw new HttpError(404, ROUTE_NOT_FOUND);
      const { rows } = await db.query(
        `select ${DELIVERY_COLUMNS}, o.notes as order_notes
           from ${DELIVERY_FROM}
          where d.route_id = $1
          order by d.route_position, d.id`,
        [id],
      );
      const store = await db.query('select name, address, phone from stores where id = $1', [route.store_id]);
      return { route, store: store.rows[0], deliveries: rows } as RoutePdfData;
    });
    const pdf = await renderRoutePdf(data, ctx.config.timeZone);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="romaneio-${id}.pdf"`);
    res.setHeader('Cache-Control', 'no-store');
    res.send(pdf);
  });

  // ---- Veículos

  router.get('/vehicles', async (req, res) => {
    const { rows } = await queryAs(
      pool,
      currentUser(req),
      'select id, name, plate, active, created_at from vehicles order by active desc, lower(name)',
    );
    res.json({ items: rows });
  });

  router.post('/vehicles', requireAdmin, async (req, res) => {
    const me = currentUser(req);
    const body = vehicleSchema.parse(req.body);
    const { rows } = await queryAs(
      pool,
      me,
      'insert into vehicles (tenant_id, name, plate, active) values ($1, $2, $3, $4) returning id, name, plate, active, created_at',
      [me.tenant_id, body.name, body.plate, body.active],
    );
    res.status(201).json({ vehicle: rows[0] });
  });

  router.put('/vehicles/:id', requireAdmin, async (req, res) => {
    const id = parseId(req.params.id, 'Veículo não encontrado.');
    const body = vehicleSchema.parse(req.body);
    const { rows } = await queryAs(
      pool,
      currentUser(req),
      'update vehicles set name = $2, plate = $3, active = $4 where id = $1 returning id, name, plate, active, created_at',
      [id, body.name, body.plate, body.active],
    );
    if (!rows[0]) throw new HttpError(404, 'Veículo não encontrado.');
    res.json({ vehicle: rows[0] });
  });

  return router;
}
