import { Router } from 'express';
import type pg from 'pg';
import { z } from 'zod';
import { currentUser, requireAdmin } from '../auth.js';
import type { AppContext } from '../context.js';
import { withSession } from '../db/session.js';
import { HttpError } from '../errors.js';
import { loadFinanceSettings } from '../finance/queries.js';
import { likePattern, optionalQuery, optionalQueryId, optionalText, pagination, parseId } from '../lib/validation.js';
import { createPayables, payPayable, reversePayablePayment } from '../purchases/queries.js';

const money = z
  .number('Informe o valor.')
  .positive('O valor precisa ser maior que zero.')
  .max(999_999_999)
  .transform((v) => Math.round(v * 100) / 100);

const createSchema = z.object({
  store_id: z.number('Escolha a loja.').int().positive(),
  supplier_id: z.number().int().positive().nullable().default(null),
  description: z.string('Informe a descrição.').trim().min(2, 'Informe a descrição.').max(160),
  category: optionalText(60),
  document_number: optionalText(30),
  installments: z
    .array(z.object({ due_date: z.iso.date('Informe o vencimento.'), amount: money }))
    .min(1, 'Informe pelo menos um vencimento.')
    .max(60),
});

const updateSchema = z.object({
  description: z.string('Informe a descrição.').trim().min(2, 'Informe a descrição.').max(160),
  category: optionalText(60),
  document_number: optionalText(30),
  supplier_id: z.number().int().positive().nullable().default(null),
  due_date: z.iso.date('Informe o vencimento.'),
  amount: money,
});

const listSchema = z.object({
  status: z.enum(['open', 'overdue', 'paid', 'cancelled', 'all']).default('open'),
  supplier_id: optionalQueryId,
  store_id: optionalQueryId,
  q: optionalQuery,
  from: z.preprocess((v) => (v === '' ? undefined : v), z.iso.date().optional()),
  to: z.preprocess((v) => (v === '' ? undefined : v), z.iso.date().optional()),
  ...pagination,
});

const paymentSchema = z.object({
  amount: money,
  paid_on: z.iso.date('Informe a data do pagamento.'),
  method: z.enum(['cash', 'bank', 'pix', 'boleto', 'card', 'other'], 'Escolha como foi pago.'),
  note: optionalText(200),
});

const reasonSchema = z.object({ reason: z.string('Informe o motivo.').trim().min(3, 'Informe o motivo.').max(200) });

const NOT_FOUND = 'Conta não encontrada.';

const COLUMNS = `p.id, p.store_id, s.name as store_name, p.supplier_id, sp.name as supplier_name, p.description, p.category,
  p.document_number, p.installment, p.installments, p.due_date, p.amount, p.paid_amount, round(p.amount - p.paid_amount, 2) as remaining,
  p.status, p.entry_id, p.purchase_order_id, p.created_at, p.paid_at, p.cancelled_at, p.cancel_reason,
  (p.status = 'open' and p.due_date < (now() at time zone $tz)::date) as overdue`;

const FROM = 'payables p join stores s on s.id = p.store_id left join suppliers sp on sp.id = p.supplier_id';

async function assertFinanceEnabled(db: pg.PoolClient) {
  if (!(await loadFinanceSettings(db)).enabled) {
    throw new HttpError(409, 'O financeiro está desligado. O administrador liga em Configurações → Financeiro.', 'FINANCE_DISABLED');
  }
}

async function assertRefs(db: pg.PoolClient, storeId: number | null, supplierId: number | null) {
  if (storeId) {
    const { rowCount } = await db.query('select 1 from stores where id = $1', [storeId]);
    if (!rowCount) throw new HttpError(400, 'Loja não encontrada.');
  }
  if (supplierId) {
    const { rowCount } = await db.query('select 1 from suppliers where id = $1', [supplierId]);
    if (!rowCount) throw new HttpError(400, 'Fornecedor não encontrado.');
  }
}

/** Contas a pagar: lançadas à mão ou pelas duplicatas da nota de compra. Do administrador, com o financeiro ligado. */
export function payablesRouter(ctx: AppContext) {
  const router = Router();
  const { pool, config } = ctx;
  router.use(['/payables', '/payable-payments'], requireAdmin);

  router.get('/payables', async (req, res) => {
    const user = currentUser(req);
    const query = listSchema.parse(req.query);
    const params: unknown[] = [];
    const param = (value: unknown) => {
      params.push(value);
      return `$${params.length}`;
    };
    const tz = param(config.timeZone);
    const where: string[] = [];
    if (query.store_id) where.push(`p.store_id = ${param(query.store_id)}`);
    if (query.supplier_id) where.push(`p.supplier_id = ${param(query.supplier_id)}`);
    if (query.status === 'overdue') where.push(`p.status = 'open' and p.due_date < (now() at time zone ${tz})::date`);
    else if (query.status !== 'all') where.push(`p.status = ${param(query.status)}`);
    if (query.from) where.push(`p.due_date >= ${param(query.from)}`);
    if (query.to) where.push(`p.due_date <= ${param(query.to)}`);
    if (query.q) {
      const pattern = param(likePattern(query.q));
      where.push(
        `(search_norm(p.description) like search_norm(${pattern}) or search_norm(coalesce(sp.name, '')) like search_norm(${pattern})
          or search_norm(coalesce(p.category, '')) like search_norm(${pattern}) or coalesce(p.document_number, '') like ${pattern})`,
      );
    }
    const whereSql = where.length ? `where ${where.join(' and ')}` : '';
    const data = await withSession(pool, user, async (db) => {
      await assertFinanceEnabled(db);
      const { rows } = await db.query(
        `select ${COLUMNS.replaceAll('$tz', tz)}, count(*) over () as total_count
           from ${FROM} ${whereSql}
          order by case when p.status = 'open' then 0 else 1 end, p.due_date, p.id
          limit ${param(query.page_size)} offset ${param((query.page - 1) * query.page_size)}`,
        params,
      );
      // Resumo de tudo que está em aberto (não depende do filtro): vencido, hoje, 7 dias e 30 dias.
      const summary = await db.query(
        `with today as (select (now() at time zone $1)::date as d)
         select coalesce(sum(amount - paid_amount) filter (where due_date < d), 0) as overdue,
                coalesce(sum(amount - paid_amount) filter (where due_date = d), 0) as today,
                coalesce(sum(amount - paid_amount) filter (where due_date > d and due_date <= d + 7), 0) as next_7_days,
                coalesce(sum(amount - paid_amount) filter (where due_date > d and due_date <= d + 30), 0) as next_30_days,
                coalesce(sum(amount - paid_amount), 0) as open_total
           from payables, today
          where status = 'open'`,
        [config.timeZone],
      );
      return { rows, summary: summary.rows[0] };
    });
    res.json({
      items: data.rows.map(({ total_count: _, ...row }) => row),
      total: data.rows[0]?.total_count ?? 0,
      summary: data.summary,
      page: query.page,
      page_size: query.page_size,
    });
  });

  router.get('/payables/:id', async (req, res) => {
    const user = currentUser(req);
    const id = parseId(req.params.id, NOT_FOUND);
    const data = await withSession(pool, user, async (db) => {
      const { rows } = await db.query(`select ${COLUMNS.replaceAll('$tz', '$2')} from ${FROM} where p.id = $1`, [id, config.timeZone]);
      if (!rows[0]) throw new HttpError(404, NOT_FOUND);
      const payments = await db.query(
        `select pp.id, pp.amount, pp.paid_on, pp.method, pp.note, pp.created_at, pp.reversed_at, pp.reverse_reason,
                u.name as user_name, pp.cash_session_id, (cs.closed_at is not null) as session_closed
           from payable_payments pp
           join users u on u.id = pp.user_id
           left join cash_sessions cs on cs.id = pp.cash_session_id
          where pp.payable_id = $1
          order by pp.created_at`,
        [id],
      );
      return { payable: rows[0], payments: payments.rows };
    });
    res.json(data);
  });

  router.post('/payables', async (req, res) => {
    const user = currentUser(req);
    const body = createSchema.parse(req.body);
    const ids = await withSession(pool, user, async (db) => {
      await assertFinanceEnabled(db);
      await assertRefs(db, body.store_id, body.supplier_id);
      return createPayables(db, user, body);
    });
    res.status(201).json({ ids });
  });

  /** Corrige a conta enquanto nada foi pago. */
  router.put('/payables/:id', async (req, res) => {
    const user = currentUser(req);
    const id = parseId(req.params.id, NOT_FOUND);
    const body = updateSchema.parse(req.body);
    await withSession(pool, user, async (db) => {
      const { rows } = await db.query<{ status: string; paid_amount: number }>(
        'select status, paid_amount from payables where id = $1 for update',
        [id],
      );
      if (!rows[0]) throw new HttpError(404, NOT_FOUND);
      if (rows[0].status !== 'open' || rows[0].paid_amount > 0) {
        throw new HttpError(409, 'Conta com pagamento (ou cancelada) não muda. Estorne o pagamento antes.');
      }
      await assertRefs(db, null, body.supplier_id);
      await db.query(
        `update payables set description = $2, category = $3, document_number = $4, supplier_id = $5, due_date = $6, amount = $7
          where id = $1`,
        [id, body.description, body.category, body.document_number, body.supplier_id, body.due_date, body.amount],
      );
    });
    res.status(204).end();
  });

  router.post('/payables/:id/payments', async (req, res) => {
    const user = currentUser(req);
    const id = parseId(req.params.id, NOT_FOUND);
    const body = paymentSchema.parse(req.body);
    await withSession(pool, user, async (db) => {
      await assertFinanceEnabled(db);
      await payPayable(db, id, user, body);
    });
    res.status(201).json({ ok: true });
  });

  router.post('/payable-payments/:id/reverse', async (req, res) => {
    const user = currentUser(req);
    const id = parseId(req.params.id, 'Pagamento não encontrado.');
    const { reason } = reasonSchema.parse(req.body);
    await withSession(pool, user, (db) => reversePayablePayment(db, id, user, reason));
    res.status(204).end();
  });

  router.post('/payables/:id/cancel', async (req, res) => {
    const user = currentUser(req);
    const id = parseId(req.params.id, NOT_FOUND);
    const { reason } = reasonSchema.parse(req.body);
    await withSession(pool, user, async (db) => {
      const { rows } = await db.query<{ status: string; paid_amount: number }>(
        'select status, paid_amount from payables where id = $1 for update',
        [id],
      );
      if (!rows[0]) throw new HttpError(404, NOT_FOUND);
      if (rows[0].status === 'cancelled') throw new HttpError(409, 'Esta conta já foi cancelada.');
      if (rows[0].paid_amount > 0) throw new HttpError(409, 'Esta conta tem pagamento. Estorne o pagamento antes de cancelar.');
      await db.query(
        `update payables set status = 'cancelled', cancelled_at = now(), cancelled_by = $2, cancel_reason = $3 where id = $1`,
        [id, user.id, reason],
      );
    });
    res.status(204).end();
  });

  return router;
}
