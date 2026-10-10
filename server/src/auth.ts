import bcrypt from 'bcryptjs';
import type { Request, RequestHandler, Response } from 'express';
import jwt from 'jsonwebtoken';
import type pg from 'pg';
import type { Config } from './config.js';
import type { AppContext } from './context.js';
import type { Db } from './db/pool.js';
import { setTenantContext, withTransaction, type SessionUser } from './db/session.js';
import { HttpError } from './errors.js';

export const SESSION_COOKIE = 'oms_session';
export const SUPER_SESSION_COOKIE = 'oms_super_session';
const SESSION_TTL_SECONDS = 12 * 60 * 60;
/**
 * Sessão do aparelho que fica com o monitor aberto (a TV do setor). O monitor renova
 * a sessão enquanto consulta, então ela só expira se o aparelho ficar 30 dias sem abrir
 * o monitor. Desativar o usuário ou trocar a senha derruba esta sessão como as outras.
 */
export const MONITOR_SESSION_TTL_SECONDS = 30 * 24 * 60 * 60;
// O monitor consulta a cada 10 s; renovar o cookie uma vez por hora já basta.
const MONITOR_RENEW_EVERY_SECONDS = 60 * 60;
const BCRYPT_ROUNDS = 10;
// Os dois cookies são assinados com o mesmo segredo. O "aud" impede que a sessão
// de um usuário de lojamestre seja aceita como sessão de super admin (e vice-versa).
const USER_AUDIENCE = 'user';
const SUPER_AUDIENCE = 'super';

export type AuthUser = SessionUser & {
  name: string;
  username: string;
  email: string | null;
  store_name: string | null;
  active: boolean;
  token_version: number;
  /** Lojamestre desativada pelo super admin derruba a sessão de todos os usuários dela. */
  tenant_active: boolean;
  /** Financeiro (contas a receber e caixa) ligado na lojamestre. */
  finance_enabled: boolean;
  /** Fiado (caderneta) ligado na lojamestre. */
  fiado_enabled: boolean;
  /** Desconto máximo de quem vende, em %. Nulo = sem limite (admin nunca tem). */
  max_discount_percent: number | null;
};

export type SuperAdmin = {
  id: number;
  email: string;
  active: boolean;
  token_version: number;
};

export const hashPassword = (password: string) => bcrypt.hash(password, BCRYPT_ROUNDS);
export const verifyPassword = (password: string, hash: string) => bcrypt.compare(password, hash);

/** Usuário da sessão. O RLS de users e stores filtra por lojamestre, então a leitura roda no contexto dela. */
export async function loadAuthUser(pool: pg.Pool, id: number, tenantId: number): Promise<AuthUser | null> {
  return withTransaction(pool, async (db) => {
    await setTenantContext(db, tenantId);
    const { rows } = await db.query<AuthUser>(
      `select u.id, u.tenant_id, u.name, u.username, u.email, u.role, u.store_id,
              u.active, u.token_version, s.name as store_name, t.active as tenant_active,
              coalesce(st.finance_enabled, false) as finance_enabled,
              coalesce(st.fiado_enabled, false) as fiado_enabled,
              case when u.role = 'admin' then null else coalesce(u.max_discount_percent, st.max_discount_percent) end
                as max_discount_percent
         from users u
         join tenants t on t.id = u.tenant_id
         left join stores s on s.id = u.store_id
         left join settings st on st.tenant_id = u.tenant_id
        where u.id = $1`,
      [id],
    );
    return rows[0] ?? null;
  });
}

export async function loadSuperAdmin(db: Db, id: number): Promise<SuperAdmin | null> {
  const { rows } = await db.query<SuperAdmin>(
    'select id, email, active, token_version from super_admins where id = $1',
    [id],
  );
  return rows[0] ?? null;
}

export function toPublicUser(user: AuthUser) {
  const { id, name, username, email, role, store_id, store_name, tenant_id, finance_enabled, fiado_enabled, max_discount_percent } = user;
  return { id, tenant_id, name, username, email, role, store_id, store_name, finance_enabled, fiado_enabled, max_discount_percent };
}

export function toPublicSuperAdmin(sa: SuperAdmin) {
  return { id: sa.id, email: sa.email };
}

function issueCookie(
  res: Response,
  name: string,
  secret: string,
  audience: string,
  subject: string,
  claims: Record<string, number>,
  secure: boolean,
  ttlSeconds = SESSION_TTL_SECONDS,
) {
  const token = jwt.sign(claims, secret, {
    subject,
    audience,
    expiresIn: ttlSeconds,
  });
  res.cookie(name, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure,
    maxAge: ttlSeconds * 1000,
    path: '/',
  });
}

export function issueSession(
  res: Response,
  config: Config,
  user: { id: number; tenant_id: number; token_version: number },
  ttlSeconds = SESSION_TTL_SECONDS,
) {
  // tid: a lojamestre do usuário, para a sessão ser lida já no contexto de RLS dela.
  const claims = { tv: user.token_version, tid: user.tenant_id };
  issueCookie(res, SESSION_COOKIE, config.jwtSecret, USER_AUDIENCE, String(user.id), claims, config.cookieSecure, ttlSeconds);
}

/** Estende a sessão para a duração de monitor, no máximo uma vez por hora. Chamar depois do authenticate. */
export function keepMonitorSession(req: Request, res: Response, config: Config) {
  const user = currentUser(req);
  const remaining = (req.sessionExpiresAt ?? 0) - Math.floor(Date.now() / 1000);
  if (remaining > MONITOR_SESSION_TTL_SECONDS - MONITOR_RENEW_EVERY_SECONDS) return;
  issueSession(res, config, user, MONITOR_SESSION_TTL_SECONDS);
}

export function issueSuperSession(res: Response, config: Config, sa: { id: number; token_version: number }) {
  const claims = { tv: sa.token_version };
  issueCookie(res, SUPER_SESSION_COOKIE, config.jwtSecret, SUPER_AUDIENCE, String(sa.id), claims, config.cookieSecure);
}

export function clearSession(res: Response, config: Config) {
  res.clearCookie(SESSION_COOKIE, { httpOnly: true, sameSite: 'lax', secure: config.cookieSecure, path: '/' });
}

export function clearSuperSession(res: Response, config: Config) {
  res.clearCookie(SUPER_SESSION_COOKIE, { httpOnly: true, sameSite: 'lax', secure: config.cookieSecure, path: '/' });
}

const SESSION_EXPIRED = 'Sua sessão expirou. Entre novamente.';

function readSessionToken(token: unknown, secret: string, audience: string): jwt.JwtPayload {
  if (typeof token !== 'string' || token === '') throw new HttpError(401, SESSION_EXPIRED);
  try {
    const decoded = jwt.verify(token, secret, { algorithms: ['HS256'], audience });
    if (typeof decoded === 'string') throw new Error('payload inesperado');
    return decoded;
  } catch {
    throw new HttpError(401, SESSION_EXPIRED);
  }
}

export function authenticate(ctx: AppContext): RequestHandler {
  return async (req, _res, next) => {
    const payload = readSessionToken(req.cookies?.[SESSION_COOKIE], ctx.config.jwtSecret, USER_AUDIENCE);
    const userId = Number(payload.sub);
    const tenantId = Number(payload.tid);
    if (!Number.isSafeInteger(userId) || !Number.isSafeInteger(tenantId)) throw new HttpError(401, SESSION_EXPIRED);

    const user = await loadAuthUser(ctx.pool, userId, tenantId);
    if (!user || !user.active || !user.tenant_active || user.token_version !== payload.tv) {
      throw new HttpError(401, SESSION_EXPIRED);
    }

    req.user = user;
    req.sessionExpiresAt = payload.exp;
    next();
  };
}

export function authenticateSuper(ctx: AppContext): RequestHandler {
  return async (req, _res, next) => {
    const payload = readSessionToken(req.cookies?.[SUPER_SESSION_COOKIE], ctx.config.jwtSecret, SUPER_AUDIENCE);
    const sa = await loadSuperAdmin(ctx.pool, Number(payload.sub));
    if (!sa || !sa.active || sa.token_version !== payload.tv) throw new HttpError(401, SESSION_EXPIRED);
    req.superAdmin = sa;
    next();
  };
}

export const requireAdmin: RequestHandler = (req, _res, next) => {
  if (req.user?.role !== 'admin') throw new HttpError(403, 'Acesso restrito ao administrador.');
  next();
};

export const requireSuperAdmin: RequestHandler = (req, _res, next) => {
  if (!req.superAdmin) throw new HttpError(403, 'Acesso restrito ao super administrador.');
  next();
};

export function currentUser(req: Request): AuthUser {
  if (!req.user) throw new HttpError(401, 'Faça login para continuar.');
  return req.user;
}

export function currentSuperAdmin(req: Request): SuperAdmin {
  if (!req.superAdmin) throw new HttpError(401, 'Faça login para continuar.');
  return req.superAdmin;
}