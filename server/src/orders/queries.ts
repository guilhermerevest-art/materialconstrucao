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
  payment_method_id: number | null;
  /** Nome da forma de pagamento quando o pedido foi salvo. */
  payment_method_name: string | null;
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

/** Logo da loja guardada no banco: base64 sem o prefixo "data:" e o tipo da imagem. */
export type StoreLogo = { data: string; mime: string };

/**
 * O que o PDF desenha. A logo não faz parte de OrderDetail de propósito: a mesma
 * função alimenta a resposta JSON da API e a geração do PDF, e a imagem em base64
 * não pode viajar para o navegador a cada `GET /api/orders/:id`.
 */
export type OrderPdfDetail = OrderDetail & { readonly store_logo: StoreLogo | null };

type OrderPdfRow = Omit<OrderPdfDetail, 'items' | 'store_logo'> & {
  logo_data: string | null;
  logo_mime: string | null;
};

export type OrderItemInput = { product_id: number; quantity: number };

function toStoreLogo(data: string | null, mime: string | null): StoreLogo | null {
  return data && mime ? { data, mime } : null;
}

/**
 * Anexa a logo como propriedade não enumerável. O PDF lê `order.store_logo`; o
 * `res.json({ order })` das rotas só enxerga propriedades enumeráveis, então a
 * imagem fica fora da resposta da API sem precisar tratar o caso na rota.
 */
function withStoreLogo(order: OrderDetail, logo: StoreLogo | null): OrderPdfDetail {
  return Object.defineProperty(order, 'store_logo', { value: logo, enumerable: false }) as OrderPdfDetail;
}

/** Pedido com itens. Precisa rodar dentro de withSession: o RLS decide se o pedido é visível. */
export async function loadOrderDetail(db: pg.PoolClient, id: number): Promise<OrderPdfDetail | null> {
  const { rows } = await db.query<OrderPdfRow>(
    `select o.id, o.user_id, o.store_id, o.client_id, o.status, o.total_amount, o.notes,
            o.payment_method_id, o.payment_method_name, o.confirmed_at, o.sent_at, o.created_at, o.updated_at,
            c.name as client_name, c.whatsapp as client_whatsapp,
            s.name as store_name, s.address as store_address, s.phone as store_phone,
            s.logo_data, s.logo_mime,
            u.name as user_name
       from orders o
       join clients c on c.id = o.client_id
       join stores s on s.id = o.store_id
       join users u on u.id = o.user_id
      where o.id = $1`,
    [id],
  );
  const row = rows[0];
  if (!row) return null;
  const items = await db.query<OrderItem>(
    `select id, position, product_id, product_code, product_name, unit, quantity, unit_price, subtotal
       from order_items
      where order_id = $1
      order by position`,
    [id],
  );
  const { logo_data, logo_mime, ...order } = row;
  return withStoreLogo({ ...order, items: items.rows }, toStoreLogo(logo_data, logo_mime));
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
    `insert into order_items (tenant_id, order_id, position, product_id, product_code, product_name, unit, quantity, unit_price)
     select o.tenant_id, $1, i.position, p.id, p.code, p.name, p.unit, i.quantity, i.unit_price
       from unnest($2::int[], $3::bigint[], $4::numeric[], $5::numeric[]) as i(position, product_id, quantity, unit_price)
       join products p on p.id = i.product_id
       join orders o on o.id = $1`,
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
