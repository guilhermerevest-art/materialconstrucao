import { Router } from 'express';
import { z } from 'zod';
import type { AppContext } from '../context.js';
import { HttpError } from '../errors.js';
import { optionalText, parseId } from '../lib/validation.js';

const storeSchema = z.object({
  name: z.string().trim().min(2, 'Informe o nome da loja.').max(120),
  address: optionalText(300),
  phone: optionalText(40),
});

const STORE_COLUMNS = `s.id, s.name, s.address, s.phone, s.created_at,
  (select count(*) from users u where u.store_id = s.id and u.active) as users_count`;

const NOT_FOUND = 'Loja não encontrada.';

/** Cadastro de lojas. Montado só para administradores. */
export function storesRouter(ctx: AppContext) {
  const router = Router();

  router.get('/', async (_req, res) => {
    const { rows } = await ctx.pool.query(`select ${STORE_COLUMNS} from stores s order by s.name`);
    res.json({ items: rows });
  });

  router.post('/', async (req, res) => {
    const body = storeSchema.parse(req.body);
    const { rows } = await ctx.pool.query(
      `with inserted as (insert into stores (name, address, phone) values ($1, $2, $3) returning *)
       select ${STORE_COLUMNS} from inserted s`,
      [body.name, body.address, body.phone],
    );
    res.status(201).json({ store: rows[0] });
  });

  router.put('/:id', async (req, res) => {
    const id = parseId(req.params.id, NOT_FOUND);
    const body = storeSchema.parse(req.body);
    const { rows } = await ctx.pool.query(
      `with updated as (update stores set name = $2, address = $3, phone = $4 where id = $1 returning *)
       select ${STORE_COLUMNS} from updated s`,
      [id, body.name, body.address, body.phone],
    );
    if (!rows[0]) throw new HttpError(404, NOT_FOUND);
    res.json({ store: rows[0] });
  });

  router.delete('/:id', async (req, res) => {
    const id = parseId(req.params.id, NOT_FOUND);
    const { rowCount } = await ctx.pool.query('delete from stores where id = $1', [id]);
    if (!rowCount) throw new HttpError(404, NOT_FOUND);
    res.status(204).end();
  });

  return router;
}
