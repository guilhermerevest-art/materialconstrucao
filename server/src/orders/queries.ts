import type pg from 'pg';
import { HttpError } from '../errors.js';
import type { OrderStatus } from '../lib/format.js';
import { greetingName } from '../lib/greeting.js';
import { applyPreviousPrices, loadClientPriceList, resolvePrices } from '../pricing/queries.js';

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

/** Nome do "Olá, ...!" das mensagens do pedido. */
export function orderGreeting(order: Pick<OrderDetail, 'client_name' | 'client_contact_name' | 'client_person_type'>) {
  return greetingName({ name: order.client_name, contact_name: order.client_contact_name, person_type: order.client_person_type });
}

export type OrderDetail = {
  id: number;
  user_id: number;
  store_id: number;
  client_id: number;
  status: OrderStatus;
  /** Soma dos itens. */
  subtotal_amount: number;
  discount_type: 'percent' | 'amount' | null;
  /** Percentual (10 = 10%) ou valor em reais, conforme discount_type. */
  discount_value: number | null;
  /** Desconto em reais, calculado no servidor. */
  discount_amount: number;
  /** Valor final: subtotal - desconto. */
  total_amount: number;
  notes: string | null;
  delivery_address: string | null;
  /** Obra do cliente escolhida no PDV. */
  client_site_id: number | null;
  client_site_name: string | null;
  payment_method_id: number | null;
  /** Nome da forma de pagamento quando o pedido foi salvo. */
  payment_method_name: string | null;
  confirmed_at: Date | null;
  /** Pedido com saldo a entregar (confirmado depois do controle de entregas). */
  delivery_tracking: boolean;
  sent_at: Date | null;
  created_at: Date;
  updated_at: Date;
  /** Cancelado: o que era antes (orçamento perdido ou pedido cancelado), quando, quem e por quê. */
  cancelled_from: 'quote' | 'order' | null;
  cancelled_at: Date | null;
  cancelled_by_name: string | null;
  cancel_reason: string | null;
  client_name: string;
  client_whatsapp: string;
  /** Com quem falar no cliente (opcional). */
  client_contact_name: string | null;
  /** F (pessoa) ou J (empresa), do cadastro completo. */
  client_person_type: string | null;
  /** Tabela de preço do cliente usada no pedido. */
  price_list_name: string | null;
  /** Desconto acima do limite do vendedor: quem liberou e até quanto. */
  discount_approved_by_name: string | null;
  discount_approved_percent: number | null;
  /** Tipo da forma de pagamento (dinheiro, crediário, fiado...). */
  payment_method_kind: string | null;
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
    `select o.id, o.user_id, o.store_id, o.client_id, o.status,
            o.subtotal_amount, o.discount_type, o.discount_value, o.discount_amount, o.total_amount,
            o.notes, o.delivery_address, o.client_site_id, cs.name as client_site_name,
            o.payment_method_id, o.payment_method_name, o.confirmed_at, o.delivery_tracking, o.sent_at, o.created_at, o.updated_at,
            o.cancelled_from, o.cancelled_at, cu.name as cancelled_by_name, o.cancel_reason,
            c.name as client_name, c.whatsapp as client_whatsapp,
            c.contact_name as client_contact_name, c.person_type as client_person_type,
            o.price_list_name, o.discount_approved_percent, da.name as discount_approved_by_name,
            pmk.kind as payment_method_kind,
            s.name as store_name, s.address as store_address, s.phone as store_phone,
            s.logo_data, s.logo_mime,
            u.name as user_name
       from orders o
       join clients c on c.id = o.client_id
       join stores s on s.id = o.store_id
       join users u on u.id = o.user_id
       left join users cu on cu.id = o.cancelled_by
       left join users da on da.id = o.discount_approved_by
       left join payment_methods pmk on pmk.id = o.payment_method_id
       left join client_sites cs on cs.id = o.client_site_id
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
 * Substitui os itens do pedido e recalcula subtotal, desconto e total, com o
 * desconto que já está gravado no pedido. O preço vem do servidor, nunca do navegador:
 * catálogo, tabela do cliente ou faixa de quantidade (ver resolvePrices). Na edição, o
 * item que já estava no pedido mantém o preço da época (ver applyPreviousPrices).
 */
export async function writeOrderItems(
  db: pg.PoolClient,
  orderId: number,
  items: OrderItemInput[],
  previous: Map<number, { unit_price: number; quantity: number }> = new Map(),
  sameClient = true,
): Promise<void> {
  const previousPrices = new Map([...previous].map(([id, p]) => [id, p.unit_price]));
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

  const { rows: orderRows } = await db.query<{ client_id: number }>('select client_id from orders where id = $1', [orderId]);
  const priceList = await loadClientPriceList(db, orderRows[0]!.client_id);
  const prices = applyPreviousPrices(await resolvePrices(db, priceList, items), items, previous, sameClient);
  await db.query('update orders set price_list_id = $2, price_list_name = $3 where id = $1', [
    orderId,
    priceList?.id ?? null,
    priceList?.name ?? null,
  ]);

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
        prices,
      ],
  );
  const { rows } = await db.query<{ subtotal_amount: number; discount_amount: number }>(
    `with sums as (
       select coalesce(sum(subtotal), 0) as subtotal from order_items where order_id = $1
     ), priced as (
       select s.subtotal,
              case o.discount_type
                when 'percent' then round(s.subtotal * o.discount_value / 100, 2)
                when 'amount' then o.discount_value
                else 0
              end as discount
         from orders o, sums s
        where o.id = $1
     )
     update orders o
        set subtotal_amount = p.subtotal,
            discount_amount = p.discount,
            total_amount = p.subtotal - p.discount,
            updated_at = now()
       from priced p
      where o.id = $1
      returning o.subtotal_amount, o.discount_amount`,
    [orderId],
  );
  const totals = rows[0]!;
  if (totals.discount_amount > totals.subtotal_amount) {
    throw new HttpError(400, 'O desconto não pode ser maior que o valor dos produtos.');
  }
}
