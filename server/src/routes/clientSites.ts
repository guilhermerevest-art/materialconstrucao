import { Router } from 'express';
import type pg from 'pg';
import { z } from 'zod';
import { currentUser, requireAdmin } from '../auth.js';
import type { AppContext } from '../context.js';
import { queryAs, withSession } from '../db/session.js';
import { HttpError } from '../errors.js';
import { normalizeWhatsapp } from '../lib/phone.js';
import { optionalText, parseId } from '../lib/validation.js';

const siteSchema = z.object({
  name: z.string('Dê um nome à obra.').trim().min(2, 'Dê um nome à obra.').max(80, 'Use no máximo 80 caracteres.'),
  address: z.string('Informe o endereço.').trim().min(5, 'Informe o endereço da obra.').max(300, 'Use no máximo 300 caracteres.'),
  contact_name: optionalText(80),
  contact_phone: optionalText(30).transform((value, ctx) => {
    if (value === null) return null;
    const normalized = normalizeWhatsapp(value);
    if (!normalized) {
      ctx.addIssue({ code: 'custom', message: 'Telefone do contato inválido. Informe DDD e número.' });
      return z.NEVER;
    }
    return normalized;
  }),
  notes: optionalText(300),
  active: z.boolean().default(true),
});

const creditSchema = z.object({
  credit_limit: z
    .number('Informe o limite.')
    .min(0, 'O limite não pode ser negativo.')
    .max(99_999_999, 'Limite alto demais.')
    .transform((v) => Math.round(v * 100) / 100)
    .nullable(),
});

const SITE_COLUMNS = `cs.id, cs.client_id, cs.name, cs.address, cs.contact_name, cs.contact_phone, cs.notes, cs.active, cs.created_at,
  (select count(*) from orders o where o.client_site_id = cs.id) as orders_count`;

const NOT_FOUND = 'Obra não encontrada.';
const CLIENT_NOT_FOUND = 'Cliente não encontrado.';

/** Obra do pedido: precisa ser do mesmo cliente. Obra desativada só vale se o pedido já estava com ela. */
export async function assertClientSite(
  db: pg.PoolClient,
  siteId: number | null,
  clientId: number,
  currentSiteId: number | null = null,
) {
  if (siteId === null) return;
  const { rows } = await db.query<{ client_id: number; active: boolean; name: string }>(
    'select client_id, active, name from client_sites where id = $1',
    [siteId],
  );
  const site = rows[0];
  if (!site || site.client_id !== clientId) throw new HttpError(400, 'A obra escolhida não é deste cliente. Escolha de novo.');
  if (!site.active && siteId !== currentSiteId) throw new HttpError(400, `A obra "${site.name}" está desativada.`);
}

/** Obras dos clientes e o limite de crédito. Vendedores cadastram obras; só o admin define o crédito. */
export function clientSitesRouter(ctx: AppContext) {
  const router = Router();

  router.get('/clients/:id/sites', async (req, res) => {
    const clientId = parseId(req.params.id, CLIENT_NOT_FOUND);
    const { rows } = await queryAs(
      ctx.pool,
      currentUser(req),
      `select ${SITE_COLUMNS} from client_sites cs where cs.client_id = $1 order by cs.active desc, lower(cs.name)`,
      [clientId],
    );
    res.json({ items: rows });
  });

  router.post('/clients/:id/sites', async (req, res) => {
    const me = currentUser(req);
    const clientId = parseId(req.params.id, CLIENT_NOT_FOUND);
    const body = siteSchema.parse(req.body);
    const site = await withSession(ctx.pool, me, async (db) => {
      const exists = await db.query('select 1 from clients where id = $1', [clientId]);
      if (!exists.rowCount) throw new HttpError(404, CLIENT_NOT_FOUND);
      const { rows } = await db.query(
        `with inserted as (
           insert into client_sites (tenant_id, client_id, name, address, contact_name, contact_phone, notes, active)
           values ($1, $2, $3, $4, $5, $6, $7, $8) returning *)
         select ${SITE_COLUMNS} from inserted cs`,
        [me.tenant_id, clientId, body.name, body.address, body.contact_name, body.contact_phone, body.notes, body.active],
      );
      return rows[0];
    });
    res.status(201).json({ site });
  });

  router.put('/client-sites/:id', async (req, res) => {
    const id = parseId(req.params.id, NOT_FOUND);
    const body = siteSchema.parse(req.body);
    const { rows } = await queryAs(
      ctx.pool,
      currentUser(req),
      `with updated as (
         update client_sites
            set name = $2, address = $3, contact_name = $4, contact_phone = $5, notes = $6, active = $7
          where id = $1 returning *)
       select ${SITE_COLUMNS} from updated cs`,
      [id, body.name, body.address, body.contact_name, body.contact_phone, body.notes, body.active],
    );
    if (!rows[0]) throw new HttpError(404, NOT_FOUND);
    res.json({ site: rows[0] });
  });

  // Pedidos com a obra continuam com o endereço que foi gravado neles.
  router.delete('/client-sites/:id', async (req, res) => {
    const id = parseId(req.params.id, NOT_FOUND);
    const { rowCount } = await queryAs(ctx.pool, currentUser(req), 'delete from client_sites where id = $1', [id]);
    if (!rowCount) throw new HttpError(404, NOT_FOUND);
    res.status(204).end();
  });

  router.put('/clients/:id/credit', requireAdmin, async (req, res) => {
    const clientId = parseId(req.params.id, CLIENT_NOT_FOUND);
    const body = creditSchema.parse(req.body);
    const { rows } = await queryAs(
      ctx.pool,
      currentUser(req),
      'update clients set credit_limit = $2 where id = $1 returning id, credit_limit',
      [clientId, body.credit_limit],
    );
    if (!rows[0]) throw new HttpError(404, CLIENT_NOT_FOUND);
    res.json({ client: rows[0] });
  });

  return router;
}
