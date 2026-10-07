import bcrypt from 'bcryptjs';
import { Router, type Request } from 'express';
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
import { HttpError } from '../errors.js';
import { loginLimiter } from '../lib/loginLimiter.js';

// Comparar contra um hash qualquer quando o e-mail não existe deixa o tempo de resposta igual.
const DUMMY_HASH = bcrypt.hashSync('usuario-inexistente', 10);

const loginSchema = z.object({
  email: z.string().trim().toLowerCase().min(1, 'Informe o e-mail.'),
  password: z.string().min(1, 'Informe a senha.'),
});

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
    const { email, password } = loginSchema.parse(req.body);
    const key = `${req.ip}|${email}`;
    if (await loginLimiter.isBlocked(ctx.pool, key)) {
      throw new HttpError(429, 'Muitas tentativas sem sucesso. Aguarde 15 minutos e tente de novo.');
    }

    const { rows } = await ctx.pool.query<{ id: number; password_hash: string; active: boolean; token_version: number }>(
      'select id, password_hash, active, token_version from users where lower(email) = $1',
      [email],
    );
    const found = rows[0];
    const valid = await verifyPassword(password, found?.password_hash ?? DUMMY_HASH);
    if (!found || !valid) {
      await loginLimiter.fail(ctx.pool, key);
      throw new HttpError(401, 'E-mail ou senha incorretos.');
    }
    if (!found.active) throw new HttpError(403, 'Este usuário está desativado. Fale com o administrador.');

    await loginLimiter.reset(ctx.pool, key);
    warnIfCookieWillBeDropped(req, ctx.config);
    issueSession(res, ctx.config, found);
    const user = await loadAuthUser(ctx.pool, found.id);
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
    const { rows } = await ctx.pool.query<{ password_hash: string }>('select password_hash from users where id = $1', [
      user.id,
    ]);
    if (!rows[0] || !(await verifyPassword(body.current_password, rows[0].password_hash))) {
      throw new HttpError(400, 'A senha atual está incorreta.');
    }
    // Trocar a senha encerra as sessões abertas em outros computadores; esta recebe um cookie novo.
    const updated = await ctx.pool.query<{ id: number; token_version: number }>(
      `update users set password_hash = $2, token_version = token_version + 1
        where id = $1
        returning id, token_version`,
      [user.id, await hashPassword(body.new_password)],
    );
    issueSession(res, ctx.config, updated.rows[0]!);
    res.status(204).end();
  });

  return router;
}
