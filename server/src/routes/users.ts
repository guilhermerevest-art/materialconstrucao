import { Router } from 'express';
import { z } from 'zod';
import { currentUser, hashPassword } from '../auth.js';
import type { AppContext } from '../context.js';
import { HttpError } from '../errors.js';
import { parseId } from '../lib/validation.js';

const passwordSchema = z.string().min(8, 'A senha precisa ter pelo menos 8 caracteres.').max(200);

const userFields = {
  name: z.string().trim().min(2, 'Informe o nome.').max(120),
  email: z.string().trim().toLowerCase().pipe(z.email('E-mail inválido.')),
  role: z.enum(['admin', 'seller'], 'Perfil inválido.'),
  store_id: z.number().int().positive().nullable().default(null),
};

const sellerNeedsStore = (u: { role: string; store_id: number | null }) => u.role === 'admin' || u.store_id !== null;
const SELLER_NEEDS_STORE = { message: 'Selecione a loja do vendedor.', path: ['store_id'] };

const createSchema = z.object({ ...userFields, password: passwordSchema }).refine(sellerNeedsStore, SELLER_NEEDS_STORE);

const updateSchema = z
  .object({
    ...userFields,
    active: z.boolean(),
    // Vazio mantém a senha atual.
    password: z.preprocess((v) => (v === '' || v === null ? undefined : v), passwordSchema.optional()),
  })
  .refine(sellerNeedsStore, SELLER_NEEDS_STORE);

const USER_COLUMNS = `u.id, u.name, u.email, u.role, u.store_id, s.name as store_name, u.active, u.created_at`;
const NOT_FOUND = 'Usuário não encontrado.';

/** Cadastro de vendedores e administradores. Montado só para administradores. */
export function usersRouter(ctx: AppContext) {
  const router = Router();

  router.get('/', async (_req, res) => {
    const { rows } = await ctx.pool.query(
      `select ${USER_COLUMNS} from users u left join stores s on s.id = u.store_id order by u.active desc, u.name`,
    );
    res.json({ items: rows });
  });

  router.post('/', async (req, res) => {
    const body = createSchema.parse(req.body);
    const { rows } = await ctx.pool.query(
      `with inserted as (
         insert into users (name, email, password_hash, role, store_id)
         values ($1, $2, $3, $4, $5)
         returning *)
       select ${USER_COLUMNS} from inserted u left join stores s on s.id = u.store_id`,
      [body.name, body.email, await hashPassword(body.password), body.role, body.store_id],
    );
    res.status(201).json({ user: rows[0] });
  });

  router.put('/:id', async (req, res) => {
    const me = currentUser(req);
    const id = parseId(req.params.id, NOT_FOUND);
    const body = updateSchema.parse(req.body);
    if (id === me.id && (body.role !== 'admin' || !body.active)) {
      throw new HttpError(400, 'Você não pode desativar nem tirar o acesso de administrador da sua própria conta.');
    }
    const passwordHash = body.password ? await hashPassword(body.password) : null;
    // Nova senha ou desativação derrubam as sessões abertas desse usuário.
    const { rows } = await ctx.pool.query(
      `with updated as (
         update users
            set name = $2, email = $3, role = $4, store_id = $5, active = $6,
                password_hash = coalesce($7, password_hash),
                token_version = token_version + case when $7 is not null or (active and not $6) then 1 else 0 end
          where id = $1
          returning *)
       select ${USER_COLUMNS} from updated u left join stores s on s.id = u.store_id`,
      [id, body.name, body.email, body.role, body.store_id, body.active, passwordHash],
    );
    if (!rows[0]) throw new HttpError(404, NOT_FOUND);
    res.json({ user: rows[0] });
  });

  return router;
}
