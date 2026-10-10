import { Router } from 'express';
import type pg from 'pg';
import { z } from 'zod';
import { currentUser, requireAdmin } from '../auth.js';
import type { AppContext } from '../context.js';
import { queryAs } from '../db/session.js';
import { HttpError } from '../errors.js';
import { parseId } from '../lib/validation.js';

const sectorSchema = z.object({
  name: z.string().trim().min(2, 'Informe o nome do setor.').max(40, 'Use no máximo 40 caracteres.'),
});

const COLUMNS = `sc.id, sc.name, sc.created_at,
  (select count(*) from user_sectors us join users u on u.id = us.user_id where us.sector_id = sc.id and u.active) as users_count,
  (select count(*) from workflow_stages ws where ws.sector_id = sc.id) as stages_count`;

const NOT_FOUND = 'Setor não encontrado.';

/**
 * Confere que os setores existem na lojamestre. A FK sozinha não basta: a checagem
 * de chave estrangeira ignora o RLS e aceitaria o id de um setor de outra lojamestre.
 */
export async function assertSectorsExist(db: pg.PoolClient, ids: (number | null)[]) {
  const unique = [...new Set(ids.filter((id): id is number => id !== null))];
  if (!unique.length) return;
  const { rows } = await db.query<{ count: number }>('select count(*) as count from sectors where id = any($1::bigint[])', [
    unique,
  ]);
  if (rows[0]!.count !== unique.length) {
    throw new HttpError(400, 'Um dos setores não existe mais. Atualize a página e tente de novo.');
  }
}

/** Setores (Faturamento, Separação, Expedição...). Todos listam (o monitor precisa); só o administrador altera. */
export function sectorsRouter(ctx: AppContext) {
  const router = Router();

  router.get('/', async (req, res) => {
    const { rows } = await queryAs(ctx.pool, currentUser(req), `select ${COLUMNS} from sectors sc order by lower(sc.name)`);
    res.json({ items: rows });
  });

  router.post('/', requireAdmin, async (req, res) => {
    const me = currentUser(req);
    const body = sectorSchema.parse(req.body);
    const { rows } = await queryAs(
      ctx.pool,
      me,
      `with inserted as (insert into sectors (tenant_id, name) values ($1, $2) returning *)
       select ${COLUMNS} from inserted sc`,
      [me.tenant_id, body.name],
    );
    res.status(201).json({ sector: rows[0] });
  });

  router.put('/:id', requireAdmin, async (req, res) => {
    const id = parseId(req.params.id, NOT_FOUND);
    const body = sectorSchema.parse(req.body);
    const { rows } = await queryAs(
      ctx.pool,
      currentUser(req),
      `with updated as (update sectors set name = $2 where id = $1 returning *)
       select ${COLUMNS} from updated sc`,
      [id, body.name],
    );
    if (!rows[0]) throw new HttpError(404, NOT_FOUND);
    res.json({ sector: rows[0] });
  });

  router.delete('/:id', requireAdmin, async (req, res) => {
    const id = parseId(req.params.id, NOT_FOUND);
    const { rowCount } = await queryAs(ctx.pool, currentUser(req), 'delete from sectors where id = $1', [id]);
    if (!rowCount) throw new HttpError(404, NOT_FOUND);
    res.status(204).end();
  });

  return router;
}
