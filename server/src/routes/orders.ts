import { Router } from 'express';
import type pg from 'pg';
import { z } from 'zod';
import { currentUser, requireAdmin, type AuthUser } from '../auth.js';
import type { AppContext } from '../context.js';
import { withSession } from '../db/session.js';
import { HttpError } from '../errors.js';
import {
  describeEvolutionError,
  keySourceOf,
  loadEvolutionSettings,
  sendPdfDocument,
  sendTextMessage,
} from '../lib/evolution.js';
import { documentLabel, formatMoney, formatOrderNumber } from '../lib/format.js';
import { normalizeWhatsapp } from '../lib/phone.js';
import { likePattern, optionalQuery, optionalQueryId, optionalText, pagination, parseId } from '../lib/validation.js';
import { loadOrderDetail, writeOrderItems, type OrderDetail } from '../orders/queries.js';
import { orderFileName, renderOrderPdf } from '../pdf/orderPdf.js';
import { cancelOrder, onOrderConfirmed, reopenQuote } from '../orders/lifecycle.js';
import { assertClientSite } from './clientSites.js';
import {
  loadOrderWorkflow,
  moveOrderStage,
  renderStageMessage,
  type EnteredStage,
} from '../workflow/queries.js';

const itemSchema = z.object({
  product_id: z.number().int().positive(),
  quantity: z
    .number('Informe a quantidade.')
    .positive('A quantidade precisa ser maior que zero.')
    .max(999_999, 'Quantidade alta demais.'),
});

const orderSchema = z.object({
  client_id: z.number('Selecione o cliente.').int().positive('Selecione o cliente.'),
  status: z.enum(['quote', 'order'], 'Escolha entre orçamento e pedido.'),
  notes: optionalText(1000),
  store_id: z.number().int().positive().nullable().optional(),
  payment_method_id: z.number().int().positive().nullable().default(null),
  delivery_address: optionalText(300),
  // Obra do cliente escolhida no PDV; o endereço de entrega continua sendo o texto acima.
  client_site_id: z.number().int().positive().nullable().default(null),
  discount_type: z.enum(['percent', 'amount'], 'Tipo de desconto inválido.').nullable().default(null),
  discount_value: z
    .number('Informe o valor do desconto.')
    .positive('O desconto precisa ser maior que zero.')
    .max(9_999_999, 'Desconto alto demais.')
    .transform((v) => Math.round(v * 100) / 100)
    .nullable()
    .default(null),
  items: z
    .array(itemSchema, 'Adicione pelo menos um produto.')
    .min(1, 'Adicione pelo menos um produto.')
    .max(300, 'Um pedido pode ter no máximo 300 itens.'),
})
  .superRefine((order, ctx) => {
    if (order.discount_type && order.discount_value === null) {
      ctx.addIssue({ code: 'custom', message: 'Informe o valor do desconto.', path: ['discount_value'] });
    }
    if (order.discount_type === 'percent' && order.discount_value !== null && order.discount_value > 100) {
      ctx.addIssue({ code: 'custom', message: 'O desconto não pode passar de 100%.', path: ['discount_value'] });
    }
  })
  // Sem tipo, o valor não vale nada: zera para o par ficar consistente no banco.
  .transform((order) => (order.discount_type ? order : { ...order, discount_value: null }));

const dateParam = z.preprocess(
  (v) => (v === '' ? undefined : v),
  z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'Data inválida.')
    .optional(),
);

const listSchema = z.object({
  status: z.preprocess((v) => (v === '' ? undefined : v), z.enum(['quote', 'order', 'cancelled']).optional()),
  from: dateParam,
  to: dateParam,
  q: optionalQuery,
  store_id: optionalQueryId,
  mine: z.enum(['true', 'false']).optional(),
  ...pagination,
});

const cancelSchema = z.object({
  reason: z.string('Informe o motivo.').trim().min(3, 'Informe o motivo.').max(300, 'Use no máximo 300 caracteres.'),
});

const moveSchema = z.object({
  direction: z.enum(['next', 'previous'], 'Direção inválida.'),
  expected_stage_id: z.number().int().positive(),
  note: optionalText(300),
});

const NOT_FOUND = 'Pedido não encontrado.';

/** Aviso ao cliente quando o pedido entra numa etapa com mensagem. Falhar não desfaz a mudança de etapa. */
type StageNotification = { status: 'sent' } | { status: 'failed'; error: string };

/** Pedido como a tela mostra: com a etapa do fluxo e o histórico. O PDF não precisa disso. */
async function loadOrderView(db: pg.PoolClient, id: number, user: AuthUser) {
  const order = await loadOrderDetail(db, id);
  if (!order) return null;
  return { ...order, workflow: await loadOrderWorkflow(db, id, user) };
}

/** WhatsApp do cliente pronto para a EvolutionAPI. Só números antigos ou importados precisam de ajuste. */
function clientNumber(order: OrderDetail) {
  return /^\d{8,15}$/.test(order.client_whatsapp) ? order.client_whatsapp : normalizeWhatsapp(order.client_whatsapp);
}

/** Admin escolhe a loja (padrão: a dele); vendedor sempre lança na própria loja. */
function resolveStoreId(user: AuthUser, requested: number | null | undefined): number {
  const storeId = user.role === 'admin' ? (requested ?? user.store_id) : user.store_id;
  if (!storeId) throw new HttpError(400, 'Selecione a loja do pedido.');
  return storeId;
}

async function assertExists(db: pg.PoolClient, table: 'clients' | 'stores', id: number, message: string) {
  const { rowCount } = await db.query(`select 1 from ${table} where id = $1`, [id]);
  if (!rowCount) throw new HttpError(400, message);
}

/**
 * Nome da forma de pagamento a gravar no pedido. Forma desativada só vale se o
 * orçamento já estava com ela (como produto desativado que já estava no carrinho).
 */
async function resolvePaymentMethod(db: pg.PoolClient, id: number | null, currentId: number | null = null) {
  if (id === null) return null;
  const { rows } = await db.query<{ name: string; active: boolean }>(
    'select name, active from payment_methods where id = $1',
    [id],
  );
  const method = rows[0];
  if (!method) throw new HttpError(400, 'Forma de pagamento não encontrada. Escolha de novo.');
  if (!method.active && id !== currentId) {
    throw new HttpError(400, `A forma de pagamento "${method.name}" está desativada. Escolha outra.`);
  }
  return method.name;
}

export function orderCaption(order: OrderDetail) {
  const firstName = order.client_name.trim().split(/\s+/)[0] ?? '';
  const label = documentLabel(order.status).toLowerCase();
  return [
    `Olá, ${firstName}! Segue em PDF o seu ${label} nº ${formatOrderNumber(order.id)}.`,
    `Total: ${formatMoney(order.total_amount)}`,
    order.store_name,
  ].join('\n');
}

/**
 * Todo acesso a pedidos passa por withSession, então o RLS do banco também
 * restringe o vendedor à própria loja. Pedido de outra loja responde 404.
 */
export function ordersRouter(ctx: AppContext) {
  const router = Router();
  const { pool, config } = ctx;

  async function notifyStageEntry(user: AuthUser, order: OrderDetail, stage: EnteredStage): Promise<StageNotification | null> {
    if (!stage.whatsapp_message) return null;
    const settings = await withSession(pool, user, (db) => loadEvolutionSettings(db, user.tenant_id));
    if (!settings) {
      return { status: 'failed', error: 'O WhatsApp da loja não está configurado, então o cliente não foi avisado.' };
    }
    const number = clientNumber(order);
    if (!number) return { status: 'failed', error: 'O WhatsApp do cliente é inválido, então ele não foi avisado.' };
    const text = renderStageMessage(stage.whatsapp_message, {
      clientName: order.client_name,
      orderId: order.id,
      storeName: order.store_name,
      stageName: stage.name,
    });
    try {
      await sendTextMessage(settings, { number, text }, config.evolutionTimeoutMs);
      return { status: 'sent' };
    } catch (err) {
      console.error(`Falha ao avisar o cliente do pedido ${order.id} pela EvolutionAPI:`, err);
      return { status: 'failed', error: describeEvolutionError(err, keySourceOf(settings, config.evolutionServer)) };
    }
  }

  router.get('/', async (req, res) => {
    const user = currentUser(req);
    const query = listSchema.parse(req.query);

    const where: string[] = [];
    const params: unknown[] = [];
    const param = (value: unknown) => {
      params.push(value);
      return `$${params.length}`;
    };

    if (user.role === 'seller') where.push(`o.store_id = ${param(user.store_id)}`);
    else if (query.store_id) where.push(`o.store_id = ${param(query.store_id)}`);
    if (query.mine === 'true') where.push(`o.user_id = ${param(user.id)}`);
    if (query.status) where.push(`o.status = ${param(query.status)}`);
    if (query.from) where.push(`o.created_at >= (${param(query.from)}::date)::timestamp at time zone ${param(config.timeZone)}`);
    if (query.to) where.push(`o.created_at < (${param(query.to)}::date + 1)::timestamp at time zone ${param(config.timeZone)}`);
    if (query.q) {
      const conditions = [`search_norm(c.name) like search_norm(${param(likePattern(query.q))})`];
      if (/^\d{1,12}$/.test(query.q)) conditions.push(`o.id = ${param(Number(query.q))}`);
      where.push(`(${conditions.join(' or ')})`);
    }

    const limit = param(query.page_size);
    const offset = param((query.page - 1) * query.page_size);
    const items = await withSession(pool, user, async (db) => {
      const { rows } = await db.query(
        `select o.id, o.status, o.cancelled_from, o.total_amount, o.created_at, o.confirmed_at, o.sent_at,
                o.store_id, s.name as store_name, o.user_id, u.name as user_name,
                o.client_id, c.name as client_name, o.stage_id, ws.name as stage_name,
                count(*) over () as total_count
           from orders o
           join clients c on c.id = o.client_id
           join stores s on s.id = o.store_id
           join users u on u.id = o.user_id
           left join workflow_stages ws on ws.id = o.stage_id
          ${where.length ? `where ${where.join(' and ')}` : ''}
          order by o.created_at desc, o.id desc
          limit ${limit} offset ${offset}`,
        params,
      );
      return rows;
    });

    res.json({
      items: items.map(({ total_count: _, ...row }) => row),
      total: items[0]?.total_count ?? 0,
      page: query.page,
      page_size: query.page_size,
    });
  });

  router.get('/:id', async (req, res) => {
    const id = parseId(req.params.id, NOT_FOUND);
    const user = currentUser(req);
    const order = await withSession(pool, user, (db) => loadOrderView(db, id, user));
    if (!order) throw new HttpError(404, NOT_FOUND);
    res.json({ order });
  });

  router.post('/', async (req, res) => {
    const user = currentUser(req);
    const body = orderSchema.parse(req.body);
    const storeId = resolveStoreId(user, body.store_id);

    const order = await withSession(pool, user, async (db) => {
      if (user.role === 'admin') await assertExists(db, 'stores', storeId, 'Loja não encontrada.');
      await assertExists(db, 'clients', body.client_id, 'Cliente não encontrado. Selecione o cliente de novo.');
      await assertClientSite(db, body.client_site_id, body.client_id);
      const paymentMethodName = await resolvePaymentMethod(db, body.payment_method_id);
      const { rows } = await db.query<{ id: number }>(
        `insert into orders (tenant_id, user_id, store_id, client_id, status, notes, payment_method_id, payment_method_name,
                             delivery_address, discount_type, discount_value, client_site_id, confirmed_at)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, case when $5 = 'order' then now() end)
         returning id`,
        [
          user.tenant_id,
          user.id,
          storeId,
          body.client_id,
          body.status,
          body.notes,
          body.payment_method_id,
          paymentMethodName,
          body.delivery_address,
          body.discount_type,
          body.discount_value,
          body.client_site_id,
        ],
      );
      const id = rows[0]!.id;
      await writeOrderItems(db, id, body.items);
      if (body.status === 'order') await onOrderConfirmed(db, id, user);
      return loadOrderView(db, id, user);
    });
    res.status(201).json({ order });
  });

  router.put('/:id', async (req, res) => {
    const user = currentUser(req);
    const id = parseId(req.params.id, NOT_FOUND);
    const body = orderSchema.parse(req.body);

    const order = await withSession(pool, user, async (db) => {
      const { rows } = await db.query<{
        status: string;
        store_id: number;
        payment_method_id: number | null;
        client_site_id: number | null;
      }>(
        'select status, store_id, payment_method_id, client_site_id from orders where id = $1 for update',
        [id],
      );
      const current = rows[0];
      if (!current) throw new HttpError(404, NOT_FOUND);
      if (current.status === 'order') throw new HttpError(409, 'Pedidos confirmados não podem ser editados.');
      if (current.status === 'cancelled') throw new HttpError(409, 'Documentos cancelados não podem ser editados.');

      const storeId = user.role === 'admin' && body.store_id ? body.store_id : current.store_id;
      if (storeId !== current.store_id) await assertExists(db, 'stores', storeId, 'Loja não encontrada.');
      await assertExists(db, 'clients', body.client_id, 'Cliente não encontrado. Selecione o cliente de novo.');
      await assertClientSite(db, body.client_site_id, body.client_id, current.client_site_id);
      const paymentMethodName = await resolvePaymentMethod(db, body.payment_method_id, current.payment_method_id);

      const previous = await db.query<{ product_id: number; unit_price: number }>(
        'select product_id, unit_price from order_items where order_id = $1',
        [id],
      );
      await db.query(
        `update orders
            set client_id = $2, status = $3, notes = $4, store_id = $5,
                payment_method_id = $6, payment_method_name = $7,
                delivery_address = $8, discount_type = $9, discount_value = $10, client_site_id = $11,
                confirmed_at = case when $3 = 'order' then now() end,
                updated_at = now()
          where id = $1`,
        [
          id,
          body.client_id,
          body.status,
          body.notes,
          storeId,
          body.payment_method_id,
          paymentMethodName,
          body.delivery_address,
          body.discount_type,
          body.discount_value,
          body.client_site_id,
        ],
      );
      await writeOrderItems(db, id, body.items, new Map(previous.rows.map((r) => [r.product_id, r.unit_price])));
      if (body.status === 'order') await onOrderConfirmed(db, id, user);
      return loadOrderView(db, id, user);
    });
    res.json({ order });
  });

  router.post('/:id/convert', async (req, res) => {
    const id = parseId(req.params.id, NOT_FOUND);
    const user = currentUser(req);
    const order = await withSession(pool, user, async (db) => {
      const { rowCount } = await db.query(
        `update orders set status = 'order', confirmed_at = now(), updated_at = now()
          where id = $1 and status = 'quote'`,
        [id],
      );
      if (!rowCount) {
        const { rows } = await db.query<{ status: string }>('select status from orders where id = $1', [id]);
        if (!rows[0]) throw new HttpError(404, NOT_FOUND);
        throw new HttpError(
          409,
          rows[0].status === 'cancelled' ? 'Orçamento perdido não pode ser convertido. Reabra-o antes.' : 'Este documento já é um pedido.',
        );
      }
      await onOrderConfirmed(db, id, user);
      return loadOrderView(db, id, user);
    });
    res.json({ order });
  });

  /** Cancela o pedido (só admin) ou marca o orçamento como perdido, com o motivo. */
  router.post('/:id/cancel', async (req, res) => {
    const user = currentUser(req);
    const id = parseId(req.params.id, NOT_FOUND);
    const { reason } = cancelSchema.parse(req.body);
    const order = await withSession(pool, user, async (db) => {
      await cancelOrder(db, id, user, reason);
      return loadOrderView(db, id, user);
    });
    res.json({ order });
  });

  router.post('/:id/reopen', async (req, res) => {
    const user = currentUser(req);
    const id = parseId(req.params.id, NOT_FOUND);
    const order = await withSession(pool, user, async (db) => {
      await reopenQuote(db, id);
      return loadOrderView(db, id, user);
    });
    res.json({ order });
  });

  /** Avança o pedido para a próxima etapa do fluxo ou devolve para a anterior. */
  router.post('/:id/stage', async (req, res) => {
    const user = currentUser(req);
    const id = parseId(req.params.id, NOT_FOUND);
    const body = moveSchema.parse(req.body);
    const { order, entered } = await withSession(pool, user, async (db) => {
      const entered = await moveOrderStage(db, id, user, body);
      return { order: (await loadOrderView(db, id, user))!, entered };
    });
    // Depois do commit: a mudança de etapa vale mesmo se o WhatsApp falhar.
    const notification = body.direction === 'next' ? await notifyStageEntry(user, order, entered) : null;
    res.json({ order, notification });
  });

  router.delete('/:id', requireAdmin, async (req, res) => {
    const id = parseId(req.params.id, NOT_FOUND);
    const { rowCount } = await withSession(pool, currentUser(req), (db) =>
      db.query('delete from orders where id = $1', [id]),
    );
    if (!rowCount) throw new HttpError(404, NOT_FOUND);
    res.status(204).end();
  });

  router.get('/:id/pdf', async (req, res) => {
    const id = parseId(req.params.id, NOT_FOUND);
    const order = await withSession(pool, currentUser(req), (db) => loadOrderDetail(db, id));
    if (!order) throw new HttpError(404, NOT_FOUND);
    const pdf = await renderOrderPdf(order, config.timeZone);
    const disposition = req.query.download === '1' ? 'attachment' : 'inline';
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `${disposition}; filename="${orderFileName(order)}"`);
    res.setHeader('Cache-Control', 'no-store');
    res.send(pdf);
  });

  router.post('/:id/whatsapp', async (req, res) => {
    const user = currentUser(req);
    const id = parseId(req.params.id, NOT_FOUND);
    const order = await withSession(pool, user, (db) => loadOrderDetail(db, id));
    if (!order) throw new HttpError(404, NOT_FOUND);
    if (order.status === 'cancelled') throw new HttpError(409, 'Documento cancelado não é enviado ao cliente.');

    const settings = await withSession(pool, user, (db) => loadEvolutionSettings(db, user.tenant_id));
    if (!settings) {
      throw new HttpError(
        422,
        'O envio por WhatsApp ainda não foi configurado. Peça ao administrador para conectar o WhatsApp em Configurações.',
        'WHATSAPP_NOT_CONFIGURED',
      );
    }
    const number = clientNumber(order);
    if (!number) {
      throw new HttpError(
        422,
        'O WhatsApp do cliente é inválido. Corrija o cadastro do cliente e tente de novo.',
        'WHATSAPP_INVALID_NUMBER',
      );
    }

    const pdf = await renderOrderPdf(order, config.timeZone);
    try {
      await sendPdfDocument(
        settings,
        { number, pdf, fileName: orderFileName(order), caption: orderCaption(order) },
        config.evolutionTimeoutMs,
      );
    } catch (err) {
      console.error(`Falha ao enviar o pedido ${id} pela EvolutionAPI:`, err);
      throw new HttpError(502, describeEvolutionError(err, keySourceOf(settings, config.evolutionServer)), 'WHATSAPP_FAILED');
    }

    const sentAt = await withSession(pool, user, async (db) => {
      const { rows } = await db.query<{ sent_at: Date }>(
        'update orders set sent_at = now() where id = $1 returning sent_at',
        [id],
      );
      return rows[0]?.sent_at ?? null;
    });
    res.json({ sent_at: sentAt });
  });

  return router;
}
