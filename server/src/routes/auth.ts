import bcrypt from 'bcryptjs';
import { Router, type Request } from 'express';
import type pg from 'pg';
import { z } from 'zod';
import {
  authenticate,
  clearSession,
  currentUser,
  hashPassword,
  issueSession,
  loadAuthUser,
  toPublicUser,
  verifyPassword,
} from '../auth.js';
import type { Config } from '../config.js';
import type { AppContext } from '../context.js';
import { setTenantContext, withSession, withTransaction } from '../db/session.js';
import { HttpError } from '../errors.js';
import { loginLimiter } from '../lib/loginLimiter.js';

// Hash dummy: usado quando a combinação (tenant_slug, username) não existe,
// para que o tempo de resposta seja o mesmo em todos os casos (evita enumeração).
const DUMMY_HASH = bcrypt.hashSync('usuario-inexistente', 10);

const slugSchema = z
  .string()
  .trim()
  .toLowerCase()
  .min(1, 'Informe a lojamestre.')
  .max(32, 'Lojamestre inválida.')
  .regex(/^[a-z0-9-]+$/, 'Lojamestre inválida. Use letras, números e hífen.');

const usernameSchema = z
  .string()
  .trim()
  .toLowerCase()
  .min(1, 'Informe o usuário.')
  .max(32, 'Usuário inválido.');

const loginSchema = z.object({
  tenant_slug: slugSchema,
  username: usernameSchema,
  password: z.string().min(1, 'Informe a senha.'),
});

const GENERIC_LOGIN_ERROR = 'Lojamestre, usuário ou senha incorretos.';

const changePasswordSchema = z.object({
  current_password: z.string().min(1, 'Informe a senha atual.'),
  new_password: z.string().min(8, 'A nova senha precisa ter pelo menos 8 caracteres.').max(200),
});

type LoginCredential = {
  id: number;
  tenant_id: number;
  password_hash: string;
  active: boolean;
  token_version: number;
  tenant_active: boolean;
};

/**
 * Credencial de (lojamestre, usuário). `tenants` não tem RLS; achada a lojamestre,
 * o contexto dela faz o RLS de users mostrar só os usuários dela. Assim o login
 * roda com o usuário comum do banco, sem papel com BYPASSRLS.
 */
async function findLogin(pool: pg.Pool, tenantSlug: string, username: string): Promise<LoginCredential | null> {
  return withTransaction(pool, async (db) => {
    const tenant = await db.query<{ id: number; active: boolean }>(
      'select id, active from tenants where lower(slug) = $1',
      [tenantSlug],
    );
    const found = tenant.rows[0];
    if (!found) return null;
    await setTenantContext(db, found.id);
    const { rows } = await db.query<Omit<LoginCredential, 'tenant_active'>>(
      `select id, tenant_id, password_hash, active, token_version
         from users
        where tenant_id = $1 and lower(username) = $2`,
      [found.id, username],
    );
    return rows[0] ? { ...rows[0], tenant_active: found.active } : null;
  });
}

let warnedInsecureCookie = false;
function warnIfCookieWillBeDropped(req: Request, config: Config) {
  if (config.cookieSecure && !req.secure && !warnedInsecureCookie) {
    warnedInsecureCookie = true;
    console.warn(
      '[aviso] COOKIE_SECURE está ligado, mas o login chegou por HTTP. O navegador vai descartar o cookie de sessão. ' +
        'Sirva a aplicação por HTTPS (com TRUST_PROXY se houver proxy reverso) ou defina COOKIE_SECURE=false.',
    );
  }
}

export function authRouter(ctx: AppContext) {
  const router = Router();

  router.post('/login', async (req, res) => {
    const { tenant_slug, username, password } = loginSchema.parse(req.body);
    const key = `${req.ip}|${tenant_slug}|${username}`;
    if (await loginLimiter.isBlocked(ctx.pool, key)) {
      throw new HttpError(429, 'Muitas tentativas sem sucesso. Aguarde 15 minutos e tente de novo.');
    }

    const found = await findLogin(ctx.pool, tenant_slug, username);
    const valid = await verifyPassword(password, found?.password_hash ?? DUMMY_HASH);
    if (!found || !valid) {
      await loginLimiter.fail(ctx.pool, key);
      throw new HttpError(401, GENERIC_LOGIN_ERROR);
    }
    if (!found.tenant_active) {
      await loginLimiter.fail(ctx.pool, key);
      throw new HttpError(403, 'Esta lojamestre está desativada. Fale com o suporte.');
    }
    if (!found.active) {
      await loginLimiter.fail(ctx.pool, key);
      throw new HttpError(403, 'Este usuário está desativado. Fale com o administrador.');
    }

    await loginLimiter.reset(ctx.pool, key);
    warnIfCookieWillBeDropped(req, ctx.config);
    issueSession(res, ctx.config, found);
    const user = await loadAuthUser(ctx.pool, found.id, found.tenant_id);
    res.json({ user: user && toPublicUser(user) });
  });

  router.post('/logout', (_req, res) => {
    clearSession(res, ctx.config);
    res.status(204).end();
  });

  router.get('/me', authenticate(ctx), (req, res) => {
    res.json({ user: toPublicUser(currentUser(req)) });
  });

  router.post('/change-password', authenticate(ctx), async (req, res) => {
    const user = currentUser(req);
    const body = changePasswordSchema.parse(req.body);
    const result = await withSession(ctx.pool, user, async (db) => {
      const { rows } = await db.query<{ password_hash: string }>('select password_hash from users where id = $1', [
        user.id,
      ]);
      if (!rows[0] || !(await verifyPassword(body.current_password, rows[0].password_hash))) {
        throw new HttpError(400, 'A senha atual está incorreta.');
      }
      // Trocar a senha encerra as sessões abertas em outros computadores; esta recebe um cookie novo.
      const updated = await db.query<{ id: number; tenant_id: number; token_version: number }>(
        `update users set password_hash = $2, token_version = token_version + 1
          where id = $1
          returning id, tenant_id, token_version`,
        [user.id, await hashPassword(body.new_password)],
      );
      return updated.rows[0]!;
    });
    issueSession(res, ctx.config, result);
    res.status(204).end();
  });

  return router;
}