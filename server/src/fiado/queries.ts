import type pg from 'pg';
import type { SessionUser } from '../db/session.js';
import { HttpError } from '../errors.js';
import { loadFinanceSettings, lockOpenSession } from '../finance/queries.js';
import { formatMoney, todayIn } from '../lib/format.js';

export type FiadoSettings = {
  enabled: boolean;
  due_day: number;
  block_days: number;
  late_fee_percent: number;
  interest_percent: number;
  message: string | null;
};

export const DEFAULT_FIADO_MESSAGE =
  'Olá, {cliente}! Aqui é da {loja}. Seu fiado está com saldo de {saldo}{vencido}. Segue o extrato. Qualquer dúvida, é só chamar.';

/** Configuração do fiado da lojamestre. Precisa do contexto da lojamestre. */
export async function loadFiadoSettings(db: pg.PoolClient): Promise<FiadoSettings> {
  const { rows } = await db.query<{
    fiado_enabled: boolean;
    fiado_due_day: number;
    fiado_block_days: number;
    fiado_late_fee_percent: number;
    fiado_interest_percent: number;
    fiado_message: string | null;
  }>(
    `select fiado_enabled, fiado_due_day, fiado_block_days, fiado_late_fee_percent, fiado_interest_percent, fiado_message
       from settings limit 1`,
  );
  const s = rows[0];
  return {
    enabled: Boolean(s?.fiado_enabled),
    due_day: s?.fiado_due_day ?? 10,
    block_days: s?.fiado_block_days ?? 0,
    late_fee_percent: s?.fiado_late_fee_percent ?? 0,
    interest_percent: s?.fiado_interest_percent ?? 0,
    message: s?.fiado_message ?? null,
  };
}

const round2 = (value: number) => Math.round(value * 100) / 100;

/** Vencimento de uma compra: o dia de vencimento do mês seguinte ao da compra. */
export function purchaseDueDate(purchaseDay: string, dueDay: number) {
  const [y, m] = purchaseDay.split('-').map(Number) as [number, number];
  const next = new Date(Date.UTC(y, m, dueDay)); // m é 1-based: Date.UTC(y, m) já é o mês seguinte
  return next.toISOString().slice(0, 10);
}

export const daysBetween = (from: string, to: string) =>
  Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);

type Entry = { id: number; kind: string; amount: number; due_date: string | null; created_at: Date };

export type OpenDebit = { entry_id: number; kind: string; due_date: string; amount: number; remaining: number; days_late: number };

export type FiadoAccount = {
  balance: number;
  overdue: number;
  /** Vencimento mais antigo em atraso e há quantos dias. */
  oldest_overdue: string | null;
  days_late: number;
  /** Próximo vencimento ainda não atrasado. */
  next_due: string | null;
  next_due_amount: number;
  /** Encargos (multa + juros) se o cliente pagasse hoje. */
  charges: number;
  open_debits: OpenDebit[];
};

/**
 * Situação da conta: o pagamento abate sempre as compras mais antigas (pela data de
 * vencimento), então o que sobra em aberto é o fim da fila de débitos.
 *
 * Encargos: cada pagamento acerta (ou dispensa) os encargos até a data dele. Depois do
 * último pagamento (chargedUntil), a multa só vale para o que venceu dali em diante e os
 * juros correm a partir dele, para não cobrar duas vezes o mesmo atraso.
 */
export function computeAccount(
  entries: Entry[],
  today: string,
  settings: Pick<FiadoSettings, 'late_fee_percent' | 'interest_percent'>,
  chargedUntil: string | null = null,
): FiadoAccount {
  const debits = entries
    .filter((e) => e.amount > 0)
    .sort((a, b) => (a.due_date ?? '').localeCompare(b.due_date ?? '') || a.id - b.id);
  let credits = -entries.filter((e) => e.amount < 0).reduce((sum, e) => sum + e.amount, 0);
  const open: OpenDebit[] = [];
  for (const debit of debits) {
    const used = Math.min(debit.amount, credits);
    credits = round2(credits - used);
    const remaining = round2(debit.amount - used);
    if (remaining > 0) {
      const due = debit.due_date ?? today;
      open.push({ entry_id: debit.id, kind: debit.kind, due_date: due, amount: debit.amount, remaining, days_late: Math.max(0, daysBetween(due, today)) });
    }
  }
  const balance = round2(entries.reduce((sum, e) => sum + e.amount, 0));
  const overdueDebits = open.filter((d) => d.days_late > 0);
  const upcoming = open.filter((d) => d.days_late === 0);
  // Encargos só sobre compras e ajustes atrasados (não há juros sobre juros).
  const charges = round2(
    overdueDebits
      .filter((d) => d.kind !== 'charge')
      .reduce((sum, d) => {
        const feeDue = chargedUntil === null || d.due_date >= chargedUntil;
        const from = chargedUntil !== null && chargedUntil > d.due_date ? chargedUntil : d.due_date;
        const days = Math.max(0, daysBetween(from, today));
        return sum + (feeDue ? d.remaining * (settings.late_fee_percent / 100) : 0) + d.remaining * (settings.interest_percent / 100 / 30) * days;
      }, 0),
  );
  const nextDue = upcoming[0]?.due_date ?? null;
  return {
    balance,
    overdue: round2(overdueDebits.reduce((sum, d) => sum + d.remaining, 0)),
    oldest_overdue: overdueDebits[0]?.due_date ?? null,
    days_late: overdueDebits[0]?.days_late ?? 0,
    next_due: nextDue,
    next_due_amount: round2(upcoming.filter((d) => d.due_date === nextDue).reduce((sum, d) => sum + d.remaining, 0)),
    charges,
    open_debits: open,
  };
}

export async function loadAccount(db: pg.PoolClient, clientId: number, timeZone: string, settings?: FiadoSettings) {
  const config = settings ?? (await loadFiadoSettings(db));
  const { rows } = await db.query<Entry>(
    `select id, kind, amount, due_date, created_at from fiado_entries
      where client_id = $1 and cancelled_at is null
      order by created_at, id`,
    [clientId],
  );
  // Último pagamento (no fuso da loja): os encargos até ele já foram acertados.
  const last = await db.query<{ day: string | null }>(
    `select max((created_at at time zone $2)::date)::text as day from fiado_entries
      where client_id = $1 and kind = 'payment' and cancelled_at is null`,
    [clientId, timeZone],
  );
  return computeAccount(rows, todayIn(timeZone), config, last.rows[0]?.day ?? null);
}

/** Saldo do fiado do cliente (positivo = deve), para somar no limite do crediário. */
export async function fiadoBalance(db: pg.PoolClient, clientId: number) {
  const { rows } = await db.query<{ balance: number }>(
    'select coalesce(sum(amount), 0) as balance from fiado_entries where client_id = $1 and cancelled_at is null',
    [clientId],
  );
  return Math.max(0, rows[0]?.balance ?? 0);
}

/** Parcelas do crediário (financeiro) em aberto, para somar no limite do fiado. */
async function openStoreCredit(db: pg.PoolClient, clientId: number) {
  const { rows } = await db.query<{ open: number }>(
    `select coalesce(sum(amount - paid_amount), 0) as open from receivables
      where client_id = $1 and status = 'open' and kind = 'store_credit'`,
    [clientId],
  );
  return rows[0]?.open ?? 0;
}

type FiadoOrder = { id: number; tenant_id: number; store_id: number; client_id: number; client_name: string; total_amount: number; credit_limit: number | null; client_due_day: number | null; user_id: number };

async function loadFiadoOrder(db: pg.PoolClient, orderId: number): Promise<FiadoOrder | null> {
  const { rows } = await db.query<FiadoOrder & { kind: string | null }>(
    `select o.id, o.tenant_id, o.store_id, o.client_id, c.name as client_name, o.total_amount - o.credit_used as total_amount, c.credit_limit,
            c.fiado_due_day as client_due_day, o.user_id, pm.kind
       from orders o
       join clients c on c.id = o.client_id
       left join payment_methods pm on pm.id = o.payment_method_id
      where o.id = $1`,
    [orderId],
  );
  const order = rows[0];
  return order && order.kind === 'fiado' ? order : null;
}

/**
 * Venda no fiado: precisa de limite, não pode ter atraso além da tolerância e não pode
 * passar do limite somando o fiado e o crediário em aberto.
 */
export async function assertFiadoPurchase(db: pg.PoolClient, orderId: number, timeZone: string) {
  const settings = await loadFiadoSettings(db);
  if (!settings.enabled) return;
  const order = await loadFiadoOrder(db, orderId);
  if (!order) return;
  if (order.credit_limit === null) {
    throw new HttpError(
      409,
      `${order.client_name} não tem fiado liberado. O administrador define o limite em Clientes → Crédito.`,
      'FIADO_NOT_APPROVED',
    );
  }
  const account = await loadAccount(db, order.client_id, timeZone, settings);
  if (account.days_late > settings.block_days) {
    throw new HttpError(
      409,
      `${order.client_name} está com o fiado atrasado há ${account.days_late} ${account.days_late === 1 ? 'dia' : 'dias'} (${formatMoney(account.overdue)}). Receba antes de vender fiado.`,
      'FIADO_OVERDUE',
    );
  }
  const debt = Math.max(0, account.balance) + (await openStoreCredit(db, order.client_id));
  const available = round2(order.credit_limit - debt);
  if (order.total_amount > available + 0.005) {
    throw new HttpError(
      409,
      `O pedido de ${formatMoney(order.total_amount)} passa do crédito de ${order.client_name}: limite ${formatMoney(order.credit_limit)}, devendo ${formatMoney(debt)}, disponível ${formatMoney(Math.max(0, available))}.`,
      'FIADO_LIMIT',
    );
  }
}

/** Lança a compra fiada na conta, com o vencimento do mês seguinte. */
export async function createFiadoPurchase(db: pg.PoolClient, orderId: number, timeZone: string) {
  const settings = await loadFiadoSettings(db);
  if (!settings.enabled) return;
  const order = await loadFiadoOrder(db, orderId);
  if (!order || order.total_amount <= 0) return;
  const due = purchaseDueDate(todayIn(timeZone), order.client_due_day ?? settings.due_day);
  await db.query(
    `insert into fiado_entries (tenant_id, store_id, client_id, kind, amount, due_date, description, order_id, user_id)
     values ($1, $2, $3, 'purchase', $4, $5, $6, $7, $8)`,
    [order.tenant_id, order.store_id, order.client_id, order.total_amount, due, `Pedido ${String(order.id).padStart(6, '0')}`, order.id, order.user_id],
  );
}

/** Pedido cancelado: a compra sai da conta (se o cliente já pagou, fica com crédito). */
export async function cancelFiadoPurchase(db: pg.PoolClient, orderId: number, user: SessionUser, reason: string) {
  await db.query(
    `update fiado_entries set cancelled_at = now(), cancelled_by = $2, cancel_reason = $3
      where order_id = $1 and kind = 'purchase' and cancelled_at is null`,
    [orderId, user.id, reason],
  );
}

/**
 * Recebimento do fiado. Com encargos configurados e conta atrasada, lança multa e juros
 * (o admin pode dispensar). Com o financeiro ligado, entra no caixa aberto do operador.
 */
export async function receiveFiado(
  db: pg.PoolClient,
  user: SessionUser,
  clientId: number,
  input: { amount: number; payment_method_id: number; waive_charges: boolean; note: string | null },
  timeZone: string,
) {
  const settings = await loadFiadoSettings(db);
  if (!settings.enabled) throw new HttpError(409, 'O fiado está desligado.', 'FIADO_DISABLED');
  // Um recebimento por vez na conta do cliente.
  await db.query('select 1 from clients where id = $1 for update', [clientId]);
  const account = await loadAccount(db, clientId, timeZone, settings);
  if (account.balance <= 0) throw new HttpError(409, 'Este cliente não deve nada no fiado.');
  if (input.waive_charges && user.role !== 'admin') throw new HttpError(403, 'Só o administrador dispensa os encargos.');
  const charges = input.waive_charges ? 0 : account.charges;
  const debt = round2(account.balance + charges);
  if (input.amount > debt + 0.005) {
    throw new HttpError(409, `O cliente deve ${formatMoney(debt)}${charges ? ' com os encargos' : ''}. O troco fica fora do recebimento.`);
  }
  const method = await db.query<{ name: string; kind: string }>('select name, kind from payment_methods where id = $1', [input.payment_method_id]);
  if (!method.rows[0]) throw new HttpError(400, 'Forma de pagamento não encontrada.');
  if (method.rows[0].kind === 'fiado' || method.rows[0].kind === 'store_credit') {
    throw new HttpError(400, 'Escolha como o cliente está pagando agora (dinheiro, PIX, cartão...).');
  }

  const finance = await loadFinanceSettings(db);
  const session = finance.enabled ? await lockOpenSession(db, user.id) : null;
  const storeId = session?.store_id ?? user.store_id;
  const { rows } = await db.query<{ id: number }>(
    `insert into fiado_entries (tenant_id, store_id, client_id, kind, amount, description, payment_method_id, payment_method_name,
                                payment_kind, cash_session_id, user_id)
     select tenant_id, $2, $1, 'payment', $3, $4, $5, $6, $7, $8, $9 from clients where id = $1
     returning id`,
    [clientId, storeId, -input.amount, input.note, input.payment_method_id, method.rows[0].name, method.rows[0].kind, session?.id ?? null, user.id],
  );
  const paymentId = rows[0]!.id;
  if (charges > 0) {
    await db.query(
      `insert into fiado_entries (tenant_id, store_id, client_id, kind, amount, due_date, description, payment_entry_id, user_id)
       select tenant_id, $2, $1, 'charge', $3, $4, $5, $6, $7 from clients where id = $1`,
      [clientId, storeId, charges, todayIn(timeZone), 'Multa e juros por atraso', paymentId, user.id],
    );
  }
  return { payment_id: paymentId, charges, amount: input.amount, balance: round2(debt - input.amount) };
}

/**
 * Estorno de um recebimento (com os encargos dele). No caixa, só com o caixa aberto, pelo
 * operador ou pelo admin; sem caixa, só o admin.
 */
export async function reverseFiadoPayment(db: pg.PoolClient, entryId: number, user: SessionUser, reason: string) {
  const { rows } = await db.query<{
    id: number;
    kind: string;
    cancelled_at: Date | null;
    session_user_id: number | null;
    session_closed_at: Date | null;
    cash_session_id: number | null;
  }>(
    `select e.id, e.kind, e.cancelled_at, e.cash_session_id, cs.user_id as session_user_id, cs.closed_at as session_closed_at
       from fiado_entries e left join cash_sessions cs on cs.id = e.cash_session_id
      where e.id = $1
      for update of e`,
    [entryId],
  );
  const entry = rows[0];
  if (!entry || entry.kind !== 'payment') throw new HttpError(404, 'Recebimento não encontrado.');
  if (entry.cancelled_at) throw new HttpError(409, 'Este recebimento já foi estornado.');
  if (entry.cash_session_id) {
    if (entry.session_closed_at) throw new HttpError(409, 'O caixa deste recebimento já foi fechado e conferido; não dá para estornar.');
    if (user.role !== 'admin' && entry.session_user_id !== user.id) {
      throw new HttpError(403, 'Só quem abriu o caixa (ou o administrador) estorna o recebimento.');
    }
  } else if (user.role !== 'admin') {
    throw new HttpError(403, 'Só o administrador estorna o recebimento do fiado.');
  }
  await db.query(
    `update fiado_entries set cancelled_at = now(), cancelled_by = $2, cancel_reason = $3
      where (id = $1 or payment_entry_id = $1) and cancelled_at is null`,
    [entryId, user.id, reason],
  );
}
