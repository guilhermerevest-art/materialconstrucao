import { Router } from 'express';
import type pg from 'pg';
import { z } from 'zod';
import { currentUser } from '../auth.js';
import type { AppContext } from '../context.js';
import { withSession } from '../db/session.js';
import { loadFulfillment } from '../deliveries/queries.js';
import { HttpError } from '../errors.js';
import { formatOrderNumber } from '../lib/format.js';
import { optionalQueryId, optionalText, parseId } from '../lib/validation.js';
import { renderSeparationPdf, type SeparationItem, type SeparationPdfData } from '../pdf/separationPdf.js';

const querySchema = z.object({ delivery_id: optionalQueryId });

const checkSchema = z.object({
  delivery_id: z.number().int().positive().nullable().default(null),
  note: optionalText(300),
  items: z
    .array(
      z.object({
        order_item_id: z.number().int().positive(),
        counted: z.number().min(0).max(9_999_999).transform((v) => Math.round(v * 1000) / 1000),
      }),
    )
    .min(1)
    .max(300),
});

const NOT_FOUND = 'Pedido não encontrado.';

type SeparationOrder = SeparationPdfData['order'] & { status: string; delivery_tracking: boolean };

/**
 * O que separar: os itens da entrega escolhida ou, sem ela, o que ainda falta sair do
 * pedido (vendido menos o já entregue). Pedido antigo, sem controle de entregas: tudo.
 */
async function loadSeparation(db: pg.PoolClient, orderId: number, deliveryId: number | null) {
  const { rows } = await db.query<SeparationOrder>(
    `select o.id, o.status, o.delivery_tracking, o.delivery_address, o.notes, o.confirmed_at,
            c.name as client_name, c.whatsapp as client_whatsapp, s.name as store_name, u.name as user_name
       from orders o
       join clients c on c.id = o.client_id
       join stores s on s.id = o.store_id
       join users u on u.id = o.user_id
      where o.id = $1`,
    [orderId],
  );
  const order = rows[0];
  if (!order) throw new HttpError(404, NOT_FOUND);
  if (order.status !== 'order') throw new HttpError(409, 'Só pedidos confirmados têm separação.');

  if (deliveryId !== null) {
    const delivery = await db.query<NonNullable<SeparationPdfData['delivery']>>(
      'select id, kind, scheduled_date, period, address from deliveries where id = $1 and order_id = $2',
      [deliveryId, orderId],
    );
    if (!delivery.rows[0]) throw new HttpError(404, 'Entrega não encontrada neste pedido.');
    const items = await db.query<SeparationItem>(
      `select i.id as order_item_id, i.product_id, i.product_code, i.product_name, i.unit, di.quantity
         from delivery_items di join order_items i on i.id = di.order_item_id
        where di.delivery_id = $1
        order by i.position`,
      [deliveryId],
    );
    return { order, delivery: delivery.rows[0], items: items.rows };
  }

  const items = (await loadFulfillment(db, orderId))
    .map((line) => ({
      order_item_id: line.order_item_id,
      product_id: line.product_id,
      product_code: line.product_code,
      product_name: line.product_name,
      unit: line.unit,
      quantity: order.delivery_tracking ? Math.round((line.quantity - line.delivered) * 1000) / 1000 : line.quantity,
    }))
    .filter((item) => item.quantity > 0);
  return { order, delivery: null, items };
}

/** Lista de separação (PDF) e conferência da separação. */
export function separationRouter(ctx: AppContext) {
  const router = Router();

  router.get('/orders/:id/separation', async (req, res) => {
    const user = currentUser(req);
    const id = parseId(req.params.id, NOT_FOUND);
    const { delivery_id } = querySchema.parse(req.query);
    const data = await withSession(ctx.pool, user, async (db) => {
      const separation = await loadSeparation(db, id, delivery_id ?? null);
      const checks = await db.query(
        `select k.id, k.delivery_id, k.ok, k.items, k.note, k.created_at, u.name as user_name
           from order_checks k join users u on u.id = k.user_id
          where k.order_id = $1
          order by k.created_at desc, k.id desc
          limit 10`,
        [id],
      );
      return { ...separation, checks: checks.rows };
    });
    const { order, delivery, items, checks } = data;
    res.json({
      order: { id: order.id, client_name: order.client_name, delivery_address: order.delivery_address, notes: order.notes },
      delivery,
      items,
      checks,
    });
  });

  router.get('/orders/:id/separation/pdf', async (req, res) => {
    const user = currentUser(req);
    const id = parseId(req.params.id, NOT_FOUND);
    const { delivery_id } = querySchema.parse(req.query);
    const data = await withSession(ctx.pool, user, (db) => loadSeparation(db, id, delivery_id ?? null));
    if (!data.items.length) throw new HttpError(409, 'Não há nada para separar: tudo já foi entregue.');
    const pdf = await renderSeparationPdf(data, ctx.config.timeZone);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="separacao-${formatOrderNumber(id)}.pdf"`);
    res.setHeader('Cache-Control', 'no-store');
    res.send(pdf);
  });

  /** Registra a conferência: o que foi contado de cada item e se bateu com o que tinha que sair. */
  router.post('/orders/:id/checks', async (req, res) => {
    const user = currentUser(req);
    const id = parseId(req.params.id, NOT_FOUND);
    const body = checkSchema.parse(req.body);
    const check = await withSession(ctx.pool, user, async (db) => {
      const { items } = await loadSeparation(db, id, body.delivery_id);
      const counted = new Map(body.items.map((i) => [i.order_item_id, i.counted]));
      for (const id of counted.keys()) {
        if (!items.some((i) => i.order_item_id === id)) throw new HttpError(400, 'Um dos itens não é desta separação. Atualize a página.');
      }
      const lines = items.map((item) => ({
        order_item_id: item.order_item_id,
        product_name: item.product_name,
        unit: item.unit,
        expected: item.quantity,
        counted: counted.get(item.order_item_id) ?? 0,
      }));
      const ok = lines.every((l) => Math.abs(l.expected - l.counted) < 0.0005);
      const { rows } = await db.query(
        `insert into order_checks (tenant_id, order_id, delivery_id, user_id, ok, items, note)
         values ($1, $2, $3, $4, $5, $6, $7)
         returning id, delivery_id, ok, items, note, created_at`,
        [user.tenant_id, id, body.delivery_id, user.id, ok, JSON.stringify(lines), body.note],
      );
      return { ...rows[0], user_name: user.name };
    });
    res.status(201).json({ check });
  });

  return router;
}
