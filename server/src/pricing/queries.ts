import type pg from 'pg';
import { verifyPassword } from '../auth.js';
import type { SessionUser } from '../db/session.js';
import { HttpError } from '../errors.js';

export type PriceSource = 'catalog' | 'list' | 'tier';

export type ResolvedPrice = {
  product_id: number;
  /** Preço que vale para o item. */
  unit_price: number;
  /** Preço do catálogo, para mostrar quanto o cliente ganhou. */
  catalog_price: number;
  source: PriceSource;
  /** Próxima faixa de quantidade, para o vendedor oferecer ("a partir de 50: R$ 36,90"). */
  next_tier: { min_quantity: number; price: number } | null;
};

export type ClientPriceList = { id: number; name: string; adjust_percent: number } | null;

const round2 = (value: number) => Math.round(value * 100) / 100;

/** Tabela de preço ativa do cliente, se tiver. */
export async function loadClientPriceList(db: pg.PoolClient, clientId: number | null): Promise<ClientPriceList> {
  if (!clientId) return null;
  const { rows } = await db.query<{ id: number; name: string; adjust_percent: number }>(
    `select pl.id, pl.name, pl.adjust_percent
       from clients c
       join price_lists pl on pl.id = c.price_list_id and pl.active
      where c.id = $1`,
    [clientId],
  );
  return rows[0] ?? null;
}

/**
 * Preço de cada item: o menor entre o da tabela do cliente (ou o do catálogo, sem tabela) e
 * o da faixa de quantidade alcançada. Sem tabela e sem faixa, é o preço do catálogo.
 */
export async function resolvePrices(
  db: pg.PoolClient,
  priceList: ClientPriceList,
  items: { product_id: number; quantity: number }[],
): Promise<ResolvedPrice[]> {
  const productIds = [...new Set(items.map((i) => i.product_id))];
  if (!productIds.length) return [];
  const { rows: products } = await db.query<{ id: number; price: number; list_price: number | null }>(
    `select p.id, p.price, pli.price as list_price
       from products p
       left join price_list_items pli on pli.product_id = p.id and pli.price_list_id = $2
      where p.id = any($1::bigint[])`,
    [productIds, priceList?.id ?? null],
  );
  const { rows: tiers } = await db.query<{ product_id: number; min_quantity: number; price: number }>(
    `select product_id, min_quantity, price from product_price_tiers
      where product_id = any($1::bigint[]) order by product_id, min_quantity`,
    [productIds],
  );
  const byId = new Map(products.map((p) => [p.id, p]));

  return items.map((item) => {
    const product = byId.get(item.product_id);
    if (!product) return { product_id: item.product_id, unit_price: 0, catalog_price: 0, source: 'catalog', next_tier: null };
    let price = product.price;
    let source: PriceSource = 'catalog';
    if (priceList) {
      price = product.list_price ?? round2(product.price * (1 + priceList.adjust_percent / 100));
      source = 'list';
    }
    const productTiers = tiers.filter((t) => t.product_id === item.product_id);
    const reached = productTiers.filter((t) => t.min_quantity <= item.quantity).at(-1);
    if (reached && reached.price < price) {
      price = reached.price;
      source = 'tier';
    }
    const next = productTiers.find((t) => t.min_quantity > item.quantity && t.price < price);
    return {
      product_id: item.product_id,
      unit_price: price,
      catalog_price: product.price,
      source: price === product.price && source === 'list' ? 'catalog' : source,
      next_tier: next ? { min_quantity: next.min_quantity, price: next.price } : null,
    };
  });
}

/**
 * Preço dos itens ao salvar. Item que já estava no orçamento mantém o preço da época; se a
 * quantidade ou o cliente mudou, fica o menor entre esse e o de agora (nunca aumenta).
 */
export function applyPreviousPrices(
  resolved: ResolvedPrice[],
  items: { product_id: number; quantity: number }[],
  previous: Map<number, { unit_price: number; quantity: number }>,
  sameClient: boolean,
): number[] {
  return items.map((item, index) => {
    const now = resolved[index]!.unit_price;
    const before = previous.get(item.product_id);
    if (!before) return now;
    if (sameClient && before.quantity === item.quantity) return before.unit_price;
    return Math.min(before.unit_price, now);
  });
}

export type DiscountApproval = { username: string; password: string };

/** Limite de desconto do vendedor em %: o dele ou o padrão da loja. Nulo = sem limite. Admin não tem limite. */
export async function discountLimit(db: pg.PoolClient, user: SessionUser): Promise<number | null> {
  if (user.role === 'admin') return null;
  const { rows } = await db.query<{ limit: number | null }>(
    `select coalesce(u.max_discount_percent, st.max_discount_percent) as limit
       from users u
       left join settings st on st.tenant_id = u.tenant_id
      where u.id = $1`,
    [user.id],
  );
  return rows[0]?.limit ?? null;
}

/**
 * Confere o desconto do pedido contra o limite de quem lança. Acima do limite, só com a senha
 * de quem pode liberar (admin ou usuário marcado para liberar, até o limite dele). A liberação
 * fica no pedido; editar sem passar do que já foi liberado não pede de novo.
 */
export async function assertDiscountAllowed(
  db: pg.PoolClient,
  orderId: number,
  user: SessionUser,
  approval: DiscountApproval | null | undefined,
) {
  const { rows } = await db.query<{
    subtotal_amount: number;
    discount_amount: number;
    discount_approved_percent: number | null;
  }>('select subtotal_amount, discount_amount, discount_approved_percent from orders where id = $1', [orderId]);
  const order = rows[0]!;
  if (order.discount_amount <= 0 || order.subtotal_amount <= 0) return;
  const percent = Math.round((order.discount_amount / order.subtotal_amount) * 10000) / 100;
  const limit = await discountLimit(db, user);
  if (limit === null || percent <= limit + 0.001) return;
  if (order.discount_approved_percent !== null && percent <= order.discount_approved_percent + 0.001) return;

  if (!approval) {
    throw new HttpError(
      403,
      `Desconto de ${formatPercent(percent)} passa do seu limite de ${formatPercent(limit)}. Peça para quem pode liberar digitar a senha.`,
      'DISCOUNT_APPROVAL_REQUIRED',
      { limit, requested: percent },
    );
  }

  const { rows: approvers } = await db.query<{
    id: number;
    role: 'admin' | 'seller';
    active: boolean;
    password_hash: string;
    can_approve_discounts: boolean;
    max_discount_percent: number | null;
  }>(
    `select id, role, active, password_hash, can_approve_discounts, max_discount_percent
       from users where lower(username) = lower($1)`,
    [approval.username.trim()],
  );
  const approver = approvers[0];
  const valid = approver?.active && (await verifyPassword(approval.password, approver.password_hash));
  if (!approver || !valid) throw new HttpError(422, 'Usuário ou senha de quem libera estão incorretos.', 'DISCOUNT_APPROVAL_INVALID');
  if (approver.role !== 'admin' && !approver.can_approve_discounts) {
    throw new HttpError(403, 'Este usuário não pode liberar desconto.', 'DISCOUNT_APPROVAL_INVALID');
  }
  if (approver.role !== 'admin' && approver.max_discount_percent !== null && percent > approver.max_discount_percent + 0.001) {
    throw new HttpError(
      403,
      `Este usuário libera até ${formatPercent(approver.max_discount_percent)}. Peça para o administrador.`,
      'DISCOUNT_APPROVAL_INVALID',
    );
  }
  await db.query('update orders set discount_approved_by = $2, discount_approved_percent = $3 where id = $1', [
    orderId,
    approver.id,
    percent,
  ]);
}

function formatPercent(value: number) {
  return `${new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 2 }).format(value)}%`;
}
