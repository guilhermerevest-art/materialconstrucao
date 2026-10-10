import type pg from 'pg';
import type { SessionUser } from '../db/session.js';
import { HttpError } from '../errors.js';
import { formatMoney } from '../lib/format.js';
import { normalizePixKey } from './pix.js';

export type FinanceSettings = {
  enabled: boolean;
  pix: { key: string; merchantName: string; merchantCity: string } | null;
};

/** Financeiro ligado na lojamestre e o PIX da loja (se configurado). Precisa do contexto da lojamestre. */
export async function loadFinanceSettings(db: pg.PoolClient): Promise<FinanceSettings> {
  const { rows } = await db.query<{
    finance_enabled: boolean;
    pix_key: string | null;
    pix_merchant_name: string | null;
    pix_city: string | null;
  }>('select finance_enabled, pix_key, pix_merchant_name, pix_city from settings limit 1');
  const s = rows[0];
  const key = s?.pix_key ? normalizePixKey(s.pix_key) : null;
  return {
    enabled: Boolean(s?.finance_enabled),
    pix: key && s?.pix_merchant_name && s.pix_city ? { key, merchantName: s.pix_merchant_name, merchantCity: s.pix_city } : null,
  };
}

/** Divide o valor em parcelas de centavos inteiros; a diferença do arredondamento vai na primeira. */
export function splitInstallments(total: number, count: number): number[] {
  const cents = Math.round(total * 100);
  const base = Math.floor(cents / count);
  const parts = Array.from({ length: count }, () => base);
  parts[0]! += cents - base * count;
  return parts.map((c) => c / 100);
}

const formatDate = (iso: string) => {
  const [y, m, d] = iso.slice(0, 10).split('-');
  return `${d}/${m}/${y}`;
};

type OrderCredit = {
  client_id: number;
  client_name: string;
  total_amount: number;
  kind: string | null;
  credit_limit: number | null;
};

/** O que o cliente deve: em aberto, vencido e a parcela vencida mais antiga, em todas as lojas. */
export async function loadClientCredit(db: pg.PoolClient, clientId: number, timeZone: string) {
  const { rows } = await db.query<{ open_balance: number; overdue_amount: number; oldest_overdue: string | null; fiado_balance: number }>(
    `select coalesce(sum(amount - paid_amount), 0) as open_balance,
            coalesce(sum(amount - paid_amount) filter (where due_date < (now() at time zone $2)::date), 0) as overdue_amount,
            min(due_date) filter (where due_date < (now() at time zone $2)::date) as oldest_overdue,
            -- O limite vale para crediário e fiado juntos.
            greatest(0, (select coalesce(sum(f.amount), 0) from fiado_entries f where f.client_id = $1 and f.cancelled_at is null))
              as fiado_balance
       from receivables
      where client_id = $1 and status = 'open'`,
    [clientId, timeZone],
  );
  return rows[0]!;
}

/**
 * Venda no crediário: o cliente precisa ter limite, não pode ter parcela vencida e o
 * pedido tem que caber no que sobra do limite. Só vale com o financeiro ligado.
 */
export async function assertStoreCredit(db: pg.PoolClient, orderId: number, timeZone: string) {
  const { rows } = await db.query<OrderCredit>(
    `select o.client_id, c.name as client_name, o.total_amount - o.credit_used as total_amount, pm.kind, c.credit_limit
       from orders o
       join clients c on c.id = o.client_id
       left join payment_methods pm on pm.id = o.payment_method_id
      where o.id = $1`,
    [orderId],
  );
  const order = rows[0];
  if (!order || order.kind !== 'store_credit') return;
  if (order.credit_limit === null) {
    throw new HttpError(
      409,
      `${order.client_name} não tem crediário aprovado. O administrador define o limite em Clientes → Crédito.`,
      'CREDIT_NOT_APPROVED',
    );
  }
  const credit = await loadClientCredit(db, order.client_id, timeZone);
  if (credit.oldest_overdue) {
    throw new HttpError(
      409,
      `${order.client_name} tem parcela vencida desde ${formatDate(credit.oldest_overdue)} (${formatMoney(credit.overdue_amount)}). Receba antes de vender no crediário.`,
      'CREDIT_OVERDUE',
    );
  }
  const debt = credit.open_balance + credit.fiado_balance;
  const available = Math.round((order.credit_limit - debt) * 100) / 100;
  if (order.total_amount > available + 0.005) {
    throw new HttpError(
      409,
      `O pedido de ${formatMoney(order.total_amount)} passa do crédito de ${order.client_name}: limite ${formatMoney(order.credit_limit)}, em aberto ${formatMoney(debt)}, disponível ${formatMoney(Math.max(0, available))}.`,
      'CREDIT_LIMIT',
    );
  }
}

type OrderTerms = {
  tenant_id: number;
  store_id: number;
  client_id: number;
  total_amount: number;
  payment_method_id: number | null;
  payment_method_name: string | null;
  kind: string | null;
  installments: number | null;
  first_due_days: number | null;
  interval_days: number | null;
};

/**
 * Parcelas do pedido confirmado, pela condição da forma de pagamento (à vista = uma
 * parcela vencendo no dia). Sem forma escolhida, uma parcela no dia.
 */
export async function createOrderReceivables(db: pg.PoolClient, orderId: number, timeZone: string) {
  const { rows } = await db.query<OrderTerms>(
    `select o.tenant_id, o.store_id, o.client_id, o.total_amount - o.credit_used as total_amount, o.payment_method_id, o.payment_method_name,
            pm.kind, pm.installments, pm.first_due_days, pm.interval_days
       from orders o
       left join payment_methods pm on pm.id = o.payment_method_id
      where o.id = $1`,
    [orderId],
  );
  const order = rows[0];
  // Fiado tem a conta própria (caderneta), não vira parcela.
  if (!order || order.total_amount <= 0 || order.kind === 'fiado') return;
  const count = order.installments ?? 1;
  const first = order.first_due_days ?? 0;
  const interval = order.interval_days ?? 30;
  const amounts = splitInstallments(order.total_amount, count);
  await db.query(
    `insert into receivables (tenant_id, store_id, order_id, client_id, installment, installments, due_date, amount,
                              payment_method_id, payment_method_name, kind)
     select $1, $2, $3, $4, p.n, $5, (now() at time zone $6)::date + $7::int + (p.n::int - 1) * $8::int, p.amount, $9, $10, $11
       from unnest($12::numeric[]) with ordinality as p(amount, n)`,
    [
      order.tenant_id,
      order.store_id,
      orderId,
      order.client_id,
      count,
      timeZone,
      first,
      interval,
      order.payment_method_id,
      order.payment_method_name,
      order.kind ?? 'other',
      amounts,
    ],
  );
}

/** Cancelamento do pedido: com recebimento feito, só depois de estornar; o que está em aberto é cancelado. */
export async function cancelOrderReceivables(db: pg.PoolClient, orderId: number, reason: string) {
  const { rows } = await db.query<{ paid: number }>(
    `select count(*) as paid
       from receivable_payments p join receivables r on r.id = p.receivable_id
      where r.order_id = $1 and p.reversed_at is null`,
    [orderId],
  );
  if (rows[0]!.paid > 0) {
    throw new HttpError(409, 'Este pedido tem recebimento registrado. Estorne os recebimentos no caixa antes de cancelar.');
  }
  await db.query(
    `update receivables set status = 'cancelled', cancelled_at = now(), cancel_reason = $2
      where order_id = $1 and status = 'open'`,
    [orderId, reason],
  );
}

export type CashSession = {
  id: number;
  store_id: number;
  store_name: string;
  user_id: number;
  user_name: string;
  opened_at: Date;
  opening_amount: number;
  closed_at: Date | null;
  counted_amount: number | null;
  closing_notes: string | null;
};

const SESSION_COLUMNS = `cs.id, cs.store_id, s.name as store_name, cs.user_id, u.name as user_name, cs.opened_at,
  cs.opening_amount, cs.closed_at, cs.counted_amount, cs.closing_notes`;

export async function loadSession(db: pg.PoolClient, where: string, params: unknown[]): Promise<CashSession | null> {
  const { rows } = await db.query<CashSession>(
    `select ${SESSION_COLUMNS}
       from cash_sessions cs join stores s on s.id = cs.store_id join users u on u.id = cs.user_id
      where ${where}`,
    params,
  );
  return rows[0] ?? null;
}

/** Caixa aberto do operador, travado para o recebimento não cair num caixa que está fechando. */
export async function lockOpenSession(db: pg.PoolClient, userId: number) {
  const { rows } = await db.query<{ id: number; store_id: number }>(
    'select id, store_id from cash_sessions where user_id = $1 and closed_at is null for update',
    [userId],
  );
  if (!rows[0]) throw new HttpError(409, 'Abra o caixa para receber.', 'CASH_CLOSED');
  return rows[0];
}

/** Totais do caixa: por forma de pagamento, sangrias, suprimentos e o dinheiro que deve estar na gaveta. */
export async function sessionSummary(db: pg.PoolClient, session: CashSession) {
  // Parcelas e fiado recebidos neste caixa.
  const methods = await db.query<{ method_name: string; kind: string; amount: number; count: number }>(
    `select method_name, kind, sum(amount) as amount, count(*)::int as count
       from (
         select method_name, kind, amount from receivable_payments where cash_session_id = $1 and reversed_at is null
         union all
         select payment_method_name, payment_kind, -amount from fiado_entries
          where cash_session_id = $1 and kind = 'payment' and cancelled_at is null
       ) p
      group by method_name, kind
      order by sum(amount) desc`,
    [session.id],
  );
  const movements = await db.query<{ withdrawals: number; deposits: number; refunds: number }>(
    `select coalesce(sum(amount) filter (where kind = 'withdrawal'), 0) as withdrawals,
            coalesce(sum(amount) filter (where kind = 'deposit'), 0) as deposits,
            coalesce(sum(amount) filter (where kind = 'refund'), 0) as refunds
       from cash_movements where cash_session_id = $1`,
    [session.id],
  );
  const cash = methods.rows.filter((m) => m.kind === 'cash').reduce((sum, m) => sum + m.amount, 0);
  const { withdrawals, deposits, refunds } = movements.rows[0]!;
  // Devolução em dinheiro também sai da gaveta.
  const expectedCash = Math.round((session.opening_amount + cash + deposits - withdrawals - refunds) * 100) / 100;
  const received = Math.round(methods.rows.reduce((sum, m) => sum + m.amount, 0) * 100) / 100;
  return {
    methods: methods.rows,
    received,
    withdrawals,
    deposits,
    refunds,
    expected_cash: expectedCash,
    difference: session.counted_amount === null ? null : Math.round((session.counted_amount - expectedCash) * 100) / 100,
  };
}

/** Recebimento de uma parcela no caixa aberto do operador. Pode ser parcial. */
export async function receivePayment(
  db: pg.PoolClient,
  receivableId: number,
  user: SessionUser,
  input: { amount: number; payment_method_id: number },
) {
  const session = await lockOpenSession(db, user.id);
  const { rows } = await db.query<{ id: number; tenant_id: number; amount: number; paid_amount: number; status: string }>(
    'select id, tenant_id, amount, paid_amount, status from receivables where id = $1 for update',
    [receivableId],
  );
  const receivable = rows[0];
  if (!receivable) throw new HttpError(404, 'Parcela não encontrada.');
  if (receivable.status !== 'open') {
    throw new HttpError(409, receivable.status === 'paid' ? 'Esta parcela já está paga.' : 'Esta parcela foi cancelada.');
  }
  const remaining = Math.round((receivable.amount - receivable.paid_amount) * 100) / 100;
  if (input.amount > remaining + 0.005) {
    throw new HttpError(409, `Falta receber ${formatMoney(remaining)} desta parcela. O troco fica fora do recebimento.`);
  }
  const method = await db.query<{ name: string; kind: string }>('select name, kind from payment_methods where id = $1', [
    input.payment_method_id,
  ]);
  if (!method.rows[0]) throw new HttpError(400, 'Forma de pagamento não encontrada.');
  if (method.rows[0].kind === 'store_credit') {
    throw new HttpError(400, 'Crediário é forma de venda, não de recebimento. Escolha como o cliente está pagando agora.');
  }
  await db.query(
    `insert into receivable_payments (tenant_id, receivable_id, cash_session_id, payment_method_id, method_name, kind, amount, user_id)
     values ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [receivable.tenant_id, receivableId, session.id, input.payment_method_id, method.rows[0].name, method.rows[0].kind, input.amount, user.id],
  );
  await db.query(
    `update receivables
        set paid_amount = paid_amount + $2,
            status = case when paid_amount + $2 >= amount - 0.005 then 'paid' else 'open' end,
            paid_at = case when paid_amount + $2 >= amount - 0.005 then now() end
      where id = $1`,
    [receivableId, input.amount],
  );
}

/** Estorno de um recebimento: só com o caixa dele ainda aberto (o fechado já foi conferido). */
export async function reversePayment(db: pg.PoolClient, paymentId: number, user: SessionUser, reason: string) {
  const { rows } = await db.query<{
    id: number;
    receivable_id: number;
    amount: number;
    reversed_at: Date | null;
    session_user_id: number;
    session_closed_at: Date | null;
  }>(
    `select p.id, p.receivable_id, p.amount, p.reversed_at, cs.user_id as session_user_id, cs.closed_at as session_closed_at
       from receivable_payments p join cash_sessions cs on cs.id = p.cash_session_id
      where p.id = $1
      for update of p`,
    [paymentId],
  );
  const payment = rows[0];
  if (!payment) throw new HttpError(404, 'Recebimento não encontrado.');
  if (payment.reversed_at) throw new HttpError(409, 'Este recebimento já foi estornado.');
  if (payment.session_closed_at) throw new HttpError(409, 'O caixa deste recebimento já foi fechado e conferido; não dá para estornar.');
  if (user.role !== 'admin' && payment.session_user_id !== user.id) {
    throw new HttpError(403, 'Só quem abriu o caixa (ou o administrador) estorna o recebimento.');
  }
  await db.query('update receivable_payments set reversed_at = now(), reversed_by = $2, reverse_reason = $3 where id = $1', [
    paymentId,
    user.id,
    reason,
  ]);
  await db.query(
    `update receivables set paid_amount = paid_amount - $2, status = 'open', paid_at = null
      where id = $1 and status <> 'cancelled'`,
    [payment.receivable_id, payment.amount],
  );
}

/** Quanto do pedido ainda está em aberto (para o PIX do PDF). Sem parcelas, o total. */
export async function orderOpenAmount(db: pg.PoolClient, orderId: number, total: number) {
  const { rows } = await db.query<{ count: number; open: number }>(
    `select count(*) as count, coalesce(sum(amount - paid_amount) filter (where status = 'open'), 0) as open
       from receivables where order_id = $1`,
    [orderId],
  );
  return rows[0]!.count > 0 ? Math.round(rows[0]!.open * 100) / 100 : total;
}
