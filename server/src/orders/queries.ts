import type pg from 'pg';
import { HttpError } from '../errors.js';
import type { OrderStatus } from '../lib/format.js';

export type OrderItem = {
  id: number;
  position: number;
  product_id: number;
  product_code: string | null;
  product_name: string;
  unit: string;
  quantity: number;
  unit_price: number;
  subtotal: number;
};

export type OrderDetail = {
  id: number;
  user_id: number;
  store_id: number;
  client_id: number;
  status: OrderStatus;
  total_amount: number;
  notes: string | null;
  confirmed_at: Date | null;
  sent_at: Date | null;
  created_at: Date;
  updated_at: Date;
  client_name: string;
  client_whatsapp: string;
  store_name: string;
  store_address: string | null;
  store_phone: string | null;
  user_name: string;
  items: OrderItem[];
};

export type OrderItemInput = { product_id: number; quantity: number };

/** Pedido com itens. Precisa rodar dentro de withSession: o RLS decide se o pedido é visível. */
export async function loadOrderDetail(db: pg.PoolClient, id: number): Promise<OrderDetail | null> {
  const { rows } = await db.query<Omit<OrderDetail, 'items'>>(
    `select o.id, o.user_id, o.store_id, o.client_id, o.status, o.total_amount, o.notes,
            o.confirmed_at, o.sent_at, o.created_at, o.updated_at,
            c.name as client_name, c.whatsapp as client_whatsapp,
            s.name as store_name, s.address as store_address, s.phone as store_phone,
            u.name as user_name
       from orders o
       join clients c on c.id = o.client_id
       join stores s on s.id = o.store_id
       join users u on u.id = o.user_id
      where o.id = $1`,
    [id],
  );
  const order = rows[0];
  if (!order) return null;
  const items = await db.query<OrderItem>(
    `select id, position, product_id, product_code, product_name, unit, quantity, unit_price, subtotal
       from order_items
      where order_id = $1
      order by position`,
    [id],
  );
  return { ...order, items: items.rows };
}

/**
 * Substitui os itens do pedido e recalcula o total. O preço vem do catálogo,
 * nunca do navegador. Na edição, produtos que já estavam no pedido mantêm o
 * preço da época (previousPrices).
 */
export async function writeOrderItems(
  db: pg.PoolClient,
  orderId: number,
  items: OrderItemInput[],
  previousPrices: Map<number, number> = new Map(),
): Promise<void> {
  const productIds = [...new Set(items.map((i) => i.product_id))];
  const { rows: products } = await db.query<{ id: number; name: string; price: number; active: boolean }>(
    'select id, name, price, active from products where id = any($1::bigint[])',
    [productIds],
  );
  const byId = new Map(products.map((p) => [p.id, p]));

  for (const item of items) {
    const product = byId.get(item.product_id);
    if (!product) {
      throw new HttpError(400, 'Um dos produtos não existe mais. Remova-o do carrinho e tente de novo.');
    }
    if (!product.active && !previousPrices.has(product.id)) {
      throw new HttpError(400, `O produto "${product.name}" está desativado e não pode ser adicionado.`);
    }
  }

  await db.query('delete from order_items where order_id = $1', [orderId]);
  await db.query(
    `insert into order_items (order_id, position, product_id, product_code, product_name, unit, quantity, unit_price)
     select $1, i.position, p.id, p.code, p.name, p.unit, i.quantity, i.unit_price
       from unnest($2::int[], $3::bigint[], $4::numeric[], $5::numeric[]) as i(position, product_id, quantity, unit_price)
       join products p on p.id = i.product_id`,
    [
      orderId,
      items.map((_, index) => index + 1),
      items.map((i) => i.product_id),
      items.map((i) => i.quantity),
      items.map((i) => previousPrices.get(i.product_id) ?? byId.get(i.product_id)!.price),
    ],
  );
  await db.query(
    `update orders
        set total_amount = (select coalesce(sum(subtotal), 0) from order_items where order_id = $1),
            updated_at = now()
      where id = $1`,
    [orderId],
  );
}
