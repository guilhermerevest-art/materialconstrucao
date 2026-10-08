import bcrypt from 'bcryptjs';
import { Router, type Request } from 'express';
import { z } from 'zod';
import type { AuthUser } from '../auth.js';
import {
  authenticate,
  clearSession,
  currentUser,
  hashPassword,
  issueSession,
  toPublicUser,
  verifyPassword,
} from '../auth.js';
import type { Config } from '../config.js';
import type { AppContext } from '../context.js';
import { withSession } from '../db/session.js';
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

    const { rows } = await ctx.loginPool.query<{
      id: number;
      password_hash: string;
      active: boolean;
      token_version: number;
      tenant_id: number;
      tenant_slug: string;
      tenant_active: boolean;
    }>(
      // SECURITY DEFINER via role `oms_login`: o pool principal respeita RLS,
      // mas no momento do login ainda não temos app.user_id setado, e a
      // policy users_tenant esconderia qualquer linha. O pool de login é
      // um role dedicado com BYPASSRLS e SEM grants em tabelas — só pode
      // chamar `find_login`, que devolve um único registro (ou zero).
      // `user_active` é o nome da coluna retornada por find_login; o
      // mapeamento (active) preserva a checagem a jusante.
      `select user_id as id, password_hash, user_active as active, token_version,
              tenant_id, tenant_slug, tenant_active
         from find_login($1, $2)`,
      [tenant_slug, username],
    );
    const found = rows[0];
    const valid = await verifyPassword(password, found?.password_hash ?? DUMMY_HASH);
    console.log('[login-debug]', JSON.stringify({ found, valid }));
    if (!found || !found.password_hash || !valid) {
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
    // loadAuthUser rodaria contra o pool principal, mas no momento do login o
// app.user_id ainda não foi setado — o RLS esconderia a própria linha do
// usuário que acabou de autenticar. Usamos a função SECURITY DEFINER
// `load_user_with_store`, que oms_login (BYPASSRLS + sem grants em tabelas)
// pode chamar para obter o mesmo conjunto de campos.
    const userRes = await ctx.loginPool.query<AuthUser>(
      `select * from load_user_with_store($1)`,
      [found.id],
    );
    const user = userRes.rows[0] ?? null;
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
      const updated = await db.query<{ id: number; token_version: number }>(
        `update users set password_hash = $2, token_version = token_version + 1
          where id = $1
          returning id, token_version`,
        [user.id, await hashPassword(body.new_password)],
      );
      return updated.rows[0]!;
    });
    issueSession(res, ctx.config, result);
    res.status(204).end();
  });

  return router;
}