import type pg from 'pg';
import type { SessionUser } from '../db/session.js';
import { HttpError } from '../errors.js';
import { loadFiadoSettings } from '../fiado/queries.js';
import { loadFinanceSettings, lockOpenSession } from '../finance/queries.js';
import { formatMoney, formatOrderNumber, formatQuantity } from '../lib/format.js';
import { applyStockChanges } from '../stock/queries.js';

export type RefundMethod = 'cash' | 'pix' | 'card' | 'credit' | 'fiado' | 'receivables' | 'none';

export type ReturnableItem = {
  order_item_id: number;
  product_id: number;
  product_code: string | null;
  product_name: string;
  unit: string;
  sold: number;
  /** Entregue/retirado (nos pedidos com controle de entrega); senão, o vendido. */
  taken: number;
  returned: number;
  returnable: number;
  /** Preço unitário com o desconto do pedido rateado. */
  net_price: number;
};

const round2 = (value: number) => Math.round(value * 100) / 100;
const round3 = (value: number) => Math.round(value * 1000) / 1000;

/** Quanto de cada item ainda pode voltar: o que o cliente levou menos o que já devolveu. */
export async function loadReturnable(db: pg.PoolClient, orderId: number): Promise<ReturnableItem[]> {
  const { rows } = await db.query<Omit<ReturnableItem, 'returnable' | 'taken' | 'net_price'> & { delivered: number; tracking: boolean; unit_price: number; ratio: number }>(
    `select i.id as order_item_id, i.product_id, i.product_code, i.product_name, i.unit, i.quantity as sold, i.unit_price,
            o.delivery_tracking as tracking,
            case when o.subtotal_amount > 0 then o.discount_amount / o.subtotal_amount else 0 end as ratio,
            coalesce((select sum(di.quantity) from delivery_items di join deliveries d on d.id = di.delivery_id
                       where di.order_item_id = i.id and d.status = 'done'), 0) as delivered,
            coalesce((select sum(ri.quantity) from order_return_items ri where ri.order_item_id = i.id), 0) as returned
       from order_items i
       join orders o on o.id = i.order_id
      where i.order_id = $1
      order by i.position`,
    [orderId],
  );
  return rows.map(({ delivered, tracking, unit_price, ratio, ...row }) => {
    const taken = tracking ? delivered : row.sold;
    return {
      ...row,
      taken,
      returnable: Math.max(0, round3(taken - row.returned)),
      net_price: Math.round(unit_price * (1 - ratio) * 10_000) / 10_000,
    };
  });
}

/** Saldo de crédito (vale-troca) do cliente. */
export async function clientCreditBalance(db: pg.PoolClient, clientId: number) {
  const { rows } = await db.query<{ balance: number }>(
    'select coalesce(sum(amount), 0) as balance from client_credits where client_id = $1 and cancelled_at is null',
    [clientId],
  );
  return round2(rows[0]?.balance ?? 0);
}

/** Abate o valor nas parcelas em aberto do pedido, da última para a primeira. */
async function reduceReceivables(db: pg.PoolClient, orderId: number, amount: number, reason: string) {
  const { rows } = await db.query<{ id: number; amount: number; paid_amount: number }>(
    `select id, amount, paid_amount from receivables
      where order_id = $1 and status = 'open'
      order by installment desc
      for update`,
    [orderId],
  );
  const open = round2(rows.reduce((sum, r) => sum + r.amount - r.paid_amount, 0));
  if (amount > open + 0.005) {
    throw new HttpError(409, `As parcelas em aberto do pedido somam ${formatMoney(open)}. Devolva o resto de outra forma.`);
  }
  let left = amount;
  for (const r of rows) {
    if (left <= 0) break;
    const remaining = round2(r.amount - r.paid_amount);
    const cut = Math.min(remaining, left);
    left = round2(left - cut);
    if (cut >= remaining - 0.005) {
      // Parcela inteira abatida: se nada foi pago, cancela; se foi pago parte, fecha no que pagou.
      if (r.paid_amount > 0) {
        await db.query(`update receivables set amount = paid_amount, status = 'paid', paid_at = now() where id = $1`, [r.id]);
      } else {
        await db.query(`update receivables set status = 'cancelled', cancelled_at = now(), cancel_reason = $2 where id = $1`, [r.id, reason]);
      }
    } else {
      await db.query('update receivables set amount = amount - $2 where id = $1', [r.id, cut]);
    }
  }
}

export type ReturnInput = {
  items: { order_item_id: number; quantity: number; restock: boolean }[];
  reason: string;
  refund_method: RefundMethod;
};

/**
 * Registra a devolução: confere o que pode voltar, devolve o valor pela forma escolhida e
 * põe a mercadoria de volta no estoque (o que não estava avariado). Tudo na mesma transação.
 */
export async function createReturn(db: pg.PoolClient, user: SessionUser, orderId: number, input: ReturnInput) {
  const { rows: orders } = await db.query<{ id: number; tenant_id: number; store_id: number; client_id: number; status: string }>(
    'select id, tenant_id, store_id, client_id, status from orders where id = $1 for update',
    [orderId],
  );
  const order = orders[0];
  if (!order) throw new HttpError(404, 'Pedido não encontrado.');
  if (order.status !== 'order') throw new HttpError(409, 'Só pedido confirmado tem devolução.');

  const returnable = new Map((await loadReturnable(db, orderId)).map((i) => [i.order_item_id, i]));
  const lines = input.items.filter((i) => i.quantity > 0);
  if (!lines.length) throw new HttpError(400, 'Informe a quantidade de pelo menos um item.');
  const seen = new Set<number>();
  const items = lines.map((line) => {
    const item = returnable.get(line.order_item_id);
    if (!item) throw new HttpError(400, 'Um dos itens não é deste pedido.');
    if (seen.has(line.order_item_id)) throw new HttpError(400, 'O mesmo item aparece duas vezes.');
    seen.add(line.order_item_id);
    if (line.quantity > item.returnable + 0.0005) {
      throw new HttpError(
        409,
        item.returnable > 0
          ? `${item.product_name}: dá para devolver até ${formatQuantity(item.returnable)} ${item.unit} (o que o cliente levou e ainda não devolveu).`
          : `${item.product_name}: nada para devolver (o cliente ainda não levou ou já devolveu tudo).`,
      );
    }
    return { ...item, quantity: line.quantity, restock: line.restock, amount: round2(line.quantity * item.net_price) };
  });
  const amount = round2(items.reduce((sum, i) => sum + i.amount, 0));
  const label = `Devolução do pedido ${formatOrderNumber(orderId)}`;

  let cashSessionId: number | null = null;
  const { rows: inserted } = await db.query<{ id: number }>(
    `insert into order_returns (tenant_id, store_id, order_id, client_id, user_id, reason, refund_method, amount)
     values ($1, $2, $3, $4, $5, $6, $7, $8) returning id`,
    [order.tenant_id, order.store_id, orderId, order.client_id, user.id, input.reason, input.refund_method, amount],
  );
  const returnId = inserted[0]!.id;

  switch (input.refund_method) {
    case 'cash': {
      // Com o financeiro ligado, o dinheiro sai da gaveta do caixa aberto.
      if ((await loadFinanceSettings(db)).enabled && amount > 0) {
        const session = await lockOpenSession(db, user.id);
        cashSessionId = session.id;
        await db.query(
          `insert into cash_movements (tenant_id, cash_session_id, kind, amount, reason, user_id)
           values ($1, $2, 'refund', $3, $4, $5)`,
          [order.tenant_id, session.id, amount, label, user.id],
        );
      }
      break;
    }
    case 'credit':
      if (amount > 0) {
        await db.query(
          `insert into client_credits (tenant_id, client_id, amount, return_id, description, user_id)
           values ($1, $2, $3, $4, $5, $6)`,
          [order.tenant_id, order.client_id, amount, returnId, label, user.id],
        );
      }
      break;
    case 'fiado':
      if (!(await loadFiadoSettings(db)).enabled) throw new HttpError(409, 'O fiado está desligado.');
      if (amount > 0) {
        await db.query(
          `insert into fiado_entries (tenant_id, store_id, client_id, kind, amount, description, order_id, user_id)
           values ($1, $2, $3, 'refund', $4, $5, $6, $7)`,
          [order.tenant_id, order.store_id, order.client_id, -amount, label, orderId, user.id],
        );
      }
      break;
    case 'receivables':
      if (!(await loadFinanceSettings(db)).enabled) throw new HttpError(409, 'O financeiro está desligado.');
      if (amount > 0) await reduceReceivables(db, orderId, amount, label);
      break;
    default:
      break;
  }
  if (cashSessionId) await db.query('update order_returns set cash_session_id = $2 where id = $1', [returnId, cashSessionId]);

  await db.query(
    `insert into order_return_items (tenant_id, return_id, order_item_id, product_id, product_name, unit, quantity, unit_price, amount, restock)
     select $1, $2, i.order_item_id, i.product_id, i.product_name, i.unit, i.quantity, i.unit_price, i.amount, i.restock
       from unnest($3::bigint[], $4::bigint[], $5::text[], $6::text[], $7::numeric[], $8::numeric[], $9::numeric[], $10::boolean[])
         as i(order_item_id, product_id, product_name, unit, quantity, unit_price, amount, restock)`,
    [
      order.tenant_id,
      returnId,
      items.map((i) => i.order_item_id),
      items.map((i) => i.product_id),
      items.map((i) => i.product_name),
      items.map((i) => i.unit),
      items.map((i) => i.quantity),
      items.map((i) => i.net_price),
      items.map((i) => i.amount),
      items.map((i) => i.restock),
    ],
  );

  // Volta para o estoque só o que a venda baixou (produto que controla estoque) e não está avariado.
  const restock = items.filter((i) => i.restock);
  if (restock.length) {
    const { rows: deducted } = await db.query<{ product_id: number }>(
      `select distinct product_id from stock_movements where order_id = $1 and kind = 'sale' and product_id = any($2::bigint[])`,
      [orderId, restock.map((i) => i.product_id)],
    );
    const ids = new Set(deducted.map((d) => d.product_id));
    await applyStockChanges(
      db,
      user,
      restock
        .filter((i) => ids.has(i.product_id))
        .map((i) => ({ store_id: order.store_id, product_id: i.product_id, quantity: i.quantity, kind: 'return' as const, order_id: orderId, note: `${label} (devolução nº ${returnId})` })),
    );
    await db.query(`update stock_movements set return_id = $1 where order_id = $2 and kind = 'return' and return_id is null`, [returnId, orderId]);
  }

  return { id: returnId, amount };
}

/** O crédito usado não passa do total do pedido (o total é recalculado ao salvar). */
export async function assertCreditFits(db: pg.PoolClient, orderId: number) {
  const { rows } = await db.query<{ credit_used: number; total_amount: number }>(
    'select credit_used, total_amount from orders where id = $1',
    [orderId],
  );
  const order = rows[0];
  if (order && order.credit_used > order.total_amount + 0.005) {
    throw new HttpError(400, `O crédito usado (${formatMoney(order.credit_used)}) passa do total do pedido (${formatMoney(order.total_amount)}).`);
  }
}

/** Usa o crédito do cliente (vale-troca) na confirmação do pedido. */
export async function useClientCredit(db: pg.PoolClient, orderId: number, user: SessionUser) {
  const { rows } = await db.query<{ tenant_id: number; client_id: number; credit_used: number; total_amount: number }>(
    'select tenant_id, client_id, credit_used, total_amount from orders where id = $1',
    [orderId],
  );
  const order = rows[0];
  if (!order || order.credit_used <= 0) return;
  if (order.credit_used > order.total_amount + 0.005) throw new HttpError(400, 'O crédito usado não pode passar do total do pedido.');
  // Um uso de crédito por vez na conta do cliente.
  await db.query('select 1 from clients where id = $1 for update', [order.client_id]);
  const balance = await clientCreditBalance(db, order.client_id);
  if (order.credit_used > balance + 0.005) {
    throw new HttpError(409, `O cliente tem ${formatMoney(balance)} de crédito. Diminua o crédito usado no pedido.`, 'CREDIT_BALANCE');
  }
  await db.query(
    `insert into client_credits (tenant_id, client_id, amount, order_id, description, user_id)
     values ($1, $2, $3, $4, $5, $6)`,
    [order.tenant_id, order.client_id, -order.credit_used, orderId, `Usado no pedido ${formatOrderNumber(orderId)}`, user.id],
  );
}

/** Pedido cancelado: o crédito que ele usou volta para o cliente. */
export async function restoreClientCredit(db: pg.PoolClient, orderId: number) {
  await db.query('update client_credits set cancelled_at = now() where order_id = $1 and amount < 0 and cancelled_at is null', [orderId]);
}
