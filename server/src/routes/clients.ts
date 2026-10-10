import { Router } from 'express';
import { z } from 'zod';
import { currentUser, requireAdmin } from '../auth.js';
import type { AppContext } from '../context.js';
import { HttpError } from '../errors.js';
import { queryAs, withSession } from '../db/session.js';
import { normalizeWhatsapp } from '../lib/phone.js';
import { likePattern, optionalQuery, optionalText, pagination, parseId } from '../lib/validation.js';
import { clientDetailsSchema, type ClientDetailsInput } from '../fiscal/validation.js';

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
  // Com quem falar (vai no "Olá" das mensagens). Ausente, mantém o que está salvo.
  contact_name: optionalText(80).optional(),
  // Tabela de preço (só o admin muda). Ausente, mantém; nulo, volta ao catálogo.
  price_list_id: z.number().int().positive().nullable().optional(),
  // Aba "Cadastro completo" (dados da NF-e). Ausente, mantém o que está salvo.
  details: clientDetailsSchema.optional(),
});

const DETAIL_COLUMNS = [
  'person_type',
  'document',
  'trade_name',
  'state_registration',
  'ie_indicator',
  'final_consumer',
  'email',
  'phone',
  'address_zip',
  'address_street',
  'address_number',
  'address_complement',
  'address_district',
  'address_city',
  'address_city_code',
  'address_state',
] as const satisfies readonly (keyof ClientDetailsInput)[];

const CLIENT_COLUMNS = `id, name, whatsapp, contact_name, price_list_id, created_at, ${DETAIL_COLUMNS.join(', ')}`;

const listSchema = z.object({ q: optionalQuery, ...pagination });

const NOT_FOUND = 'Cliente não encontrado.';

type ClientRow = { id: number; name: string; whatsapp: string; created_at: Date } & Record<string, unknown>;

/** O cadastro completo vai agrupado em `details`, como a tela edita (aba própria). */
function toClient(row: Record<string, unknown>) {
  const client: Record<string, unknown> = {};
  const details: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) {
    if ((DETAIL_COLUMNS as readonly string[]).includes(key)) details[key] = value;
    else client[key] = value;
  }
  return { ...client, details };
}

/** Colunas e valores a gravar: nome e WhatsApp sempre, o cadastro completo só quando veio. */
function writableColumns(body: z.infer<typeof clientSchema>) {
  const columns: string[] = ['name', 'whatsapp'];
  const values: unknown[] = [body.name, body.whatsapp];
  if (body.contact_name !== undefined) {
    columns.push('contact_name');
    values.push(body.contact_name);
  }
  if (body.price_list_id !== undefined) {
    columns.push('price_list_id');
    values.push(body.price_list_id);
  }
  if (body.details) {
    for (const column of DETAIL_COLUMNS) {
      columns.push(column);
      values.push(body.details[column]);
    }
  }
  return { columns, values };
}

/** Um WhatsApp pertence a um único cliente. ignoreId ignora o próprio cliente na edição. */
async function findWhatsappConflicts(ctx: AppContext, user: { id: number; tenant_id: number; role: 'admin' | 'seller'; store_id: number | null }, whatsapp: string, ignoreId: number | null) {
  // Só o básico: o aviso de duplicado não expõe o cadastro completo de outro cliente.
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

function duplicateWhatsapp(conflicts: unknown[]): HttpError {
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

/** Só o admin põe o cliente numa tabela de preço, e a tabela precisa existir. */
async function assertPriceList(ctx: AppContext, me: SessionUserLike, priceListId: number | null | undefined) {
  if (priceListId === undefined) return;
  if (me.role !== 'admin') throw new HttpError(403, 'Só o administrador muda a tabela de preço do cliente.');
  if (priceListId === null) return;
  const { rowCount } = await queryAs(ctx.pool, me, 'select 1 from price_lists where id = $1', [priceListId]);
  if (!rowCount) throw new HttpError(400, 'Tabela de preço não encontrada.');
}

/** Clientes são compartilhados por toda a rede. Vendedores cadastram e editam; só o admin exclui. */
export function clientsRouter(ctx: AppContext) {
  const router = Router();

  router.get('/', async (req, res) => {
    const me = currentUser(req);
    const { q, page, page_size } = listSchema.parse(req.query);
    const digits = q?.replace(/\D/g, '') ?? '';
    const { rows } = await queryAs(ctx.pool, me,
      `select ${CLIENT_COLUMNS}, credit_limit,
              (select pl.name from price_lists pl where pl.id = clients.price_list_id) as price_list_name,
              (select count(*) from client_sites cs where cs.client_id = clients.id and cs.active) as sites_count,
              count(*) over () as total_count
         from clients
        where $1::text is null
           or search_norm(name) like search_norm($1)
           or search_norm(trade_name) like search_norm($1)
           or ($2::text is not null and (whatsapp like $2 or document like $2))
        order by name, id
        limit $3 offset $4`,
      [q ? likePattern(q) : null, digits.length >= 3 ? likePattern(digits) : null, page_size, (page - 1) * page_size],
    );
    res.json({
      items: rows.map(({ total_count: _, ...row }) => toClient(row)),
      total: rows[0]?.total_count ?? 0,
      page,
      page_size,
    });
  });

  router.get('/:id', async (req, res) => {
    const me = currentUser(req);
    const id = parseId(req.params.id, NOT_FOUND);
    const { rows } = await queryAs(ctx.pool, me, `select ${CLIENT_COLUMNS}, credit_limit from clients where id = $1`, [id]);
    if (!rows[0]) throw new HttpError(404, NOT_FOUND);
    res.json({ client: toClient(rows[0]) });
  });

  router.post('/', async (req, res) => {
    const me = currentUser(req);
    const body = clientSchema.parse(req.body);
    await assertPriceList(ctx, me, body.price_list_id);
    const conflicts = await findWhatsappConflicts(ctx, me, body.whatsapp, null);
    if (conflicts.length) throw duplicateWhatsapp(conflicts);
    const { columns, values } = writableColumns(body);
    const { rows } = await writeClient(
      ctx,
      me,
      () =>
        withSession(ctx.pool, me, (db) =>
          db.query<ClientRow>(
            `insert into clients (tenant_id, ${columns.join(', ')})
             values ($1, ${columns.map((_, i) => `$${i + 2}`).join(', ')})
             returning ${CLIENT_COLUMNS}`,
            [me.tenant_id, ...values],
          ),
        ),
      body.whatsapp,
      null,
    );
    res.status(201).json({ client: toClient(rows[0]!) });
  });

  router.put('/:id', async (req, res) => {
    const me = currentUser(req);
    const id = parseId(req.params.id, NOT_FOUND);
    const body = clientSchema.parse(req.body);
    await assertPriceList(ctx, me, body.price_list_id);
    const exists = await withSession(ctx.pool, me, (db) =>
      db.query('select 1 from clients where id = $1', [id]),
    );
    if (!exists.rowCount) throw new HttpError(404, NOT_FOUND);

    const conflicts = await findWhatsappConflicts(ctx, me, body.whatsapp, id);
    if (conflicts.length) throw duplicateWhatsapp(conflicts);
    const { columns, values } = writableColumns(body);
    const { rows } = await writeClient(
      ctx,
      me,
      () =>
        withSession(ctx.pool, me, (db) =>
          db.query<ClientRow>(
            `update clients set ${columns.map((c, i) => `${c} = $${i + 2}`).join(', ')}
              where id = $1
             returning ${CLIENT_COLUMNS}`,
            [id, ...values],
          ),
        ),
      body.whatsapp,
      id,
    );
    if (!rows[0]) throw new HttpError(404, NOT_FOUND);
    res.json({ client: toClient(rows[0]) });
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
