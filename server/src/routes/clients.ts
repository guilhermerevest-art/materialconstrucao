import { Router } from 'express';
import { z } from 'zod';
import { requireAdmin } from '../auth.js';
import type { AppContext } from '../context.js';
import { HttpError } from '../errors.js';
import { normalizeWhatsapp } from '../lib/phone.js';
import { likePattern, optionalQuery, pagination, parseId } from '../lib/validation.js';

const clientSchema = z.object({
  name: z.string().trim().min(2, 'Informe o nome do cliente.').max(150),
  whatsapp: z
    .string('Informe o WhatsApp do cliente.')
    .trim()
    .min(1, 'Informe o WhatsApp do cliente.')
    .transform((value, ctx) => {
      const normalized = normalizeWhatsapp(value);
      if (!normalized) {
        ctx.addIssue({ code: 'custom', message: 'WhatsApp inválido. Informe DDD e número, por exemplo (11) 98765-4321.' });
        return z.NEVER;
      }
      return normalized;
    }),
});

const listSchema = z.object({ q: optionalQuery, ...pagination });

const NOT_FOUND = 'Cliente não encontrado.';

/** Clientes são compartilhados por toda a rede. Vendedores cadastram e editam; só o admin exclui. */
export function clientsRouter(ctx: AppContext) {
  const router = Router();

  router.get('/', async (req, res) => {
    const { q, page, page_size } = listSchema.parse(req.query);
    const digits = q?.replace(/\D/g, '') ?? '';
    const { rows } = await ctx.pool.query(
      `select id, name, whatsapp, created_at, count(*) over () as total_count
         from clients
        where $1::text is null
           or search_norm(name) like search_norm($1)
           or ($2::text is not null and whatsapp like $2)
        order by name, id
        limit $3 offset $4`,
      [q ? likePattern(q) : null, digits.length >= 3 ? likePattern(digits) : null, page_size, (page - 1) * page_size],
    );
    res.json({
      items: rows.map(({ total_count: _, ...row }) => row),
      total: rows[0]?.total_count ?? 0,
      page,
      page_size,
    });
  });

  router.get('/:id', async (req, res) => {
    const id = parseId(req.params.id, NOT_FOUND);
    const { rows } = await ctx.pool.query('select id, name, whatsapp, created_at from clients where id = $1', [id]);
    if (!rows[0]) throw new HttpError(404, NOT_FOUND);
    res.json({ client: rows[0] });
  });

  router.post('/', async (req, res) => {
    const body = clientSchema.parse(req.body);
    const { rows } = await ctx.pool.query(
      'insert into clients (name, whatsapp) values ($1, $2) returning id, name, whatsapp, created_at',
      [body.name, body.whatsapp],
    );
    res.status(201).json({ client: rows[0] });
  });

  router.put('/:id', async (req, res) => {
    const id = parseId(req.params.id, NOT_FOUND);
    const body = clientSchema.parse(req.body);
    const { rows } = await ctx.pool.query(
      'update clients set name = $2, whatsapp = $3 where id = $1 returning id, name, whatsapp, created_at',
      [id, body.name, body.whatsapp],
    );
    if (!rows[0]) throw new HttpError(404, NOT_FOUND);
    res.json({ client: rows[0] });
  });

  router.delete('/:id', requireAdmin, async (req, res) => {
    const id = parseId(req.params.id, NOT_FOUND);
    const { rowCount } = await ctx.pool.query('delete from clients where id = $1', [id]);
    if (!rowCount) throw new HttpError(404, NOT_FOUND);
    res.status(204).end();
  });

  return router;
}
