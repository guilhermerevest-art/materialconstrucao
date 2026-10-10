import { Router } from 'express';
import type pg from 'pg';
import { z } from 'zod';
import { currentUser, requireAdmin, type AuthUser } from '../auth.js';
import type { AppContext } from '../context.js';
import { queryAs, withSession } from '../db/session.js';
import { HttpError } from '../errors.js';
import { likePattern, optionalQuery, optionalQueryId, optionalText, pagination, parseId } from '../lib/validation.js';
import { loadFinanceSettings } from '../finance/queries.js';
import { purchaseOrderNumber } from '../pdf/purchaseOrderPdf.js';
import { createPayables, receivePurchaseOrder, resolveSupplier } from '../purchases/queries.js';
import { applyStockChanges, type StockChange } from '../stock/queries.js';
import { setPriceReason } from './pricing.js';

const quantity = z
  .number('Informe a quantidade.')
  .positive('A quantidade precisa ser maior que zero.')
  .max(9_999_999, 'Quantidade alta demais.')
  .transform((v) => Math.round(v * 1000) / 1000);

const listSchema = z.object({
  store_id: optionalQueryId,
  q: optionalQuery,
  filter: z.enum(['all', 'below_min', 'negative']).default('all'),
  ...pagination,
});

const adjustmentSchema = z.object({
  store_id: z.number('Selecione a loja.').int().positive(),
  note: optionalText(200),
  items: z
    .array(
      z.object({
        product_id: z.number().int().positive(),
        // Contagem: o saldo passa a ser este número. Acerto: soma (ou subtrai) este número.
        mode: z.enum(['count', 'delta']),
        quantity: z.number('Informe a quantidade.').min(-9_999_999).max(9_999_999),
      }),
    )
    .min(1, 'Informe pelo menos um produto.')
    .max(500),
});

const minSchema = z.object({
  store_id: z.number().int().positive(),
  min_quantity: z.number().min(0, 'O mínimo não pode ser negativo.').max(9_999_999).nullable(),
});

const trackingSchema = z.object({ track_stock: z.boolean() });

const transferSchema = z
  .object({
    from_store_id: z.number('Escolha a loja de origem.').int().positive(),
    to_store_id: z.number('Escolha a loja de destino.').int().positive(),
    note: optionalText(200),
    items: z
      .array(z.object({ product_id: z.number().int().positive(), quantity }))
      .min(1, 'Informe pelo menos um produto.')
      .max(300),
  })
  .refine((t) => t.from_store_id !== t.to_store_id, { message: 'A loja de destino precisa ser outra.', path: ['to_store_id'] });

const digits = (max: number) =>
  z.preprocess(
    (v) => (typeof v === 'string' ? v.replace(/\D/g, '') || null : (v ?? null)),
    z.string().max(max).nullable(),
  );

const entrySchema = z.object({
  store_id: z.number('Selecione a loja.').int().positive(),
  // Fornecedor escolhido na tela; sem ele, vem pelo CNPJ ou pelo nome da nota.
  supplier_id: z.number().int().positive().nullable().default(null),
  purchase_order_id: z.number().int().positive().nullable().default(null),
  supplier_name: optionalText(120),
  supplier_document: digits(14),
  invoice_number: optionalText(20),
  invoice_series: optionalText(5),
  access_key: digits(44).refine((v) => v === null || v.length === 44, 'A chave de acesso tem 44 dígitos.'),
  issued_at: z.iso.datetime({ offset: true }).nullable().default(null),
  total_amount: z.number().min(0).max(999_999_999).nullable().default(null),
  notes: optionalText(300),
  items: z
    .array(
      z.object({
        product_id: z.number('Escolha o produto de cada item.').int().positive('Escolha o produto de cada item.'),
        // Já na unidade da loja (a tela converte pela quantidade por embalagem).
        quantity,
        unit_cost: z.number().min(0).max(9_999_999).nullable().default(null),
        // Para reconhecer o item na próxima nota do mesmo fornecedor.
        supplier_code: optionalText(60),
        factor: z.number().positive().max(100_000).default(1),
        // Novo preço de venda do produto (o sugerido pela margem ou digitado). Nulo mantém.
        new_price: z
          .number()
          .min(0, 'O preço não pode ser negativo.')
          .max(9_999_999_999)
          .transform((v) => Math.round(v * 100) / 100)
          .nullable()
          .default(null),
      }),
    )
    .min(1, 'A entrada precisa de pelo menos um item.')
    .max(500),
  // Duplicatas da nota (ou o vencimento digitado): viram contas a pagar com o financeiro ligado.
  payables: z
    .array(
      z.object({
        due_date: z.iso.date('Informe o vencimento.'),
        amount: z
          .number('Informe o valor da parcela.')
          .positive('O valor da parcela precisa ser maior que zero.')
          .max(999_999_999)
          .transform((v) => Math.round(v * 100) / 100),
        document_number: optionalText(30),
      }),
    )
    .max(60)
    .default([]),
});

const matchSchema = z.object({
  supplier_document: digits(14),
  items: z
    .array(z.object({ code: optionalText(60), ean: optionalText(14), name: optionalText(200), unit: optionalText(10) }))
    .max(500),
});

const NOT_FOUND = 'Produto não encontrado.';

/** Loja da consulta: o admin escolhe (padrão: a dele ou a primeira); o vendedor vê a própria ou outra que pedir. */
async function resolveStore(db: pg.PoolClient, user: AuthUser, requested: number | undefined): Promise<number> {
  const storeId = requested ?? user.store_id;
  if (storeId) {
    const { rowCount } = await db.query('select 1 from stores where id = $1', [storeId]);
    if (!rowCount) throw new HttpError(404, 'Loja não encontrada.');
    return storeId;
  }
  const { rows } = await db.query<{ id: number }>('select id from stores order by name limit 1');
  if (!rows[0]) throw new HttpError(400, 'Cadastre uma loja primeiro.');
  return rows[0].id;
}

async function assertStores(db: pg.PoolClient, ids: number[]) {
  const { rows } = await db.query<{ count: number }>('select count(*) as count from stores where id = any($1::bigint[])', [ids]);
  if (rows[0]!.count !== new Set(ids).size) throw new HttpError(400, 'Loja não encontrada.');
}

/** Produtos que existem na lojamestre e controlam estoque. */
async function assertStockProducts(db: pg.PoolClient, ids: number[]) {
  const { rows } = await db.query<{ id: number; name: string; track_stock: boolean }>(
    'select id, name, track_stock from products where id = any($1::bigint[])',
    [ids],
  );
  if (rows.length !== new Set(ids).size) throw new HttpError(400, 'Um dos produtos não existe mais. Atualize a página.');
  const untracked = rows.find((p) => !p.track_stock);
  if (untracked) throw new HttpError(400, `O produto "${untracked.name}" não controla estoque.`);
}

/**
 * Estoque por loja. Todos consultam (inclusive o saldo das outras lojas, para dizer
 * ao cliente onde tem); ajustar, transferir e lançar nota é do administrador.
 */
export function stockRouter(ctx: AppContext) {
  const router = Router();

  router.get('/', async (req, res) => {
    const user = currentUser(req);
    const query = listSchema.parse(req.query);
    const result = await withSession(ctx.pool, user, async (db) => {
      const storeId = await resolveStore(db, user, query.store_id);
      // A entregar: vendido (o estoque já baixou) e ainda não retirado nem entregue.
      // Continua na prateleira, então o físico é o saldo mais isso.
      const { rows } = await db.query(
        `with to_deliver as (
           select i.product_id, sum(i.quantity - coalesce(dv.delivered, 0)) as quantity
             from orders o
             join order_items i on i.order_id = o.id
             left join lateral (
               select sum(di.quantity) as delivered
                 from delivery_items di join deliveries d on d.id = di.delivery_id
                where di.order_item_id = i.id and d.status = 'done'
             ) dv on true
            where o.store_id = $1 and o.status = 'order' and o.delivery_tracking
            group by i.product_id
         )
         select p.id, p.code, p.name, p.unit, p.price, p.cost_price, p.track_stock,
                coalesce(b.quantity, 0) as quantity, b.min_quantity,
                coalesce(td.quantity, 0) as to_deliver,
                count(*) over () as total_count
           from products p
           left join stock_balances b on b.product_id = p.id and b.store_id = $1
           left join to_deliver td on td.product_id = p.id
          where p.active
            and ($2::text is null or lower(p.code) = lower($2) or search_norm(p.name) like search_norm($3)
                 or search_norm(p.code) like search_norm($3))
            and ($4 = 'all'
                 or ($4 = 'below_min' and p.track_stock and b.min_quantity is not null and coalesce(b.quantity, 0) < b.min_quantity)
                 or ($4 = 'negative' and p.track_stock and coalesce(b.quantity, 0) < 0))
          order by p.track_stock desc, p.name, p.id
          limit $5 offset $6`,
        [storeId, query.q ?? null, query.q ? likePattern(query.q) : null, query.filter, query.page_size, (query.page - 1) * query.page_size],
      );
      const summary = await db.query(
        `select count(*) filter (where b.min_quantity is not null and b.quantity < b.min_quantity) as below_min,
                count(*) filter (where b.quantity < 0) as negative
           from stock_balances b
           join products p on p.id = b.product_id
          where b.store_id = $1 and p.active and p.track_stock`,
        [storeId],
      );
      return { storeId, rows, summary: summary.rows[0] };
    });
    res.json({
      store_id: result.storeId,
      summary: result.summary,
      items: result.rows.map(({ total_count: _, ...row }) => row),
      total: result.rows[0]?.total_count ?? 0,
      page: query.page,
      page_size: query.page_size,
    });
  });

  /** Saldo do produto em todas as lojas e o extrato da loja escolhida. */
  router.get('/products/:id', async (req, res) => {
    const user = currentUser(req);
    const id = parseId(req.params.id, NOT_FOUND);
    const { store_id } = z.object({ store_id: optionalQueryId }).parse(req.query);
    const data = await withSession(ctx.pool, user, async (db) => {
      const storeId = await resolveStore(db, user, store_id);
      const product = await db.query(
        'select id, code, name, unit, price, cost_price, track_stock from products where id = $1',
        [id],
      );
      if (!product.rows[0]) throw new HttpError(404, NOT_FOUND);
      const balances = await db.query(
        `select s.id as store_id, s.name as store_name, coalesce(b.quantity, 0) as quantity, b.min_quantity
           from stores s
           left join stock_balances b on b.store_id = s.id and b.product_id = $1
          order by s.name`,
        [id],
      );
      const movements = await db.query(
        `select m.id, m.kind, m.quantity, m.balance_after, m.unit_cost, m.order_id, m.entry_id, m.note, m.created_at,
                u.name as user_name, os.name as other_store_name,
                e.supplier_name, e.invoice_number
           from stock_movements m
           join users u on u.id = m.user_id
           left join stores os on os.id = m.other_store_id
           left join stock_entries e on e.id = m.entry_id
          where m.product_id = $1 and m.store_id = $2
          order by m.created_at desc, m.id desc
          limit 100`,
        [id, storeId],
      );
      return { store_id: storeId, product: product.rows[0], balances: balances.rows, movements: movements.rows };
    });
    res.json(data);
  });

  router.post('/adjustments', requireAdmin, async (req, res) => {
    const user = currentUser(req);
    const body = adjustmentSchema.parse(req.body);
    const ids = body.items.map((i) => i.product_id);
    if (new Set(ids).size !== ids.length) throw new HttpError(400, 'O mesmo produto aparece duas vezes no ajuste.');
    const changed = await withSession(ctx.pool, user, async (db) => {
      await assertStores(db, [body.store_id]);
      await assertStockProducts(db, ids);
      // Trava os saldos para a contagem não se perder com uma venda no meio.
      const { rows } = await db.query<{ product_id: number; quantity: number }>(
        `select product_id, quantity from stock_balances
          where store_id = $1 and product_id = any($2::bigint[])
          for update`,
        [body.store_id, ids],
      );
      const current = new Map(rows.map((r) => [r.product_id, r.quantity]));
      const changes: StockChange[] = body.items.map((item) => ({
        store_id: body.store_id,
        product_id: item.product_id,
        quantity: Math.round((item.mode === 'count' ? item.quantity - (current.get(item.product_id) ?? 0) : item.quantity) * 1000) / 1000,
        kind: 'adjustment',
        note: body.note ?? (item.mode === 'count' ? 'Contagem' : 'Acerto'),
      }));
      await applyStockChanges(db, user, changes);
      return changes.filter((c) => c.quantity !== 0).length;
    });
    res.json({ changed });
  });

  router.put('/products/:id/min', requireAdmin, async (req, res) => {
    const user = currentUser(req);
    const id = parseId(req.params.id, NOT_FOUND);
    const body = minSchema.parse(req.body);
    await withSession(ctx.pool, user, async (db) => {
      await assertStores(db, [body.store_id]);
      await assertStockProducts(db, [id]);
      await db.query(
        `insert into stock_balances (tenant_id, store_id, product_id, min_quantity) values ($1, $2, $3, $4)
         on conflict (store_id, product_id) do update set min_quantity = excluded.min_quantity, updated_at = now()`,
        [user.tenant_id, body.store_id, id, body.min_quantity],
      );
    });
    res.status(204).end();
  });

  router.put('/products/:id/tracking', requireAdmin, async (req, res) => {
    const id = parseId(req.params.id, NOT_FOUND);
    const body = trackingSchema.parse(req.body);
    const { rowCount } = await queryAs(ctx.pool, currentUser(req), 'update products set track_stock = $2 where id = $1', [
      id,
      body.track_stock,
    ]);
    if (!rowCount) throw new HttpError(404, NOT_FOUND);
    res.status(204).end();
  });

  router.post('/transfers', requireAdmin, async (req, res) => {
    const user = currentUser(req);
    const body = transferSchema.parse(req.body);
    const ids = body.items.map((i) => i.product_id);
    if (new Set(ids).size !== ids.length) throw new HttpError(400, 'O mesmo produto aparece duas vezes na transferência.');
    await withSession(ctx.pool, user, async (db) => {
      await assertStores(db, [body.from_store_id, body.to_store_id]);
      await assertStockProducts(db, ids);
      const note = body.note ?? 'Transferência entre lojas';
      await applyStockChanges(
        db,
        user,
        body.items.flatMap((item): StockChange[] => [
          {
            store_id: body.from_store_id,
            product_id: item.product_id,
            quantity: -item.quantity,
            kind: 'transfer_out',
            other_store_id: body.to_store_id,
            note,
          },
          {
            store_id: body.to_store_id,
            product_id: item.product_id,
            quantity: item.quantity,
            kind: 'transfer_in',
            other_store_id: body.from_store_id,
            note,
          },
        ]),
      );
    });
    res.status(204).end();
  });

  router.get('/entries', async (req, res) => {
    const user = currentUser(req);
    const query = z.object({ store_id: optionalQueryId, ...pagination }).parse(req.query);
    const { rows } = await queryAs(
      ctx.pool,
      user,
      `select e.id, e.store_id, s.name as store_name, e.supplier_name, e.supplier_document, e.invoice_number,
              e.invoice_series, e.access_key, e.issued_at, e.total_amount, e.created_at, u.name as user_name,
              (select count(*) from stock_movements m where m.entry_id = e.id) as items_count, e.purchase_order_id,
              count(*) over () as total_count
         from stock_entries e
         join stores s on s.id = e.store_id
         join users u on u.id = e.user_id
        where $1::bigint is null or e.store_id = $1
        order by e.created_at desc, e.id desc
        limit $2 offset $3`,
      [query.store_id ?? null, query.page_size, (query.page - 1) * query.page_size],
    );
    res.json({
      items: rows.map(({ total_count: _, ...row }) => row),
      total: rows[0]?.total_count ?? 0,
      page: query.page,
      page_size: query.page_size,
    });
  });

  router.get('/entries/:id', async (req, res) => {
    const user = currentUser(req);
    const id = parseId(req.params.id, 'Entrada não encontrada.');
    const data = await withSession(ctx.pool, user, async (db) => {
      const entry = await db.query(
        `select e.*, s.name as store_name, u.name as user_name
           from stock_entries e join stores s on s.id = e.store_id join users u on u.id = e.user_id
          where e.id = $1`,
        [id],
      );
      if (!entry.rows[0]) throw new HttpError(404, 'Entrada não encontrada.');
      const items = await db.query(
        `select m.product_id, p.code, p.name, p.unit, m.quantity, m.unit_cost
           from stock_movements m join products p on p.id = m.product_id
          where m.entry_id = $1 and m.kind = 'entry'
          order by p.name`,
        [id],
      );
      const payables = await db.query(
        `select id, installment, installments, due_date, amount, paid_amount, status
           from payables where entry_id = $1 and status <> 'cancelled' order by due_date, id`,
        [id],
      );
      return { entry: entry.rows[0], items: items.rows, payables: payables.rows };
    });
    res.json(data);
  });

  /** Sugere o produto da loja para cada item da nota: pelo código no fornecedor, pelo código da loja ou pelo nome. */
  router.post('/entries/match', requireAdmin, async (req, res) => {
    const user = currentUser(req);
    const body = matchSchema.parse(req.body);
    const matches = await withSession(ctx.pool, user, async (db) => {
      const result = [];
      for (const item of body.items) {
        let match: { product_id: number; factor: number; source: string } | null = null;
        if (body.supplier_document && item.code) {
          const { rows } = await db.query<{ product_id: number; factor: number }>(
            `select sp.product_id, sp.factor from supplier_products sp join products p on p.id = sp.product_id
              where sp.supplier_document = $1 and sp.supplier_code = $2 and p.active`,
            [body.supplier_document, item.code],
          );
          if (rows[0]) match = { ...rows[0], source: 'supplier' };
        }
        if (!match) {
          const codes = [item.ean, item.code].filter((c): c is string => Boolean(c) && c !== 'SEM GTIN');
          if (codes.length) {
            const { rows } = await db.query<{ id: number }>(
              'select id from products where active and lower(code) = any($1::text[]) order by id limit 1',
              [codes.map((c) => c.toLowerCase())],
            );
            if (rows[0]) match = { product_id: rows[0].id, factor: 1, source: 'code' };
          }
        }
        if (!match && item.name) {
          const { rows } = await db.query<{ id: number }>(
            'select id from products where active and search_norm(name) = search_norm($1) order by id limit 1',
            [item.name.trim()],
          );
          if (rows[0]) match = { product_id: rows[0].id, factor: 1, source: 'name' };
        }
        result.push(match);
      }
      // Nome, código e unidade para a tela mostrar o produto já escolhido; preço, custo e
      // margem para sugerir o novo preço de venda.
      const ids = [...new Set(result.flatMap((m) => (m ? [m.product_id] : [])))];
      const { rows: products } = await db.query<{
        id: number;
        code: string | null;
        name: string;
        unit: string;
        purchase_unit: string | null;
        purchase_factor: number | null;
      }>(
        `select p.id, p.code, p.name, p.unit, p.price, p.cost_price, p.purchase_unit, p.purchase_factor,
                coalesce(p.markup_percent, st.default_markup_percent) as markup_percent
           from products p
           left join settings st on st.tenant_id = p.tenant_id
          where p.id = any($1::bigint[])`,
        [ids],
      );
      const byId = new Map(products.map((p) => [p.id, p]));
      return result.map((m, index) => {
        if (!m) return null;
        const product = byId.get(m.product_id)!;
        // Sem o vínculo do fornecedor, a nota na unidade de compra do produto (SC) converte pelo fator dele.
        const unit = body.items[index]?.unit?.toUpperCase();
        if (m.source !== 'supplier' && product.purchase_unit && product.purchase_factor && unit === product.purchase_unit) {
          return { ...m, factor: product.purchase_factor, product };
        }
        return { ...m, product };
      });
    });
    res.json({ matches });
  });

  router.post('/entries', requireAdmin, async (req, res) => {
    const user = currentUser(req);
    const body = entrySchema.parse(req.body);
    const entry = await withSession(ctx.pool, user, async (db) => {
      await assertStores(db, [body.store_id]);
      await assertStockProducts(
        db,
        body.items.map((i) => i.product_id),
      );
      if (body.access_key) {
        const { rows } = await db.query<{ id: number; created_at: Date }>(
          'select id, created_at from stock_entries where access_key = $1',
          [body.access_key],
        );
        if (rows[0]) throw new HttpError(409, `Esta nota já deu entrada no estoque (entrada nº ${rows[0].id}).`);
      }
      if (body.payables.length && !(await loadFinanceSettings(db)).enabled) {
        throw new HttpError(409, 'Contas a pagar dependem do financeiro ligado (Configurações → Financeiro).', 'FINANCE_DISABLED');
      }
      const supplier = await resolveSupplier(db, user, body);
      const supplierName = body.supplier_name ?? supplier?.name ?? null;
      const computedTotal = body.items.reduce((sum, i) => sum + i.quantity * (i.unit_cost ?? 0), 0);
      const { rows } = await db.query<{ id: number }>(
        `insert into stock_entries (tenant_id, store_id, user_id, supplier_name, supplier_document, invoice_number,
                                    invoice_series, access_key, issued_at, total_amount, notes, supplier_id, purchase_order_id)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
         returning id`,
        [
          user.tenant_id,
          body.store_id,
          user.id,
          supplierName,
          body.supplier_document ?? supplier?.document ?? null,
          body.invoice_number,
          body.invoice_series,
          body.access_key,
          body.issued_at,
          Math.round((body.total_amount ?? computedTotal) * 100) / 100,
          body.notes,
          supplier?.id ?? null,
          body.purchase_order_id,
        ],
      );
      const entryId = rows[0]!.id;
      if (body.purchase_order_id) await receivePurchaseOrder(db, body.purchase_order_id, body.store_id, body.items);
      if (body.payables.length) {
        await createPayables(db, user, {
          store_id: body.store_id,
          supplier_id: supplier?.id ?? null,
          description: body.invoice_number
            ? `NF ${body.invoice_number}`
            : body.purchase_order_id
              ? `Pedido de compra ${purchaseOrderNumber(body.purchase_order_id)}`
              : `Entrada de estoque nº ${entryId}`,
          category: 'Fornecedor',
          document_number: body.invoice_number,
          entry_id: entryId,
          purchase_order_id: body.purchase_order_id,
          installments: body.payables,
        });
      }
      const note = body.invoice_number ? `NF ${body.invoice_number}${supplierName ? ` - ${supplierName}` : ''}` : body.notes;
      await applyStockChanges(
        db,
        user,
        body.items.map((item) => ({
          store_id: body.store_id,
          product_id: item.product_id,
          quantity: item.quantity,
          kind: 'entry',
          entry_id: entryId,
          unit_cost: item.unit_cost,
          note,
        })),
      );
      // Último custo de compra, na unidade da loja.
      const costs = body.items.filter((i) => i.unit_cost !== null);
      if (costs.length) {
        await db.query(
          `update products p set cost_price = c.cost
             from unnest($1::bigint[], $2::numeric[]) as c(id, cost)
            where p.id = c.id`,
          [costs.map((i) => i.product_id), costs.map((i) => Math.round(i.unit_cost! * 10_000) / 10_000)],
        );
      }
      // Preço de venda atualizado na entrada (fica no histórico de preço com a nota).
      const prices = body.items.filter((i) => i.new_price !== null);
      if (prices.length) {
        await setPriceReason(db, body.invoice_number ? `Entrada da NF ${body.invoice_number}` : `Entrada de estoque nº ${entryId}`);
        await db.query(
          `update products p set price = c.price
             from unnest($1::bigint[], $2::numeric[]) as c(id, price)
            where p.id = c.id`,
          [prices.map((i) => i.product_id), prices.map((i) => i.new_price)],
        );
      }
      const mappings = body.supplier_document ? body.items.filter((i) => i.supplier_code) : [];
      if (mappings.length) {
        await db.query(
          `insert into supplier_products (tenant_id, supplier_document, supplier_code, product_id, factor)
           select distinct on (code) $1, $2, code, product_id, factor
             from unnest($3::text[], $4::bigint[], $5::numeric[]) as m(code, product_id, factor)
           on conflict (tenant_id, supplier_document, supplier_code)
           do update set product_id = excluded.product_id, factor = excluded.factor, updated_at = now()`,
          [
            user.tenant_id,
            body.supplier_document,
            mappings.map((i) => i.supplier_code),
            mappings.map((i) => i.product_id),
            mappings.map((i) => i.factor),
          ],
        );
      }
      return { id: entryId };
    });
    res.status(201).json({ entry });
  });

  return router;
}
