import { Router } from 'express';
import type pg from 'pg';
import { z } from 'zod';
import { currentUser, requireAdmin } from '../auth.js';
import type { AppContext } from '../context.js';
import { queryAs, withSession } from '../db/session.js';
import { HttpError } from '../errors.js';
import { likePattern, optionalText, parseId } from '../lib/validation.js';

const percent = (label: string, min: number, max: number) =>
  z
    .number(`Informe ${label}.`)
    .min(min, `Use de ${min} a ${max}%.`)
    .max(max, `Use de ${min} a ${max}%.`)
    .transform((v) => Math.round(v * 100) / 100);

const money = z
  .number('Informe o preço.')
  .min(0, 'O preço não pode ser negativo.')
  .max(9_999_999_999)
  .transform((v) => Math.round(v * 100) / 100);

const priceListSchema = z.object({
  name: z.string().trim().min(2, 'Informe o nome da tabela.').max(60),
  adjust_percent: percent('o ajuste', -90, 500),
  active: z.boolean().default(true),
});

const priceListItemsSchema = z.object({
  items: z
    .array(z.object({ product_id: z.number().int().positive(), price: money }))
    .max(5000)
    .refine((items) => new Set(items.map((i) => i.product_id)).size === items.length, 'O mesmo produto aparece duas vezes.'),
});

const productPricingSchema = z.object({
  markup_percent: percent('a margem', 0, 10_000).nullable(),
  tiers: z
    .array(
      z.object({
        min_quantity: z.number('Informe a quantidade.').positive('A quantidade precisa ser maior que zero.').max(999_999),
        price: money,
      }),
    )
    .max(20, 'Use no máximo 20 faixas.')
    .refine((tiers) => new Set(tiers.map((t) => t.min_quantity)).size === tiers.length, 'Duas faixas com a mesma quantidade.'),
});

const ROUNDINGS = ['none', '0.05', '0.10', '0.50', '1.00'] as const;

const adjustSchema = z
  .object({
    // Quais produtos: todos os ativos, os da busca ou os escolhidos.
    q: optionalText(100),
    product_ids: z.array(z.number().int().positive()).max(5000).nullable().default(null),
    // percent: preço atual + X%. markup: custo + margem (a do produto, a padrão ou a informada).
    mode: z.enum(['percent', 'markup'], 'Escolha como reajustar.'),
    percent: z.number().min(-90, 'Use de -90 a 1000%.').max(1000, 'Use de -90 a 1000%.').nullable().default(null),
    rounding: z.enum(ROUNDINGS).default('none'),
    apply: z.boolean().default(false),
  })
  .refine((b) => b.mode === 'markup' || b.percent !== null, { message: 'Informe o percentual do reajuste.', path: ['percent'] });

const salesSettingsSchema = z.object({
  max_discount_percent: percent('o desconto máximo', 0, 100).nullable(),
  default_markup_percent: percent('a margem padrão', 0, 10_000).nullable(),
  // Ausente mantém (telas antigas não mandam).
  default_commission_percent: percent('a comissão padrão', 0, 100).nullable().optional(),
});

/** Arredonda para cima no múltiplo escolhido (preço de prateleira: 12,37 → 12,40). */
export function roundPrice(value: number, rounding: (typeof ROUNDINGS)[number]) {
  const cents = Math.round(value * 100);
  if (rounding === 'none') return cents / 100;
  const step = Math.round(Number(rounding) * 100);
  return (Math.ceil(cents / step) * step) / 100;
}

/** Motivo gravado no histórico de preço pelo gatilho de products (ver migração 020). */
export async function setPriceReason(db: pg.PoolClient, reason: string) {
  await db.query(`select set_config('app.price_reason', $1, true)`, [reason]);
}

const LIST_NOT_FOUND = 'Tabela de preço não encontrada.';
const PRODUCT_NOT_FOUND = 'Produto não encontrado.';

/** Tabelas de preço, faixas por quantidade, margem, reajuste em massa e o padrão da loja. Só o admin. */
export function pricingRouter(ctx: AppContext) {
  const router = Router();
  const { pool } = ctx;

  // ---- Tabelas de preço

  router.get('/price-lists', requireAdmin, async (req, res) => {
    const { rows } = await queryAs(
      pool,
      currentUser(req),
      `select pl.id, pl.name, pl.adjust_percent, pl.active, pl.created_at,
              (select count(*) from clients c where c.price_list_id = pl.id)::int as clients_count,
              (select count(*) from price_list_items i where i.price_list_id = pl.id)::int as items_count
         from price_lists pl
        order by pl.active desc, pl.name`,
    );
    res.json({ items: rows });
  });

  router.post('/price-lists', requireAdmin, async (req, res) => {
    const me = currentUser(req);
    const body = priceListSchema.parse(req.body);
    const { rows } = await queryAs(
      pool,
      me,
      `insert into price_lists (tenant_id, name, adjust_percent, active) values ($1, $2, $3, $4)
       returning id, name, adjust_percent, active, created_at`,
      [me.tenant_id, body.name, body.adjust_percent, body.active],
    );
    res.status(201).json({ price_list: rows[0] });
  });

  router.put('/price-lists/:id', requireAdmin, async (req, res) => {
    const id = parseId(req.params.id, LIST_NOT_FOUND);
    const body = priceListSchema.parse(req.body);
    const { rows } = await queryAs(
      pool,
      currentUser(req),
      `update price_lists set name = $2, adjust_percent = $3, active = $4 where id = $1
       returning id, name, adjust_percent, active, created_at`,
      [id, body.name, body.adjust_percent, body.active],
    );
    if (!rows[0]) throw new HttpError(404, LIST_NOT_FOUND);
    res.json({ price_list: rows[0] });
  });

  // Os clientes da tabela voltam ao preço do catálogo; os pedidos guardam o nome.
  router.delete('/price-lists/:id', requireAdmin, async (req, res) => {
    const id = parseId(req.params.id, LIST_NOT_FOUND);
    const { rowCount } = await queryAs(pool, currentUser(req), 'delete from price_lists where id = $1', [id]);
    if (!rowCount) throw new HttpError(404, LIST_NOT_FOUND);
    res.status(204).end();
  });

  router.get('/price-lists/:id/items', requireAdmin, async (req, res) => {
    const id = parseId(req.params.id, LIST_NOT_FOUND);
    const { rows } = await queryAs(
      pool,
      currentUser(req),
      `select i.product_id, p.code, p.name, p.unit, p.price as catalog_price, i.price
         from price_list_items i
         join products p on p.id = i.product_id
        where i.price_list_id = $1
        order by p.name`,
      [id],
    );
    res.json({ items: rows });
  });

  /** Troca os preços próprios da tabela (os produtos fora dela seguem o ajuste %). */
  router.put('/price-lists/:id/items', requireAdmin, async (req, res) => {
    const me = currentUser(req);
    const id = parseId(req.params.id, LIST_NOT_FOUND);
    const body = priceListItemsSchema.parse(req.body);
    await withSession(pool, me, async (db) => {
      const { rowCount } = await db.query('select 1 from price_lists where id = $1', [id]);
      if (!rowCount) throw new HttpError(404, LIST_NOT_FOUND);
      const ids = body.items.map((i) => i.product_id);
      const { rows: found } = await db.query<{ id: number }>('select id from products where id = any($1::bigint[])', [ids]);
      if (found.length !== ids.length) throw new HttpError(400, 'Um dos produtos não existe mais.');
      await db.query('delete from price_list_items where price_list_id = $1', [id]);
      await db.query(
        `insert into price_list_items (price_list_id, product_id, tenant_id, price)
         select $1, unnest($2::bigint[]), $3, unnest($4::numeric[])`,
        [id, ids, me.tenant_id, body.items.map((i) => i.price)],
      );
    });
    res.status(204).end();
  });

  // ---- Faixas e margem do produto

  router.get('/products/:id/pricing', requireAdmin, async (req, res) => {
    const id = parseId(req.params.id, PRODUCT_NOT_FOUND);
    const data = await withSession(pool, currentUser(req), async (db) => {
      const { rows } = await db.query(
        `select p.id, p.price, p.cost_price, p.markup_percent, st.default_markup_percent
           from products p
           left join settings st on st.tenant_id = p.tenant_id
          where p.id = $1`,
        [id],
      );
      if (!rows[0]) return null;
      const tiers = await db.query(
        'select min_quantity, price from product_price_tiers where product_id = $1 order by min_quantity',
        [id],
      );
      const history = await db.query(
        `select h.old_price, h.new_price, h.reason, h.created_at, u.name as user_name
           from product_price_history h
           left join users u on u.id = h.user_id
          where h.product_id = $1
          order by h.created_at desc, h.id desc
          limit 20`,
        [id],
      );
      return { ...rows[0], tiers: tiers.rows, history: history.rows };
    });
    if (!data) throw new HttpError(404, PRODUCT_NOT_FOUND);
    res.json({ pricing: data });
  });

  router.put('/products/:id/pricing', requireAdmin, async (req, res) => {
    const me = currentUser(req);
    const id = parseId(req.params.id, PRODUCT_NOT_FOUND);
    const body = productPricingSchema.parse(req.body);
    await withSession(pool, me, async (db) => {
      const { rowCount } = await db.query('update products set markup_percent = $2 where id = $1', [id, body.markup_percent]);
      if (!rowCount) throw new HttpError(404, PRODUCT_NOT_FOUND);
      await db.query('delete from product_price_tiers where product_id = $1', [id]);
      if (body.tiers.length) {
        await db.query(
          `insert into product_price_tiers (tenant_id, product_id, min_quantity, price)
           select $1, $2, unnest($3::numeric[]), unnest($4::numeric[])`,
          [me.tenant_id, id, body.tiers.map((t) => t.min_quantity), body.tiers.map((t) => t.price)],
        );
      }
    });
    res.status(204).end();
  });

  // ---- Reajuste em massa

  /**
   * Reajuste por % sobre o preço atual ou pela margem sobre o último custo, com
   * arredondamento. Sem `apply`, só mostra o antes e depois.
   */
  router.post('/products/price-adjust', requireAdmin, async (req, res) => {
    const me = currentUser(req);
    const body = adjustSchema.parse(req.body);
    const result = await withSession(pool, me, async (db) => {
      const { rows } = await db.query<{
        id: number;
        code: string | null;
        name: string;
        unit: string;
        price: number;
        cost_price: number | null;
        markup_percent: number | null;
        default_markup_percent: number | null;
      }>(
        `select p.id, p.code, p.name, p.unit, p.price, p.cost_price, p.markup_percent, st.default_markup_percent
           from products p
           left join settings st on st.tenant_id = p.tenant_id
          where p.active
            and ($1::bigint[] is null or p.id = any($1::bigint[]))
            and ($2::text is null or search_norm(p.name) like search_norm($2) or search_norm(coalesce(p.code, '')) like search_norm($2))
          order by p.name, p.id`,
        [body.product_ids, body.q ? likePattern(body.q) : null],
      );
      const items: { id: number; code: string | null; name: string; unit: string; cost_price: number | null; old_price: number; new_price: number }[] = [];
      let skipped = 0;
      for (const p of rows) {
        let next: number;
        if (body.mode === 'percent') {
          next = p.price * (1 + body.percent! / 100);
        } else {
          const markup = body.percent ?? p.markup_percent ?? p.default_markup_percent;
          if (p.cost_price === null || markup === null) {
            skipped++;
            continue;
          }
          next = p.cost_price * (1 + markup / 100);
        }
        const rounded = roundPrice(Math.max(0, next), body.rounding);
        if (rounded !== p.price) {
          items.push({ id: p.id, code: p.code, name: p.name, unit: p.unit, cost_price: p.cost_price, old_price: p.price, new_price: rounded });
        }
      }
      if (body.apply && items.length) {
        await setPriceReason(
          db,
          body.mode === 'percent' ? `Reajuste de ${body.percent}%` : `Margem sobre o custo${body.percent !== null ? ` (${body.percent}%)` : ''}`,
        );
        await db.query(
          `update products p set price = u.price
             from unnest($1::bigint[], $2::numeric[]) as u(id, price)
            where p.id = u.id`,
          [items.map((i) => i.id), items.map((i) => i.new_price)],
        );
      }
      return { items, count: items.length, skipped, applied: body.apply };
    });
    res.json(result);
  });

  // ---- Padrão da loja

  router.get('/sales-settings', requireAdmin, async (req, res) => {
    const { rows } = await queryAs(
      pool,
      currentUser(req),
      'select max_discount_percent, default_markup_percent, default_commission_percent from settings limit 1',
    );
    res.json({ settings: rows[0] ?? { max_discount_percent: null, default_markup_percent: null, default_commission_percent: null } });
  });

  router.put('/sales-settings', requireAdmin, async (req, res) => {
    const me = currentUser(req);
    const body = salesSettingsSchema.parse(req.body);
    const { rows } = await queryAs(
      pool,
      me,
      `insert into settings (tenant_id, max_discount_percent, default_markup_percent, default_commission_percent)
       values ($1, $2, $3, $5)
       on conflict (tenant_id) do update
          set max_discount_percent = excluded.max_discount_percent,
              default_markup_percent = excluded.default_markup_percent,
              default_commission_percent = case when $4 then excluded.default_commission_percent
                                                else settings.default_commission_percent end,
              updated_at = now()
       returning max_discount_percent, default_markup_percent, default_commission_percent`,
      [
        me.tenant_id,
        body.max_discount_percent,
        body.default_markup_percent,
        body.default_commission_percent !== undefined,
        body.default_commission_percent ?? null,
      ],
    );
    res.json({ settings: rows[0] });
  });

  return router;
}
