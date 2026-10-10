import { Router } from 'express';
import { z } from 'zod';
import { currentUser } from '../auth.js';
import type { AppContext } from '../context.js';
import { withSession } from '../db/session.js';
import { HttpError } from '../errors.js';
import { loadFiadoSettings } from '../fiado/queries.js';
import { loadFinanceSettings } from '../finance/queries.js';
import { parseId } from '../lib/validation.js';
import { clientCreditBalance, createReturn, loadReturnable } from '../returns/queries.js';

const returnSchema = z.object({
  items: z
    .array(
      z.object({
        order_item_id: z.number().int().positive(),
        quantity: z.number('Informe a quantidade.').min(0).max(999_999),
        restock: z.boolean().default(true),
      }),
    )
    .min(1, 'Informe o que volta.')
    .max(300),
  reason: z.string('Informe o motivo.').trim().min(3, 'Informe o motivo da devolução.').max(300),
  refund_method: z.enum(['cash', 'pix', 'card', 'credit', 'fiado', 'receivables', 'none'], 'Escolha como o valor volta para o cliente.'),
});

const ORDER_NOT_FOUND = 'Pedido não encontrado.';

/** Devolução e troca de pedido confirmado, e o crédito (vale-troca) do cliente. */
export function returnsRouter(ctx: AppContext) {
  const router = Router();
  const { pool } = ctx;

  /** O que já voltou, o que ainda pode voltar e as formas de devolver o valor que valem para o pedido. */
  router.get('/orders/:id/returns', async (req, res) => {
    const user = currentUser(req);
    const id = parseId(req.params.id, ORDER_NOT_FOUND);
    const data = await withSession(pool, user, async (db) => {
      const { rows: orders } = await db.query<{ status: string; client_id: number; payment_kind: string | null }>(
        `select o.status, o.client_id, pm.kind as payment_kind
           from orders o left join payment_methods pm on pm.id = o.payment_method_id
          where o.id = $1`,
        [id],
      );
      const order = orders[0];
      if (!order) throw new HttpError(404, ORDER_NOT_FOUND);
      const { rows: returns } = await db.query(
        `select r.id, r.reason, r.refund_method, r.amount, r.created_at, u.name as user_name,
                coalesce(json_agg(json_build_object(
                  'product_name', i.product_name, 'unit', i.unit, 'quantity', i.quantity, 'amount', i.amount, 'restock', i.restock
                ) order by i.id), '[]') as items
           from order_returns r
           join users u on u.id = r.user_id
           join order_return_items i on i.return_id = r.id
          where r.order_id = $1
          group by r.id, u.name
          order by r.created_at desc`,
        [id],
      );
      const finance = await loadFinanceSettings(db);
      const fiado = await loadFiadoSettings(db);
      const { rows: open } = await db.query<{ open: number }>(
        `select coalesce(sum(amount - paid_amount), 0) as open from receivables where order_id = $1 and status = 'open'`,
        [id],
      );
      const { rowCount: cashOpen } = await db.query('select 1 from cash_sessions where user_id = $1 and closed_at is null', [user.id]);
      return {
        status: order.status,
        items: order.status === 'order' ? await loadReturnable(db, id) : [],
        returns,
        client_credit: await clientCreditBalance(db, order.client_id),
        options: {
          finance: finance.enabled,
          cash_open: Boolean(cashOpen),
          fiado: fiado.enabled,
          payment_kind: order.payment_kind,
          open_receivables: open[0]?.open ?? 0,
        },
      };
    });
    res.json(data);
  });

  router.post('/orders/:id/returns', async (req, res) => {
    const user = currentUser(req);
    const id = parseId(req.params.id, ORDER_NOT_FOUND);
    const body = returnSchema.parse(req.body);
    const result = await withSession(pool, user, (db) => createReturn(db, user, id, body));
    res.status(201).json({ return: result });
  });

  /** Crédito do cliente (vale-troca): saldo e de onde veio cada valor. */
  router.get('/clients/:id/credits', async (req, res) => {
    const user = currentUser(req);
    const id = parseId(req.params.id, 'Cliente não encontrado.');
    const data = await withSession(pool, user, async (db) => {
      const { rows } = await db.query(
        `select c.id, c.amount, c.description, c.return_id, c.order_id, c.created_at, c.cancelled_at, u.name as user_name
           from client_credits c join users u on u.id = c.user_id
          where c.client_id = $1
          order by c.created_at desc, c.id desc
          limit 50`,
        [id],
      );
      return { balance: await clientCreditBalance(db, id), items: rows };
    });
    res.json(data);
  });

  return router;
}
