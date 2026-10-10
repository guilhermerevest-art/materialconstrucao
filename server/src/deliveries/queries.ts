import type pg from 'pg';
import type { SessionUser } from '../db/session.js';
import { HttpError } from '../errors.js';

export type FulfillmentItem = {
  order_item_id: number;
  product_id: number;
  product_code: string | null;
  product_name: string;
  unit: string;
  quantity: number;
  /** Já entregue ou retirado. */
  delivered: number;
  /** Agendado ou em rota, ainda não entregue. */
  scheduled: number;
  /** Falta agendar ou entregar: quantity - delivered - scheduled. */
  pending: number;
};

const round3 = (value: number) => Math.round(value * 1000) / 1000;

/** Quanto de cada item do pedido já saiu, está agendado e falta. */
export async function loadFulfillment(db: pg.PoolClient, orderId: number): Promise<FulfillmentItem[]> {
  const { rows } = await db.query<Omit<FulfillmentItem, 'pending'>>(
    `select i.id as order_item_id, i.product_id, i.product_code, i.product_name, i.unit, i.quantity,
            coalesce(sum(di.quantity) filter (where d.status = 'done'), 0) as delivered,
            coalesce(sum(di.quantity) filter (where d.status in ('scheduled', 'in_route')), 0) as scheduled
       from order_items i
       left join delivery_items di on di.order_item_id = i.id
       left join deliveries d on d.id = di.delivery_id
      where i.order_id = $1
      group by i.id
      order by i.position`,
    [orderId],
  );
  return rows.map((r) => ({ ...r, pending: round3(r.quantity - r.delivered - r.scheduled) }));
}

type OrderForDelivery = {
  id: number;
  tenant_id: number;
  store_id: number;
  status: string;
  delivery_tracking: boolean;
  delivery_address: string | null;
};

/** Trava o pedido para duas entregas ao mesmo tempo não passarem do vendido. */
export async function lockOrderForDelivery(db: pg.PoolClient, orderId: number): Promise<OrderForDelivery> {
  const { rows } = await db.query<OrderForDelivery>(
    `select id, tenant_id, store_id, status, delivery_tracking, delivery_address
       from orders where id = $1 for update`,
    [orderId],
  );
  const order = rows[0];
  if (!order) throw new HttpError(404, 'Pedido não encontrado.');
  if (order.status !== 'order') throw new HttpError(409, 'Só pedidos confirmados têm entrega.');
  if (!order.delivery_tracking) {
    throw new HttpError(409, 'Este pedido é de antes do controle de entregas e não tem saldo a entregar.');
  }
  return order;
}

export type DeliveryInput = {
  kind: 'pickup' | 'delivery';
  status: 'done' | 'scheduled';
  scheduled_date: string | null;
  period: 'morning' | 'afternoon' | null;
  address: string | null;
  receiver_name: string | null;
  notes: string | null;
  items: { order_item_id: number; quantity: number }[];
};

/**
 * Registra uma retirada (já feita) ou agenda uma entrega/retirada. As quantidades não
 * passam do que falta de cada item. Chamar com o pedido travado (lockOrderForDelivery).
 */
export async function insertDelivery(
  db: pg.PoolClient,
  order: OrderForDelivery,
  user: SessionUser,
  input: DeliveryInput,
): Promise<number> {
  const fulfillment = await loadFulfillment(db, order.id);
  const byId = new Map(fulfillment.map((f) => [f.order_item_id, f]));
  const items = input.items.filter((i) => i.quantity > 0);
  if (!items.length) throw new HttpError(400, 'Informe a quantidade de pelo menos um item.');
  for (const item of items) {
    const line = byId.get(item.order_item_id);
    if (!line) throw new HttpError(400, 'Um dos itens não é deste pedido. Atualize a página.');
    if (item.quantity > line.pending + 0.0005) {
      throw new HttpError(
        409,
        `${line.product_name}: só faltam ${line.pending.toLocaleString('pt-BR')} ${line.unit} para ${input.kind === 'pickup' ? 'retirar' : 'entregar'}.`,
      );
    }
  }
  const address = input.kind === 'delivery' ? (input.address ?? order.delivery_address) : null;
  if (input.kind === 'delivery' && !address) throw new HttpError(400, 'Informe o endereço da entrega.');
  if (input.status === 'scheduled' && !input.scheduled_date) throw new HttpError(400, 'Escolha a data.');

  const done = input.status === 'done';
  const { rows } = await db.query<{ id: number }>(
    `insert into deliveries (tenant_id, store_id, order_id, kind, status, scheduled_date, period, address,
                             receiver_name, notes, created_by, completed_by, completed_at)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
     returning id`,
    [
      order.tenant_id,
      order.store_id,
      order.id,
      input.kind,
      input.status,
      input.scheduled_date,
      input.period,
      address,
      input.receiver_name,
      input.notes,
      user.id,
      done ? user.id : null,
      done ? new Date() : null,
    ],
  );
  const deliveryId = rows[0]!.id;
  await db.query(
    `insert into delivery_items (delivery_id, order_item_id, tenant_id, quantity)
     select $1, i.order_item_id, $2, i.quantity
       from unnest($3::bigint[], $4::numeric[]) as i(order_item_id, quantity)`,
    [deliveryId, order.tenant_id, items.map((i) => i.order_item_id), items.map((i) => i.quantity)],
  );
  return deliveryId;
}

/**
 * Pedido chegou na etapa final do fluxo ("Entregue", "Retirado"): o que ainda não
 * tinha sido agendado nem entregue é registrado como entregue agora.
 */
export async function completeRemaining(db: pg.PoolClient, orderId: number, user: SessionUser, stageName: string) {
  const { rows } = await db.query<OrderForDelivery>(
    `select id, tenant_id, store_id, status, delivery_tracking, delivery_address from orders where id = $1 for update`,
    [orderId],
  );
  const order = rows[0];
  if (!order || order.status !== 'order' || !order.delivery_tracking) return;
  const pending = (await loadFulfillment(db, orderId)).filter((f) => f.pending > 0);
  if (!pending.length) return;
  await insertDelivery(db, order, user, {
    kind: order.delivery_address ? 'delivery' : 'pickup',
    status: 'done',
    scheduled_date: null,
    period: null,
    address: order.delivery_address,
    receiver_name: null,
    notes: `Registrado ao chegar na etapa "${stageName}".`,
    items: pending.map((f) => ({ order_item_id: f.order_item_id, quantity: f.pending })),
  });
}

/**
 * Cancelamento do pedido: com entrega feita não dá (a mercadoria já saiu); as
 * agendadas são desmarcadas junto.
 */
export async function cancelOrderDeliveries(db: pg.PoolClient, orderId: number, user: SessionUser, reason: string) {
  const { rows } = await db.query<{ done: number }>(
    `select count(*) filter (where status = 'done') as done from deliveries where order_id = $1`,
    [orderId],
  );
  if (rows[0]!.done > 0) {
    throw new HttpError(
      409,
      'Este pedido já teve entrega ou retirada registrada. Estorne as entregas antes de cancelar (a mercadoria precisa voltar).',
    );
  }
  await db.query(
    `update deliveries
        set status = 'cancelled', cancelled_at = now(), cancelled_by = $2, cancel_reason = $3, route_id = null
      where order_id = $1 and status in ('scheduled', 'in_route')`,
    [orderId, user.id, reason],
  );
}
