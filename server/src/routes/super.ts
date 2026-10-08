import { Router } from 'express';
import type pg from 'pg';
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
import { normalizeDomain } from '../lib/tenantDomain.js';

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

// Lista de domínios próprios da lojamestre, já normalizados e sem repetição.
const domainsSchema = z
  .array(z.string())
  .max(20, 'No máximo 20 domínios por lojamestre.')
  .transform((list, ctx) => {
    const domains = new Set<string>();
    for (const raw of list) {
      if (!raw.trim()) continue;
      const domain = normalizeDomain(raw);
      if (!domain) {
        ctx.addIssue({ code: 'custom', message: `Domínio inválido: ${raw.trim()}` });
        return z.NEVER;
      }
      domains.add(domain);
    }
    return [...domains];
  });

const createTenantSchema = z.object({
  slug: slugSchema,
  name: z.string().trim().min(2, 'Informe o nome da lojamestre.').max(120),
  admin_name: z.string().trim().min(2, 'Informe o nome do administrador.').max(120),
  admin_username: usernameSchema,
  admin_password: passwordSchema,
  admin_email: z.string().trim().toLowerCase().pipe(z.email('E-mail inválido.')).optional(),
  domains: domainsSchema.optional(),
});

const updateTenantSchema = z.object({
  slug: slugSchema,
  name: z.string().trim().min(2, 'Informe o nome da lojamestre.').max(120),
  active: z.boolean(),
  domains: domainsSchema,
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
      const { rows } = await db.query<{
        id: number;
        slug: string;
        name: string;
        active: boolean;
        created_at: Date;
        domains: string[];
      }>(
        `select t.id, t.slug, t.name, t.active, t.created_at,
                coalesce(array_agg(d.domain order by d.domain) filter (where d.id is not null), '{}') as domains
           from tenants t
           left join tenant_domains d on d.tenant_id = t.id
          group by t.id
          order by t.created_at desc`,
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
      await saveDomains(db, tenantId, body.domains ?? []);

      return { tenant: tenant.rows[0], admin: admin.rows[0] };
    });

    res.status(201).json(result);
  });

  // Edita nome, slug, situação e domínios. A lista de domínios enviada substitui a atual.
  router.put('/tenants/:id', async (req, res) => {
    const tenantId = z.coerce.number().int().positive().parse(req.params.id);
    const body = updateTenantSchema.parse(req.body);
    const tenant = await withTransaction(ctx.pool, async (db) => {
      const found = await db.query('select 1 from tenants where id = $1', [tenantId]);
      if (!found.rowCount) throw new HttpError(404, 'Lojamestre não encontrada.');
      const dup = await db.query('select 1 from tenants where lower(slug) = $1 and id <> $2', [body.slug, tenantId]);
      if (dup.rowCount) throw new HttpError(409, 'Já existe uma lojamestre com esse slug.');
      const { rows } = await db.query<{ id: number; slug: string; name: string; active: boolean }>(
        `update tenants set slug = $2, name = $3, active = $4
          where id = $1
          returning id, slug, name, active`,
        [tenantId, body.slug, body.name, body.active],
      );
      await db.query('delete from tenant_domains where tenant_id = $1', [tenantId]);
      await saveDomains(db, tenantId, body.domains);
      return { ...rows[0]!, domains: body.domains };
    });
    res.json({ tenant });
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
async function saveDomains(db: pg.PoolClient, tenantId: number, domains: string[]) {
  for (const domain of domains) {
    const taken = await db.query<{ name: string }>(
      `select t.name from tenant_domains d join tenants t on t.id = d.tenant_id
        where lower(d.domain) = $1 and d.tenant_id <> $2`,
      [domain, tenantId],
    );
    if (taken.rowCount) {
      throw new HttpError(409, `O domínio ${domain} já está na lojamestre "${taken.rows[0]!.name}".`);
    }
    await db.query('insert into tenant_domains (tenant_id, domain) values ($1, $2)', [tenantId, domain]);
  }
}
