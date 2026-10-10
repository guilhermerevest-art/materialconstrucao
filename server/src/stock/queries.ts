import type pg from 'pg';
import type { SessionUser } from '../db/session.js';

export type StockKind = 'entry' | 'sale' | 'sale_cancel' | 'adjustment' | 'transfer_out' | 'transfer_in' | 'return';

export type StockChange = {
  store_id: number;
  product_id: number;
  /** Com sinal: entrada positiva, saída negativa. */
  quantity: number;
  kind: StockKind;
  order_id?: number | null;
  entry_id?: number | null;
  other_store_id?: number | null;
  unit_cost?: number | null;
  note?: string | null;
};

const round3 = (value: number) => Math.round(value * 1000) / 1000;

/**
 * Junta as mudanças do mesmo produto na mesma loja (a nota pode trazer o mesmo item
 * em duas linhas): o upsert do saldo não pode tocar a mesma linha duas vezes.
 * O custo vira a média ponderada pelas quantidades.
 */
function mergeChanges(changes: StockChange[]): StockChange[] {
  const merged = new Map<string, StockChange & { costWeight: number }>();
  for (const change of changes) {
    const key = `${change.store_id}:${change.product_id}`;
    const current = merged.get(key);
    if (current && current.kind !== change.kind) {
      throw new Error(`Movimentos de tipos diferentes para o mesmo produto na mesma loja: ${key}`);
    }
    const weight = change.unit_cost != null ? Math.abs(change.quantity) : 0;
    if (!current) {
      merged.set(key, { ...change, costWeight: weight });
      continue;
    }
    const totalWeight = current.costWeight + weight;
    if (change.unit_cost != null) {
      current.unit_cost =
        totalWeight > 0 ? ((current.unit_cost ?? 0) * current.costWeight + change.unit_cost * weight) / totalWeight : change.unit_cost;
    }
    current.costWeight = totalWeight;
    current.quantity = round3(current.quantity + change.quantity);
  }
  return [...merged.values()].filter((c) => c.quantity !== 0).map(({ costWeight: _, ...c }) => c);
}

/**
 * Aplica as mudanças de estoque: soma no saldo de cada loja e grava o extrato com o
 * saldo depois de cada uma. O upsert é atômico por linha, então duas vendas ao mesmo
 * tempo não perdem baixa.
 */
export async function applyStockChanges(db: pg.PoolClient, user: SessionUser, changes: StockChange[]) {
  const rows = mergeChanges(changes);
  if (!rows.length) return;
  await db.query(
    `with c as (
       select * from unnest($2::bigint[], $3::bigint[], $4::numeric[], $5::text[], $6::bigint[], $7::bigint[],
                            $8::bigint[], $9::numeric[], $10::text[])
         as c(store_id, product_id, quantity, kind, order_id, entry_id, other_store_id, unit_cost, note)
     ), upserted as (
       insert into stock_balances (tenant_id, store_id, product_id, quantity)
       select $1, store_id, product_id, quantity from c
       on conflict (store_id, product_id)
       do update set quantity = stock_balances.quantity + excluded.quantity, updated_at = now()
       returning store_id, product_id, quantity
     )
     insert into stock_movements (tenant_id, store_id, product_id, kind, quantity, balance_after, unit_cost,
                                  order_id, entry_id, other_store_id, user_id, note)
     select $1, c.store_id, c.product_id, c.kind, c.quantity, u.quantity, c.unit_cost,
            c.order_id, c.entry_id, c.other_store_id, $11, c.note
       from c join upserted u on u.store_id = c.store_id and u.product_id = c.product_id`,
    [
      user.tenant_id,
      rows.map((r) => r.store_id),
      rows.map((r) => r.product_id),
      rows.map((r) => r.quantity),
      rows.map((r) => r.kind),
      rows.map((r) => r.order_id ?? null),
      rows.map((r) => r.entry_id ?? null),
      rows.map((r) => r.other_store_id ?? null),
      rows.map((r) => (r.unit_cost == null ? null : Math.round(r.unit_cost * 10_000) / 10_000)),
      rows.map((r) => r.note ?? null),
      user.id,
    ],
  );
}

/** Baixa do estoque da loja do pedido, na confirmação. Produto que não controla estoque fica de fora. */
export async function applyOrderStock(db: pg.PoolClient, orderId: number, user: SessionUser) {
  const { rows } = await db.query<{ store_id: number; product_id: number; quantity: number }>(
    `select o.store_id, i.product_id, sum(i.quantity) as quantity
       from orders o
       join order_items i on i.order_id = o.id
       join products p on p.id = i.product_id
      where o.id = $1 and p.track_stock
      group by o.store_id, i.product_id`,
    [orderId],
  );
  await applyStockChanges(
    db,
    user,
    rows.map((r) => ({ store_id: r.store_id, product_id: r.product_id, quantity: -r.quantity, kind: 'sale', order_id: orderId })),
  );
  await db.query('update orders set stock_applied = true where id = $1', [orderId]);
}

/**
 * Devolve ao estoque o que o pedido baixou. Lê o que saiu no extrato, e não os itens,
 * para devolver exatamente o que foi baixado mesmo se o produto deixou de controlar estoque.
 */
export async function returnOrderStock(db: pg.PoolClient, orderId: number, user: SessionUser, note: string) {
  const { rows } = await db.query<{ store_id: number; product_id: number; quantity: number }>(
    `select store_id, product_id, sum(quantity) as quantity
       from stock_movements
      where order_id = $1 and kind in ('sale', 'sale_cancel')
      group by store_id, product_id
     having sum(quantity) <> 0`,
    [orderId],
  );
  await applyStockChanges(
    db,
    user,
    rows.map((r) => ({
      store_id: r.store_id,
      product_id: r.product_id,
      quantity: -r.quantity,
      kind: 'sale_cancel',
      order_id: orderId,
      note,
    })),
  );
  await db.query('update orders set stock_applied = false where id = $1', [orderId]);
}
