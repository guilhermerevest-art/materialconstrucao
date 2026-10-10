import { Router } from 'express';
import { z } from 'zod';
import { currentUser, requireAdmin } from '../auth.js';
import type { AppContext } from '../context.js';
import { HttpError } from '../errors.js';
import { queryAs, withSession } from '../db/session.js';
import { likePattern, optionalQuery, optionalQueryId, optionalText, pagination, parseId } from '../lib/validation.js';

const productSchema = z.object({
  code: optionalText(40),
  name: z.string().trim().min(2, 'Informe o nome do produto.').max(200),
  unit: z
    .string('Informe a unidade.')
    .trim()
    .min(1, 'Informe a unidade.')
    .max(10, 'Use no máximo 10 caracteres na unidade.')
    .transform((u) => u.toUpperCase()),
  price: z.number('Informe o preço.').min(0, 'O preço não pode ser negativo.').max(9_999_999_999),
  active: z.boolean().default(true),
});

const listSchema = z.object({
  q: optionalQuery,
  status: z.enum(['active', 'inactive', 'all']).default('active'),
  // Com a loja, cada produto vem com o saldo de estoque dela (o PDV mostra na busca).
  stock_store_id: optionalQueryId,
  ...pagination,
});

const PRODUCT_COLUMNS = 'id, code, name, unit, price, active, created_at';
const NOT_FOUND = 'Produto não encontrado.';

/** Catálogo único da rede. Todos consultam; só o admin altera. */
export function productsRouter(ctx: AppContext) {
  const router = Router();

  router.get('/', async (req, res) => {
    const user = currentUser(req);
    const query = listSchema.parse(req.query);
    // Vendedor só enxerga produtos ativos.
    const status = user.role === 'admin' ? query.status : 'active';
    const { q, page, page_size } = query;
    const { rows } = await queryAs(ctx.pool, user,
      `select ${PRODUCT_COLUMNS}, track_stock,
              case when $6::bigint is not null and track_stock then
                coalesce((select b.quantity from stock_balances b where b.store_id = $6 and b.product_id = products.id), 0)
              end as stock,
              count(*) over () as total_count
         from products
        where ($1::text is null
               or lower(code) = lower($1)
               or search_norm(name) like search_norm($2)
               or search_norm(code) like search_norm($2))
          and ($3::text = 'all' or active = ($3::text = 'active'))
        order by (lower(code) = lower($1)) desc nulls last, name, id
        limit $4 offset $5`,
      [q ?? null, q ? likePattern(q) : null, status, page_size, (page - 1) * page_size, query.stock_store_id ?? null],
    );
    res.json({
      items: rows.map(({ total_count: _, ...row }) => row),
      total: rows[0]?.total_count ?? 0,
      page,
      page_size,
    });
  });

  router.post('/', requireAdmin, async (req, res) => {
    const me = currentUser(req);
    const body = productSchema.parse(req.body);
    const result = await withSession(ctx.pool, me, async (db) => {
      const { rows } = await db.query(
        `insert into products (tenant_id, code, name, unit, price, active)
         values ($1, $2, $3, $4, $5, $6) returning ${PRODUCT_COLUMNS}`,
        [me.tenant_id, body.code, body.name, body.unit, body.price, body.active],
      );
      return rows[0];
    });
    res.status(201).json({ product: result });
  });

  router.put('/:id', requireAdmin, async (req, res) => {
    const me = currentUser(req);
    const id = parseId(req.params.id, NOT_FOUND);
    const body = productSchema.parse(req.body);
    const result = await withSession(ctx.pool, me, async (db) => {
      const { rows } = await db.query(
        `update products set code = $2, name = $3, unit = $4, price = $5, active = $6
          where id = $1
          returning ${PRODUCT_COLUMNS}`,
        [id, body.code, body.name, body.unit, body.price, body.active],
      );
      if (!rows[0]) throw new HttpError(404, NOT_FOUND);
      return rows[0];
    });
    res.json({ product: result });
  });

  router.delete('/:id', requireAdmin, async (req, res) => {
    const me = currentUser(req);
    const id = parseId(req.params.id, NOT_FOUND);
    const { rowCount } = await queryAs(ctx.pool, me, 'delete from products where id = $1', [id]);
    if (!rowCount) throw new HttpError(404, NOT_FOUND);
    res.status(204).end();
  });

  return router;
}
