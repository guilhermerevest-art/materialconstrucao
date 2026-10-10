import { Router } from 'express';
import { z } from 'zod';
import { currentUser, requireAdmin } from '../auth.js';
import type { AppContext } from '../context.js';
import { HttpError } from '../errors.js';
import { queryAs, withSession } from '../db/session.js';
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

type ClientRow = { id: number; name: string; whatsapp: string; created_at: Date };

/** Um WhatsApp pertence a um único cliente. ignoreId ignora o próprio cliente na edição. */
async function findWhatsappConflicts(ctx: AppContext, user: { id: number; tenant_id: number; role: 'admin' | 'seller'; store_id: number | null }, whatsapp: string, ignoreId: number | null) {
  const { rows } = await queryAs<ClientRow>(ctx.pool, user,
    `select id, name, whatsapp, created_at
       from clients
      where whatsapp = $1
        and id is distinct from $2
      order by id`,
    [whatsapp, ignoreId],
  );
  return rows;
}

function duplicateWhatsapp(conflicts: ClientRow[]): HttpError {
  return new HttpError(409, 'Este WhatsApp já está cadastrado.', 'whatsapp_duplicado', { conflicts });
}

type SessionUserLike = { id: number; tenant_id: number; role: 'admin' | 'seller'; store_id: number | null };

/**
 * Cadastra ou altera o cliente. A checagem de conflito acima sozinha nao fecha a porta: duas
 * requisicoes simultaneas passam pelas duas antes de uma INSERTar. Quem esbarra no indice unico
 * e convertido no mesmo 409, para o vendedor ver a escolha de cadastro tambem na corrida.
 */
async function writeClient(
  ctx: AppContext,
  me: SessionUserLike,
  save: () => Promise<{ rows: ClientRow[] }>,
  whatsapp: string,
  ignoreId: number | null,
) {
  try {
    return await save();
  } catch (err) {
    if ((err as { code?: string; constraint?: string }).code !== '23505') throw err;
    if ((err as { constraint?: string }).constraint !== 'clients_tenant_whatsapp_key') throw err;
    const conflicts = await findWhatsappConflicts(ctx, me, whatsapp, ignoreId);
    throw conflicts.length ? duplicateWhatsapp(conflicts) : err;
  }
}

/** Clientes são compartilhados por toda a rede. Vendedores cadastram e editam; só o admin exclui. */
export function clientsRouter(ctx: AppContext) {
  const router = Router();

  router.get('/', async (req, res) => {
    const me = currentUser(req);
    const { q, page, page_size } = listSchema.parse(req.query);
    const digits = q?.replace(/\D/g, '') ?? '';
    const { rows } = await queryAs(ctx.pool, me,
      `select id, name, whatsapp, created_at, credit_limit,
              (select count(*) from client_sites cs where cs.client_id = clients.id and cs.active) as sites_count,
              count(*) over () as total_count
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
    const me = currentUser(req);
    const id = parseId(req.params.id, NOT_FOUND);
    const { rows } = await queryAs(ctx.pool, me,
      'select id, name, whatsapp, created_at, credit_limit from clients where id = $1', [id]);
    if (!rows[0]) throw new HttpError(404, NOT_FOUND);
    res.json({ client: rows[0] });
  });

  router.post('/', async (req, res) => {
    const me = currentUser(req);
    const body = clientSchema.parse(req.body);
    const conflicts = await findWhatsappConflicts(ctx, me, body.whatsapp, null);
    if (conflicts.length) throw duplicateWhatsapp(conflicts);
    const { rows } = await writeClient(
      ctx,
      me,
      () =>
        withSession(ctx.pool, me, (db) =>
          db.query(
            'insert into clients (tenant_id, name, whatsapp) values ($1, $2, $3) returning id, name, whatsapp, created_at',
            [me.tenant_id, body.name, body.whatsapp],
          ),
        ),
      body.whatsapp,
      null,
    );
    res.status(201).json({ client: rows[0] });
  });

  router.put('/:id', async (req, res) => {
    const me = currentUser(req);
    const id = parseId(req.params.id, NOT_FOUND);
    const body = clientSchema.parse(req.body);
    const exists = await withSession(ctx.pool, me, (db) =>
      db.query('select 1 from clients where id = $1', [id]),
    );
    if (!exists.rowCount) throw new HttpError(404, NOT_FOUND);

    const conflicts = await findWhatsappConflicts(ctx, me, body.whatsapp, id);
    if (conflicts.length) throw duplicateWhatsapp(conflicts);
    const { rows } = await writeClient(
      ctx,
      me,
      () =>
        withSession(ctx.pool, me, (db) =>
          db.query(
            'update clients set name = $2, whatsapp = $3 where id = $1 returning id, name, whatsapp, created_at',
            [id, body.name, body.whatsapp],
          ),
        ),
      body.whatsapp,
      id,
    );
    if (!rows[0]) throw new HttpError(404, NOT_FOUND);
    res.json({ client: rows[0] });
  });

  router.delete('/:id', requireAdmin, async (req, res) => {
    const me = currentUser(req);
    const id = parseId(req.params.id, NOT_FOUND);
    const { rowCount } = await queryAs(ctx.pool, me, 'delete from clients where id = $1', [id]);
    if (!rowCount) throw new HttpError(404, NOT_FOUND);
    res.status(204).end();
  });

  return router;
}
