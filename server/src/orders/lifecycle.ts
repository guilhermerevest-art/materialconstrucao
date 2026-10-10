import type pg from 'pg';
import type { SessionUser } from '../db/session.js';
import { HttpError } from '../errors.js';
import { cancelOrderDeliveries } from '../deliveries/queries.js';
import { assertStoreCredit, cancelOrderReceivables, createOrderReceivables, loadFinanceSettings } from '../finance/queries.js';
import { applyOrderStock, returnOrderStock } from '../stock/queries.js';
import { enterWorkflow } from '../workflow/queries.js';

/**
 * Tudo o que acontece quando um orçamento vira pedido (criado como pedido,
 * convertido ou salvo como pedido). Roda na mesma transação que confirma.
 */
export async function onOrderConfirmed(db: pg.PoolClient, orderId: number, user: SessionUser, timeZone: string) {
  // Financeiro desligado (padrão): nada de parcela nem trava de crediário, como no MVP.
  const finance = await loadFinanceSettings(db);
  if (finance.enabled) await assertStoreCredit(db, orderId, timeZone);
  await enterWorkflow(db, orderId, user.id);
  await applyOrderStock(db, orderId, user);
  // Daqui em diante o pedido tem saldo a entregar (retiradas e entregas parciais).
  await db.query('update orders set delivery_tracking = true where id = $1', [orderId]);
  if (finance.enabled) await createOrderReceivables(db, orderId, timeZone);
}

type CancellableOrder = {
  status: 'quote' | 'order' | 'cancelled';
  stage_id: number | null;
  stage_name: string | null;
  stock_applied: boolean;
};

/**
 * Nota fiscal em aberto impede o cancelamento: autorizada ou em processamento (cancele
 * a nota) e recusada ou com erro, que ainda segura o número (inutilize o número). São
 * os mesmos status que o módulo fiscal trata como nota em andamento do pedido.
 */
async function assertNoActiveInvoice(db: pg.PoolClient, orderId: number) {
  const { rows } = await db.query<{ status: string }>(
    `select status from fiscal_documents
      where order_id = $1 and status in ('pendente', 'autorizado', 'rejeitado', 'erro')
      limit 1`,
    [orderId],
  );
  const status = rows[0]?.status;
  if (status === 'pendente' || status === 'autorizado') {
    throw new HttpError(409, 'Este pedido tem nota fiscal autorizada ou em processamento. Cancele a nota antes de cancelar o pedido.');
  }
  if (status) {
    throw new HttpError(409, 'Este pedido tem nota fiscal recusada esperando correção. Inutilize o número da nota antes de cancelar o pedido.');
  }
}

/**
 * Cancela o pedido ou marca o orçamento como perdido. O documento continua
 * existindo, com o motivo; sai do monitor e dos números de venda.
 */
export async function cancelOrder(db: pg.PoolClient, orderId: number, user: SessionUser, reason: string) {
  const { rows } = await db.query<CancellableOrder>(
    `select o.status, o.stage_id, ws.name as stage_name, o.stock_applied
       from orders o
       left join workflow_stages ws on ws.id = o.stage_id
      where o.id = $1
      for update of o`,
    [orderId],
  );
  const order = rows[0];
  if (!order) throw new HttpError(404, 'Pedido não encontrado.');
  if (order.status === 'cancelled') throw new HttpError(409, 'Este documento já está cancelado.');
  if (order.status === 'order') {
    if (user.role !== 'admin') throw new HttpError(403, 'Só o administrador cancela pedidos confirmados.');
    await assertNoActiveInvoice(db, orderId);
  }

  if (order.status === 'order') {
    await cancelOrderReceivables(db, orderId, `Pedido cancelado: ${reason}`);
    await cancelOrderDeliveries(db, orderId, user, `Pedido cancelado: ${reason}`);
  }
  if (order.stock_applied) await returnOrderStock(db, orderId, user, `Pedido cancelado: ${reason}`);
  await db.query(
    `update orders
        set status = 'cancelled', cancelled_from = status, cancelled_at = now(), cancelled_by = $2,
            cancel_reason = $3, updated_at = now()
      where id = $1`,
    [orderId, user.id, reason],
  );
  // No histórico de etapas, o cancelamento aparece como o último passo.
  if (order.stage_id !== null) {
    await db.query(
      `insert into order_stage_events (tenant_id, order_id, from_stage_id, from_stage_name, to_stage_name, user_id, note)
       select tenant_id, id, $2, $3, 'Cancelado', $4, $5 from orders where id = $1`,
      [orderId, order.stage_id, order.stage_name, user.id, reason],
    );
  }
}

/** Orçamento marcado como perdido por engano volta a ser orçamento. Pedido cancelado não volta. */
export async function reopenQuote(db: pg.PoolClient, orderId: number) {
  const { rows } = await db.query<{ status: string; cancelled_from: string | null }>(
    'select status, cancelled_from from orders where id = $1 for update',
    [orderId],
  );
  const order = rows[0];
  if (!order) throw new HttpError(404, 'Pedido não encontrado.');
  if (order.status !== 'cancelled' || order.cancelled_from !== 'quote') {
    throw new HttpError(409, 'Só orçamentos perdidos podem ser reabertos.');
  }
  await db.query(
    `update orders
        set status = 'quote', cancelled_from = null, cancelled_at = null, cancelled_by = null,
            cancel_reason = null, updated_at = now()
      where id = $1`,
    [orderId],
  );
}
