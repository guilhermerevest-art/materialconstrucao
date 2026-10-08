import { Router } from 'express';
import { z } from 'zod';
import {
  authenticateSuper,
  clearSuperSession,
  currentSuperAdmin,
  hashPassword,
  issueSuperSession,
  loadSuperAdmin,
  toPublicSuperAdmin,
  verifyPassword,
} from '../auth.js';
import type { AppContext } from '../context.js';
import { HttpError } from '../errors.js';
import { setTenantContext, withTransaction } from '../db/session.js';

const slugSchema = z
  .string()
  .trim()
  .toLowerCase()
  .min(2, 'Slug muito curto.')
  .max(32, 'Slug muito longo.')
  .regex(/^[a-z0-9-]+$/, 'Use letras, números e hífen.');

const usernameSchema = z
  .string()
  .trim()
  .toLowerCase()
  .min(3, 'O usuário precisa ter pelo menos 3 caracteres.')
  .max(32, 'Usuário muito longo.')
  .regex(/^[a-z0-9._-]+$/, 'Use letras, números, ponto, hífen ou underline.');

const passwordSchema = z.string().min(8, 'A senha precisa ter pelo menos 8 caracteres.').max(200);

const superLoginSchema = z.object({
  email: z.string().trim().toLowerCase().min(1, 'Informe o e-mail.'),
  password: z.string().min(1, 'Informe a senha.'),
});

const createTenantSchema = z.object({
  slug: slugSchema,
  name: z.string().trim().min(2, 'Informe o nome da lojamestre.').max(120),
  admin_name: z.string().trim().min(2, 'Informe o nome do administrador.').max(120),
  admin_username: usernameSchema,
  admin_password: passwordSchema,
  admin_email: z.string().trim().toLowerCase().pipe(z.email('E-mail inválido.')).optional(),
});

const renameAdminSchema = z.object({
  tenant_id: z.number().int().positive('Lojamestre inválida.'),
  user_id: z.number().int().positive('Usuário inválido.'),
  username: usernameSchema,
});

export function superRouter(ctx: AppContext) {
  const router = Router();

  router.post('/login', async (req, res) => {
    const body = superLoginSchema.parse(req.body);
    const { rows } = await ctx.pool.query<{
      id: number;
      password_hash: string;
      active: boolean;
      token_version: number;
    }>('select id, password_hash, active, token_version from super_admins where lower(email) = $1', [body.email]);
    const found = rows[0];
    if (!found || !(await verifyPassword(body.password, found.password_hash))) {
      throw new HttpError(401, 'E-mail ou senha incorretos.');
    }
    if (!found.active) throw new HttpError(403, 'Esta conta de super administrador está desativada.');
    issueSuperSession(res, ctx.config, found);
    const sa = await loadSuperAdmin(ctx.pool, found.id);
    res.json({ super_admin: sa && toPublicSuperAdmin(sa) });
  });

  router.post('/logout', (_req, res) => {
    clearSuperSession(res, ctx.config);
    res.status(204).end();
  });

  router.get('/me', authenticateSuper(ctx), (req, res) => {
    res.json({ super_admin: toPublicSuperAdmin(currentSuperAdmin(req)) });
  });

  router.use(authenticateSuper(ctx));

  router.get('/tenants', async (_req, res) => {
    const items = await withTransaction(ctx.pool, async (db) => {
      const { rows } = await db.query<{ id: number; slug: string; name: string; active: boolean; created_at: Date }>(
        'select id, slug, name, active, created_at from tenants order by created_at desc',
      );
      // stores e users têm RLS por lojamestre: cada contagem roda no contexto dela.
      const result = [];
      for (const tenant of rows) {
        await setTenantContext(db, tenant.id);
        const counts = await db.query<{ stores_count: number; users_count: number }>(
          'select (select count(*) from stores) as stores_count, (select count(*) from users) as users_count',
        );
        result.push({ ...tenant, ...counts.rows[0]! });
      }
      return result;
    });
    res.json({ items });
  });

  router.post('/tenants', async (req, res) => {
    const body = createTenantSchema.parse(req.body);
    const passwordHash = await hashPassword(body.admin_password);

    const result = await withTransaction(ctx.pool, async (db) => {
      const existing = await db.query('select 1 from tenants where lower(slug) = $1', [body.slug]);
      if (existing.rowCount) throw new HttpError(409, 'Já existe uma lojamestre com esse slug.');
      const tenant = await db.query<{ id: number; slug: string; name: string; created_at: Date }>(
        `insert into tenants (slug, name) values ($1, $2)
         returning id, slug, name, created_at`,
        [body.slug, body.name],
      );
      const tenantId = tenant.rows[0]!.id;
      // users e settings têm RLS por lojamestre: o resto roda no contexto da nova.
      await setTenantContext(db, tenantId);

      // Username precisa ser único no tenant. Como o tenant acabou de ser criado,
      // é sempre único, mas verificamos por segurança.
      const dup = await db.query('select 1 from users where tenant_id = $1 and lower(username) = $2', [
        tenantId,
        body.admin_username,
      ]);
      if (dup.rowCount) throw new HttpError(409, 'Já existe um usuário com esse nome neste lojamestre.');

      const admin = await db.query<{ id: number; username: string }>(
        `insert into users (tenant_id, name, username, email, password_hash, role)
         values ($1, $2, $3, $4, $5, 'admin')
         returning id, username`,
        [tenantId, body.admin_name, body.admin_username, body.admin_email ?? null, passwordHash],
      );

      // Settings zeradas para o lojamestre novo.
      await db.query('insert into settings (tenant_id) values ($1)', [tenantId]);

      return { tenant: tenant.rows[0], admin: admin.rows[0] };
    });

    res.status(201).json(result);
  });

  // Renomeia o admin legado que vinha da v1 (login por email) para username.
  router.post('/rename-admin', async (req, res) => {
    const body = renameAdminSchema.parse(req.body);
    await withTransaction(ctx.pool, async (db) => {
      await setTenantContext(db, body.tenant_id);
      const dup = await db.query(
        `select 1 from users where tenant_id = $1 and id <> $2 and lower(username) = $3`,
        [body.tenant_id, body.user_id, body.username],
      );
      if (dup.rowCount) throw new HttpError(409, 'Já existe um usuário com esse nome neste lojamestre.');
      const { rowCount } = await db.query(
        `update users set username = $3
           where id = $1 and tenant_id = $2`,
        [body.user_id, body.tenant_id, body.username],
      );
      if (!rowCount) throw new HttpError(404, 'Usuário não encontrado.');
    });
    res.status(204).end();
  });

  return router;
}