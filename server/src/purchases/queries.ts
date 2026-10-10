import type pg from 'pg';
import type { SessionUser } from '../db/session.js';
import { HttpError } from '../errors.js';
import { formatMoney } from '../lib/format.js';

export type PurchaseStatus = 'draft' | 'sent' | 'partial' | 'received' | 'cancelled';

/**
 * Fornecedor da entrada de nota: o escolhido na tela, senão o do CNPJ da nota (criado na
 * primeira nota dele), senão o de mesmo nome sem documento. Sem nada, a entrada fica sem fornecedor.
 */
export async function resolveSupplier(
  db: pg.PoolClient,
  user: SessionUser,
  input: { supplier_id: number | null; supplier_name: string | null; supplier_document: string | null },
): Promise<{ id: number; name: string; document: string | null } | null> {
  if (input.supplier_id) {
    const { rows } = await db.query<{ id: number; name: string; document: string | null }>(
      'select id, name, document from suppliers where id = $1',
      [input.supplier_id],
    );
    if (!rows[0]) throw new HttpError(400, 'Fornecedor não encontrado.');
    return rows[0];
  }
  const document = input.supplier_document && /^(\d{11}|\d{14})$/.test(input.supplier_document) ? input.supplier_document : null;
  const name = input.supplier_name?.trim() || null;
  if (document) {
    const { rows } = await db.query<{ id: number; name: string; document: string | null }>(
      `insert into suppliers (tenant_id, name, document) values ($1, $2, $3)
       on conflict (tenant_id, document) where document is not null
       do update set name = case when suppliers.name = suppliers.document then excluded.name else suppliers.name end
       returning id, name, document`,
      [user.tenant_id, name ?? document, document],
    );
    return rows[0]!;
  }
  if (!name) return null;
  const { rows } = await db.query<{ id: number; name: string; document: string | null }>(
    'select id, name, document from suppliers where document is null and lower(name) = lower($1) order by id limit 1',
    [name],
  );
  if (rows[0]) return rows[0];
  const created = await db.query<{ id: number; name: string; document: string | null }>(
    'insert into suppliers (tenant_id, name) values ($1, $2) returning id, name, document',
    [user.tenant_id, name],
  );
  return created.rows[0]!;
}

/**
 * Entrada de nota de um pedido de compra: soma o que chegou em cada item e passa o pedido
 * para "recebido em parte" ou "recebido". Produto que não estava no pedido só entra no estoque.
 */
export async function receivePurchaseOrder(
  db: pg.PoolClient,
  purchaseOrderId: number,
  storeId: number,
  items: { product_id: number; quantity: number }[],
) {
  const { rows } = await db.query<{ status: PurchaseStatus; store_id: number }>(
    'select status, store_id from purchase_orders where id = $1 for update',
    [purchaseOrderId],
  );
  const order = rows[0];
  if (!order) throw new HttpError(400, 'Pedido de compra não encontrado.');
  if (order.status === 'cancelled') throw new HttpError(409, 'Este pedido de compra foi cancelado.');
  if (order.status === 'received') throw new HttpError(409, 'Este pedido de compra já foi recebido.');
  if (order.store_id !== storeId) throw new HttpError(400, 'O pedido de compra é de outra loja. Escolha a loja do pedido.');
  await db.query(
    `update purchase_order_items i set received_quantity = i.received_quantity + c.quantity
       from (select product_id, sum(quantity) as quantity
               from unnest($2::bigint[], $3::numeric[]) as c(product_id, quantity)
              group by product_id) c
      where i.purchase_order_id = $1 and i.product_id = c.product_id`,
    [purchaseOrderId, items.map((i) => i.product_id), items.map((i) => i.quantity)],
  );
  const { rows: progress } = await db.query<{ complete: boolean }>(
    'select bool_and(received_quantity >= quantity - 0.0005) as complete from purchase_order_items where purchase_order_id = $1',
    [purchaseOrderId],
  );
  const complete = Boolean(progress[0]?.complete);
  await db.query(
    `update purchase_orders
        set status = $2, received_at = case when $2 = 'received' then now() end, updated_at = now()
      where id = $1`,
    [purchaseOrderId, complete ? 'received' : 'partial'],
  );
}

export type PayableInput = {
  store_id: number;
  supplier_id: number | null;
  description: string;
  category: string | null;
  document_number: string | null;
  entry_id?: number | null;
  purchase_order_id?: number | null;
  installments: { due_date: string; amount: number; document_number?: string | null }[];
};

/** Lança as parcelas de uma conta a pagar (uma linha por vencimento). */
export async function createPayables(db: pg.PoolClient, user: SessionUser, input: PayableInput) {
  const count = input.installments.length;
  const { rows } = await db.query<{ id: number }>(
    `insert into payables (tenant_id, store_id, supplier_id, description, category, document_number, installment, installments,
                           due_date, amount, entry_id, purchase_order_id, user_id)
     select $1, $2, $3, $4, $5, coalesce(p.doc, $6), p.n, $7, p.due_date, p.amount, $8, $9, $10
       from unnest($11::date[], $12::numeric[], $13::text[]) with ordinality as p(due_date, amount, doc, n)
     returning id`,
    [
      user.tenant_id,
      input.store_id,
      input.supplier_id,
      input.description,
      input.category,
      input.document_number,
      count,
      input.entry_id ?? null,
      input.purchase_order_id ?? null,
      user.id,
      input.installments.map((i) => i.due_date),
      input.installments.map((i) => i.amount),
      input.installments.map((i) => i.document_number ?? null),
    ],
  );
  return rows.map((r) => r.id);
}

export type PayablePaymentInput = { amount: number; paid_on: string; method: 'cash' | 'bank' | 'pix' | 'boleto' | 'card' | 'other'; note: string | null };

/** Pagamento (total ou parcial) de uma conta. Em dinheiro, sai do caixa aberto de quem paga. */
export async function payPayable(db: pg.PoolClient, payableId: number, user: SessionUser, input: PayablePaymentInput) {
  const { rows } = await db.query<{ id: number; tenant_id: number; amount: number; paid_amount: number; status: string }>(
    'select id, tenant_id, amount, paid_amount, status from payables where id = $1 for update',
    [payableId],
  );
  const payable = rows[0];
  if (!payable) throw new HttpError(404, 'Conta não encontrada.');
  if (payable.status !== 'open') throw new HttpError(409, payable.status === 'paid' ? 'Esta conta já está paga.' : 'Esta conta foi cancelada.');
  const remaining = Math.round((payable.amount - payable.paid_amount) * 100) / 100;
  if (input.amount > remaining + 0.005) throw new HttpError(409, `Falta pagar ${formatMoney(remaining)} desta conta.`);

  let sessionId: number | null = null;
  if (input.method === 'cash') {
    const session = await db.query<{ id: number }>('select id from cash_sessions where user_id = $1 and closed_at is null for update', [user.id]);
    if (!session.rows[0]) throw new HttpError(409, 'Abra o caixa para pagar em dinheiro da gaveta.', 'CASH_CLOSED');
    sessionId = session.rows[0].id;
  }
  await db.query(
    `insert into payable_payments (tenant_id, payable_id, amount, paid_on, method, cash_session_id, note, user_id)
     values ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [payable.tenant_id, payableId, input.amount, input.paid_on, input.method, sessionId, input.note, user.id],
  );
  await db.query(
    `update payables
        set paid_amount = paid_amount + $2,
            status = case when paid_amount + $2 >= amount - 0.005 then 'paid' else 'open' end,
            paid_at = case when paid_amount + $2 >= amount - 0.005 then now() end
      where id = $1`,
    [payableId, input.amount],
  );
}

/** Estorno de um pagamento. O que saiu da gaveta só volta com aquele caixa ainda aberto. */
export async function reversePayablePayment(db: pg.PoolClient, paymentId: number, user: SessionUser, reason: string) {
  const { rows } = await db.query<{ payable_id: number; amount: number; reversed_at: Date | null; session_closed_at: Date | null; cash: boolean }>(
    `select p.payable_id, p.amount, p.reversed_at, cs.closed_at as session_closed_at, p.cash_session_id is not null as cash
       from payable_payments p left join cash_sessions cs on cs.id = p.cash_session_id
      where p.id = $1
      for update of p`,
    [paymentId],
  );
  const payment = rows[0];
  if (!payment) throw new HttpError(404, 'Pagamento não encontrado.');
  if (payment.reversed_at) throw new HttpError(409, 'Este pagamento já foi estornado.');
  if (payment.cash && payment.session_closed_at) {
    throw new HttpError(409, 'O caixa deste pagamento já foi fechado e conferido; não dá para estornar.');
  }
  await db.query('update payable_payments set reversed_at = now(), reversed_by = $2, reverse_reason = $3 where id = $1', [
    paymentId,
    user.id,
    reason,
  ]);
  await db.query(
    `update payables set paid_amount = paid_amount - $2, status = 'open', paid_at = null
      where id = $1 and status <> 'cancelled'`,
    [payment.payable_id, payment.amount],
  );
}
