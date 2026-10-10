import { Router } from 'express';
import type pg from 'pg';
import { z } from 'zod';
import { currentUser, hashPassword } from '../auth.js';
import type { AppContext } from '../context.js';
import { HttpError } from '../errors.js';
import { withSession, queryAs } from '../db/session.js';
import { parseId } from '../lib/validation.js';
import { assertSectorsExist } from './sectors.js';

const passwordSchema = z.string().min(8, 'A senha precisa ter pelo menos 8 caracteres.').max(200);

const usernameSchema = z
  .string()
  .trim()
  .toLowerCase()
  .min(3, 'O usuário precisa ter pelo menos 3 caracteres.')
  .max(32, 'Usuário muito longo.')
  .regex(/^[a-z0-9._-]+$/, 'Use letras, números, ponto, hífen ou underline.');

// Opcional: vazio ou null (o que a tela manda quando o campo fica em branco) vira "sem e-mail".
const emailSchema = z.preprocess(
  (v) => (typeof v === 'string' && v.trim() === '') || v === null ? undefined : v,
  z.string().trim().toLowerCase().pipe(z.email('E-mail inválido.')).optional(),
);

const userFields = {
  name: z.string().trim().min(2, 'Informe o nome.').max(120),
  username: usernameSchema,
  email: emailSchema,
  role: z.enum(['admin', 'seller'], 'Perfil inválido.'),
  store_id: z.number().int().positive().nullable().default(null),
  // Setores do fluxo do pedido: só quem é do setor tira o pedido das etapas dele.
  // Ausente na edição mantém os setores atuais.
  sector_ids: z.array(z.number().int().positive()).max(50).optional(),
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

const USER_COLUMNS = `u.id, u.tenant_id, u.name, u.username, u.email, u.role, u.store_id, s.name as store_name, u.active, u.created_at,
  coalesce((select array_agg(us.sector_id::int order by us.sector_id) from user_sectors us where us.user_id = u.id), '{}') as sector_ids`;

/** Troca os setores do usuário. Roda na mesma transação que salva o usuário. */
async function saveUserSectors(db: pg.PoolClient, tenantId: number, userId: number, sectorIds: number[]) {
  await assertSectorsExist(db, sectorIds);
  await db.query('delete from user_sectors where user_id = $1', [userId]);
  await db.query(
    'insert into user_sectors (user_id, sector_id, tenant_id) select $1, unnest($2::bigint[]), $3',
    [userId, [...new Set(sectorIds)], tenantId],
  );
}

async function loadUser(db: pg.PoolClient, id: number) {
  const { rows } = await db.query(`select ${USER_COLUMNS} from users u left join stores s on s.id = u.store_id where u.id = $1`, [id]);
  return rows[0];
}
const NOT_FOUND = 'Usuário não encontrado.';

/** Cadastro de vendedores e administradores. Montado só para administradores. */
export function usersRouter(ctx: AppContext) {
  const router = Router();

  router.get('/', async (req, res) => {
    const me = currentUser(req);
    const { rows } = await queryAs(ctx.pool, me,
      `select ${USER_COLUMNS} from users u left join stores s on s.id = u.store_id
        where u.tenant_id = $1
        order by u.active desc, u.name`,
      [me.tenant_id],
    );
    res.json({ items: rows });
  });

  router.post('/', async (req, res) => {
    const me = currentUser(req);
    const body = createSchema.parse(req.body);

    const result = await withSession(ctx.pool, me, async (db) => {
      // RLS já bloqueia se o username existir no tenant; essa verificação é
      // só para devolver 409 com mensagem em português em vez do erro genérico
      // do Postgres.
      const dup = await db.query('select 1 from users where lower(username) = $1', [body.username]);
      if (dup.rowCount) throw new HttpError(409, 'Já existe um usuário com esse nome neste lojamestre.');

      const { rows } = await db.query<{ id: number }>(
        `insert into users (tenant_id, name, username, email, password_hash, role, store_id)
         values ($1, $2, $3, $4, $5, $6, $7)
         returning id`,
        [
          me.tenant_id,
          body.name,
          body.username,
          body.email ?? null,
          await hashPassword(body.password),
          body.role,
          body.store_id,
        ],
      );
      const id = rows[0]!.id;
      await saveUserSectors(db, me.tenant_id, id, body.sector_ids ?? []);
      return loadUser(db, id);
    });

    res.status(201).json({ user: result });
  });

  router.put('/:id', async (req, res) => {
    const me = currentUser(req);
    const id = parseId(req.params.id, NOT_FOUND);
    const body = updateSchema.parse(req.body);
    if (id === me.id && (body.role !== 'admin' || !body.active)) {
      throw new HttpError(400, 'Você não pode desativar nem tirar o acesso de administrador da sua própria conta.');
    }
    const passwordHash = body.password ? await hashPassword(body.password) : null;

    const result = await withSession(ctx.pool, me, async (db) => {
      const dup = await db.query('select 1 from users where id <> $1 and lower(username) = $2', [id, body.username]);
      if (dup.rowCount) throw new HttpError(409, 'Já existe um usuário com esse nome neste lojamestre.');

      const { rowCount } = await db.query(
        `update users
            set name = $2, username = $3, email = $4, role = $5, store_id = $6, active = $7,
                password_hash = coalesce($8, password_hash),
                token_version = token_version + case when $8 is not null or (active and not $7) then 1 else 0 end
          where id = $1`,
        [id, body.name, body.username, body.email ?? null, body.role, body.store_id, body.active, passwordHash],
      );
      if (!rowCount) throw new HttpError(404, NOT_FOUND);
      if (body.sector_ids) await saveUserSectors(db, me.tenant_id, id, body.sector_ids);
      return loadUser(db, id);
    });

    res.json({ user: result });
  });

  return router;
}