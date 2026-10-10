import { Router } from 'express';
import type pg from 'pg';
import { z } from 'zod';
import { currentUser, requireAdmin, type AuthUser } from '../auth.js';
import type { AppContext } from '../context.js';
import { queryAs, withSession } from '../db/session.js';
import { HttpError } from '../errors.js';
import { normalizePixKey, pixPayload, pixQrDataUrl } from '../finance/pix.js';
import {
  loadClientCredit,
  loadFinanceSettings,
  loadSession,
  receivePayment,
  reversePayment,
  sessionSummary,
  type CashSession,
} from '../finance/queries.js';
import { formatOrderNumber } from '../lib/format.js';
import { likePattern, optionalQuery, optionalQueryId, optionalText, pagination, parseId } from '../lib/validation.js';

const money = (label: string) =>
  z
    .number(`Informe ${label}.`)
    .min(0, `${label[0]!.toUpperCase()}${label.slice(1)} não pode ser negativo.`)
    .max(99_999_999)
    .transform((v) => Math.round(v * 100) / 100);

const positiveMoney = (label: string) =>
  money(label).refine((v) => v > 0, `${label[0]!.toUpperCase()}${label.slice(1)} precisa ser maior que zero.`);

const financeSettingsSchema = z
  .object({
    finance_enabled: z.boolean(),
    pix_key: optionalText(120),
    pix_merchant_name: optionalText(25),
    pix_city: optionalText(15),
  })
  .transform((s, ctx) => {
    if (s.pix_key === null) return s;
    const key = normalizePixKey(s.pix_key);
    if (!key) {
      ctx.addIssue({ code: 'custom', message: 'Chave PIX inválida. Use CPF, CNPJ, e-mail, telefone ou a chave aleatória.' });
      return z.NEVER;
    }
    if (!s.pix_merchant_name || !s.pix_city) {
      ctx.addIssue({ code: 'custom', message: 'Informe o nome e a cidade do recebedor, como aparecem no banco.' });
      return z.NEVER;
    }
    return { ...s, pix_key: key };
  });

const openSchema = z.object({
  store_id: z.number().int().positive().nullable().default(null),
  opening_amount: money('o troco inicial'),
});

const closeSchema = z.object({
  counted_amount: money('o dinheiro contado'),
  notes: optionalText(300),
});

const movementSchema = z.object({
  kind: z.enum(['withdrawal', 'deposit']),
  amount: positiveMoney('o valor'),
  reason: z.string('Informe o motivo.').trim().min(3, 'Informe o motivo.').max(200),
});

const paymentSchema = z.object({
  amount: positiveMoney('o valor'),
  payment_method_id: z.number('Escolha a forma de pagamento.').int().positive(),
});

const reverseSchema = z.object({
  reason: z.string('Informe o motivo.').trim().min(3, 'Informe o motivo.').max(200),
});

const listSchema = z.object({
  status: z.enum(['open', 'overdue', 'paid', 'cancelled', 'all']).default('open'),
  store_id: optionalQueryId,
  client_id: optionalQueryId,
  q: optionalQuery,
  ...pagination,
});

const sessionsSchema = z.object({ store_id: optionalQueryId, ...pagination });

const RECEIVABLE_COLUMNS = `r.id, r.store_id, s.name as store_name, r.order_id, r.client_id, c.name as client_name,
  c.whatsapp as client_whatsapp, r.installment, r.installments, r.due_date, r.amount, r.paid_amount,
  round(r.amount - r.paid_amount, 2) as remaining, r.status, r.payment_method_id, r.payment_method_name, r.kind,
  r.created_at, r.paid_at, r.cancelled_at, r.cancel_reason,
  (r.status = 'open' and r.due_date < (now() at time zone $tz)::date) as overdue`;

const RECEIVABLE_FROM = `receivables r join clients c on c.id = r.client_id join stores s on s.id = r.store_id`;

const withTz = (sql: string, tzParam: string) => sql.replaceAll('$tz', tzParam);

/** O vendedor trabalha na própria loja; o admin escolhe (ou vê todas). */
const storeFilter = (user: AuthUser, requested: number | undefined) => (user.role === 'admin' ? (requested ?? null) : user.store_id);

async function assertFinanceEnabled(db: pg.PoolClient) {
  if (!(await loadFinanceSettings(db)).enabled) {
    throw new HttpError(409, 'O financeiro está desligado. O administrador liga em Configurações → Financeiro.', 'FINANCE_DISABLED');
  }
}

async function sessionView(db: pg.PoolClient, session: CashSession) {
  // Parcelas e fiado (source diz qual estorno chamar).
  const payments = await db.query(
    `select * from (
       select 'receivable' as source, p.id, p.receivable_id, p.method_name, p.kind, p.amount, p.received_at, p.reversed_at,
              p.reverse_reason, r.order_id, r.installment, r.installments, c.name as client_name
         from receivable_payments p
         join receivables r on r.id = p.receivable_id
         join clients c on c.id = r.client_id
        where p.cash_session_id = $1
       union all
       select 'fiado', f.id, null, f.payment_method_name, f.payment_kind, -f.amount, f.created_at, f.cancelled_at,
              f.cancel_reason, null, null, null, c.name
         from fiado_entries f
         join clients c on c.id = f.client_id
        where f.cash_session_id = $1 and f.kind = 'payment'
     ) p
     order by received_at desc, id desc`,
    [session.id],
  );
  const movements = await db.query(
    `select m.id, m.kind, m.amount, m.reason, m.created_at, u.name as user_name
       from cash_movements m join users u on u.id = m.user_id
      where m.cash_session_id = $1
      order by m.created_at desc`,
    [session.id],
  );
  return { session, summary: await sessionSummary(db, session), payments: payments.rows, movements: movements.rows };
}

/** Contas a receber, caixa e PIX. Tudo depende do financeiro ligado na lojamestre. */
export function financeRouter(ctx: AppContext) {
  const router = Router();
  const { pool, config } = ctx;

  // ---- Configuração

  router.get('/finance/settings', requireAdmin, async (req, res) => {
    const { rows } = await queryAs(
      pool,
      currentUser(req),
      'select finance_enabled, pix_key, pix_merchant_name, pix_city from settings limit 1',
    );
    res.json({ settings: rows[0] ?? { finance_enabled: false, pix_key: null, pix_merchant_name: null, pix_city: null } });
  });

  router.put('/finance/settings', requireAdmin, async (req, res) => {
    const me = currentUser(req);
    const body = financeSettingsSchema.parse(req.body);
    const { rows } = await queryAs(
      pool,
      me,
      `insert into settings (tenant_id, finance_enabled, pix_key, pix_merchant_name, pix_city)
       values ($1, $2, $3, $4, $5)
       on conflict (tenant_id) do update
          set finance_enabled = excluded.finance_enabled, pix_key = excluded.pix_key,
              pix_merchant_name = excluded.pix_merchant_name, pix_city = excluded.pix_city, updated_at = now()
       returning finance_enabled, pix_key, pix_merchant_name, pix_city`,
      [me.tenant_id, body.finance_enabled, body.pix_key, body.pix_merchant_name, body.pix_city],
    );
    res.json({ settings: rows[0] });
  });

  // ---- Caixa

  router.get('/cash/current', async (req, res) => {
    const user = currentUser(req);
    const data = await withSession(pool, user, async (db) => {
      const session = await loadSession(db, 'cs.user_id = $1 and cs.closed_at is null', [user.id]);
      return session ? sessionView(db, session) : null;
    });
    res.json({ current: data });
  });

  router.post('/cash/open', async (req, res) => {
    const user = currentUser(req);
    const body = openSchema.parse(req.body);
    const data = await withSession(pool, user, async (db) => {
      await assertFinanceEnabled(db);
      const storeId = user.role === 'admin' ? (body.store_id ?? user.store_id) : user.store_id;
      if (!storeId) throw new HttpError(400, 'Escolha a loja do caixa.');
      const store = await db.query('select 1 from stores where id = $1', [storeId]);
      if (!store.rowCount) throw new HttpError(400, 'Loja não encontrada.');
      const open = await db.query('select 1 from cash_sessions where user_id = $1 and closed_at is null', [user.id]);
      if (open.rowCount) throw new HttpError(409, 'Você já tem um caixa aberto.');
      const { rows } = await db.query<{ id: number }>(
        'insert into cash_sessions (tenant_id, store_id, user_id, opening_amount) values ($1, $2, $3, $4) returning id',
        [user.tenant_id, storeId, user.id, body.opening_amount],
      );
      return sessionView(db, (await loadSession(db, 'cs.id = $1', [rows[0]!.id]))!);
    });
    res.status(201).json({ current: data });
  });

  router.post('/cash/movements', async (req, res) => {
    const user = currentUser(req);
    const body = movementSchema.parse(req.body);
    const data = await withSession(pool, user, async (db) => {
      const session = await loadSession(db, 'cs.user_id = $1 and cs.closed_at is null', [user.id]);
      if (!session) throw new HttpError(409, 'Abra o caixa primeiro.', 'CASH_CLOSED');
      if (body.kind === 'withdrawal') {
        const { expected_cash } = await sessionSummary(db, session);
        if (body.amount > expected_cash + 0.005) {
          throw new HttpError(409, 'A sangria é maior que o dinheiro que deveria estar na gaveta.');
        }
      }
      await db.query(
        'insert into cash_movements (tenant_id, cash_session_id, kind, amount, reason, user_id) values ($1, $2, $3, $4, $5, $6)',
        [user.tenant_id, session.id, body.kind, body.amount, body.reason, user.id],
      );
      return sessionView(db, session);
    });
    res.status(201).json({ current: data });
  });

  /** Fecha o caixa com o dinheiro contado; a diferença para o esperado fica registrada. */
  router.post('/cash/close', async (req, res) => {
    const user = currentUser(req);
    const body = closeSchema.parse(req.body);
    const data = await withSession(pool, user, async (db) => {
      const { rows } = await db.query<{ id: number }>(
        'select id from cash_sessions where user_id = $1 and closed_at is null for update',
        [user.id],
      );
      if (!rows[0]) throw new HttpError(409, 'Você não tem caixa aberto.', 'CASH_CLOSED');
      await db.query(
        'update cash_sessions set closed_at = now(), closed_by = $2, counted_amount = $3, closing_notes = $4 where id = $1',
        [rows[0].id, user.id, body.counted_amount, body.notes],
      );
      return sessionView(db, (await loadSession(db, 'cs.id = $1', [rows[0].id]))!);
    });
    res.json({ closed: data });
  });

  router.get('/cash/sessions', async (req, res) => {
    const user = currentUser(req);
    const query = sessionsSchema.parse(req.query);
    const storeId = storeFilter(user, query.store_id);
    const data = await withSession(pool, user, async (db) => {
      const { rows } = await db.query<CashSession & { total_count: number }>(
        `select cs.id, cs.store_id, s.name as store_name, cs.user_id, u.name as user_name, cs.opened_at,
                cs.opening_amount, cs.closed_at, cs.counted_amount, cs.closing_notes, count(*) over () as total_count
           from cash_sessions cs join stores s on s.id = cs.store_id join users u on u.id = cs.user_id
          where ($1::bigint is null or cs.store_id = $1)
            and ($2::bigint is null or cs.user_id = $2)
          order by cs.opened_at desc
          limit $3 offset $4`,
        // Vendedor vê os próprios caixas; o admin, todos.
        [storeId, user.role === 'admin' ? null : user.id, query.page_size, (query.page - 1) * query.page_size],
      );
      const items = [];
      for (const { total_count: _, ...session } of rows) items.push({ ...session, summary: await sessionSummary(db, session) });
      return { items, total: rows[0]?.total_count ?? 0 };
    });
    res.json({ ...data, page: query.page, page_size: query.page_size });
  });

  router.get('/cash/sessions/:id', async (req, res) => {
    const user = currentUser(req);
    const id = parseId(req.params.id, 'Caixa não encontrado.');
    const data = await withSession(pool, user, async (db) => {
      const session = await loadSession(db, 'cs.id = $1', [id]);
      if (!session || (user.role !== 'admin' && session.user_id !== user.id)) throw new HttpError(404, 'Caixa não encontrado.');
      return sessionView(db, session);
    });
    res.json(data);
  });

  // ---- Contas a receber

  router.get('/receivables', async (req, res) => {
    const user = currentUser(req);
    const query = listSchema.parse(req.query);
    const params: unknown[] = [];
    const param = (value: unknown) => {
      params.push(value);
      return `$${params.length}`;
    };
    const tz = param(config.timeZone);
    const where: string[] = [];
    const storeId = storeFilter(user, query.store_id);
    if (storeId) where.push(`r.store_id = ${param(storeId)}`);
    if (query.client_id) where.push(`r.client_id = ${param(query.client_id)}`);
    if (query.status === 'overdue') where.push(`r.status = 'open' and r.due_date < (now() at time zone ${tz})::date`);
    else if (query.status !== 'all') where.push(`r.status = ${param(query.status)}`);
    if (query.q) {
      const conditions = [`search_norm(c.name) like search_norm(${param(likePattern(query.q))})`];
      if (/^\d{1,12}$/.test(query.q)) conditions.push(`r.order_id = ${param(Number(query.q))}`);
      where.push(`(${conditions.join(' or ')})`);
    }
    const whereSql = where.length ? `where ${where.join(' and ')}` : '';
    const data = await withSession(pool, user, async (db) => {
      const { rows } = await db.query(
        `select ${withTz(RECEIVABLE_COLUMNS, tz)}, count(*) over () as total_count
           from ${RECEIVABLE_FROM}
           ${whereSql}
          order by case when r.status = 'open' then 0 else 1 end, r.due_date, r.id
          limit ${param(query.page_size)} offset ${param((query.page - 1) * query.page_size)}`,
        params,
      );
      const totals = await db.query(
        `select coalesce(sum(r.amount), 0) as amount, coalesce(sum(r.paid_amount), 0) as paid_amount,
                coalesce(sum(r.amount - r.paid_amount) filter (where r.status = 'open'), 0) as remaining,
                coalesce(sum(r.amount - r.paid_amount)
                  filter (where r.status = 'open' and r.due_date < (now() at time zone ${tz})::date), 0) as overdue
           from ${RECEIVABLE_FROM} ${whereSql}`,
        params.slice(0, params.length - 2),
      );
      return { rows, totals: totals.rows[0] };
    });
    res.json({
      items: data.rows.map(({ total_count: _, ...row }) => row),
      total: data.rows[0]?.total_count ?? 0,
      totals: data.totals,
      page: query.page,
      page_size: query.page_size,
    });
  });

  router.get('/orders/:id/receivables', async (req, res) => {
    const user = currentUser(req);
    const orderId = parseId(req.params.id, 'Pedido não encontrado.');
    const data = await withSession(pool, user, async (db) => {
      const visible = await db.query('select 1 from orders where id = $1', [orderId]);
      if (!visible.rowCount) throw new HttpError(404, 'Pedido não encontrado.');
      const { rows } = await db.query(
        `select ${withTz(RECEIVABLE_COLUMNS, '$2')} from ${RECEIVABLE_FROM} where r.order_id = $1 order by r.installment, r.id`,
        [orderId, config.timeZone],
      );
      const payments = await db.query(
        `select p.id, p.receivable_id, p.method_name, p.amount, p.received_at, p.reversed_at, p.reverse_reason, u.name as user_name,
                (cs.closed_at is null) as session_open
           from receivable_payments p
           join receivables r on r.id = p.receivable_id
           join users u on u.id = p.user_id
           join cash_sessions cs on cs.id = p.cash_session_id
          where r.order_id = $1
          order by p.received_at`,
        [orderId],
      );
      return { items: rows, payments: payments.rows };
    });
    res.json(data);
  });

  router.post('/receivables/:id/payments', async (req, res) => {
    const user = currentUser(req);
    const id = parseId(req.params.id, 'Parcela não encontrada.');
    const body = paymentSchema.parse(req.body);
    const data = await withSession(pool, user, async (db) => {
      await receivePayment(db, id, user, body);
      const { rows } = await db.query(`select ${withTz(RECEIVABLE_COLUMNS, '$2')} from ${RECEIVABLE_FROM} where r.id = $1`, [
        id,
        config.timeZone,
      ]);
      return rows[0];
    });
    res.status(201).json({ receivable: data });
  });

  router.post('/receivable-payments/:id/reverse', async (req, res) => {
    const user = currentUser(req);
    const id = parseId(req.params.id, 'Recebimento não encontrado.');
    const { reason } = reverseSchema.parse(req.body);
    await withSession(pool, user, (db) => reversePayment(db, id, user, reason));
    res.status(204).end();
  });

  /** PIX "copia e cola" e QR Code do que falta receber da parcela. */
  router.get('/receivables/:id/pix', async (req, res) => {
    const user = currentUser(req);
    const id = parseId(req.params.id, 'Parcela não encontrada.');
    const charge = await withSession(pool, user, async (db) => {
      const { pix } = await loadFinanceSettings(db);
      if (!pix) throw new HttpError(409, 'A chave PIX da loja não está configurada (Configurações → Financeiro).', 'PIX_NOT_CONFIGURED');
      const { rows } = await db.query<{ order_id: number | null; installment: number; remaining: number; status: string }>(
        'select order_id, installment, round(amount - paid_amount, 2) as remaining, status from receivables where id = $1',
        [id],
      );
      const r = rows[0];
      if (!r) throw new HttpError(404, 'Parcela não encontrada.');
      if (r.status !== 'open') throw new HttpError(409, 'Esta parcela não está em aberto.');
      return { ...pix, amount: r.remaining, txid: r.order_id ? `PED${formatOrderNumber(r.order_id)}P${r.installment}` : `PARC${id}` };
    });
    const payload = pixPayload(charge);
    res.json({ amount: charge.amount, payload, qr: await pixQrDataUrl(payload) });
  });

  /** Crédito do cliente: limite, em aberto e vencido (todas as lojas). */
  router.get('/clients/:id/credit', async (req, res) => {
    const user = currentUser(req);
    const id = parseId(req.params.id, 'Cliente não encontrado.');
    const data = await withSession(pool, user, async (db) => {
      const { rows } = await db.query<{ credit_limit: number | null }>('select credit_limit from clients where id = $1', [id]);
      if (!rows[0]) throw new HttpError(404, 'Cliente não encontrado.');
      const credit = await loadClientCredit(db, id, config.timeZone);
      const limit = rows[0].credit_limit;
      return {
        credit_limit: limit,
        ...credit,
        available: limit === null ? null : Math.max(0, Math.round((limit - credit.open_balance - credit.fiado_balance) * 100) / 100),
      };
    });
    res.json({ credit: data });
  });

  return router;
}
