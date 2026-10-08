import bcrypt from 'bcryptjs';
import type { Request, RequestHandler, Response } from 'express';
import jwt from 'jsonwebtoken';
import type { Config } from './config.js';
import type { AppContext } from './context.js';
import type { Db } from './db/pool.js';
import type { SessionUser } from './db/session.js';
import { HttpError } from './errors.js';

export const SESSION_COOKIE = 'oms_session';
export const SUPER_SESSION_COOKIE = 'oms_super_session';
const SESSION_TTL_SECONDS = 12 * 60 * 60;
const BCRYPT_ROUNDS = 10;

export type AuthUser = SessionUser & {
  name: string;
  username: string;
  email: string | null;
  store_name: string | null;
  active: boolean;
  token_version: number;
};

export type SuperAdmin = {
  id: number;
  email: string;
  active: boolean;
  token_version: number;
};

export const hashPassword = (password: string) => bcrypt.hash(password, BCRYPT_ROUNDS);
export const verifyPassword = (password: string, hash: string) => bcrypt.compare(password, hash);

export async function loadAuthUser(db: Db, id: number): Promise<AuthUser | null> {
  const { rows } = await db.query<AuthUser>(
    `select u.id, u.tenant_id, u.name, u.username, u.email, u.role, u.store_id,
            u.active, u.token_version, s.name as store_name
       from users u
       left join stores s on s.id = u.store_id
      where u.id = $1`,
    [id],
  );
  return rows[0] ?? null;
}

export async function loadSuperAdmin(db: Db, id: number): Promise<SuperAdmin | null> {
  const { rows } = await db.query<SuperAdmin>(
    'select id, email, active, token_version from super_admins where id = $1',
    [id],
  );
  return rows[0] ?? null;
}

export function toPublicUser(user: AuthUser) {
  const { id, name, username, email, role, store_id, store_name, tenant_id } = user;
  return { id, tenant_id, name, username, email, role, store_id, store_name };
}

export function toPublicSuperAdmin(sa: SuperAdmin) {
  return { id: sa.id, email: sa.email };
}

function issueCookie(res: Response, name: string, secret: string, subject: string, tokenVersion: number, secure: boolean) {
  const token = jwt.sign({ tv: tokenVersion }, secret, {
    subject,
    expiresIn: SESSION_TTL_SECONDS,
  });
  res.cookie(name, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure,
    maxAge: SESSION_TTL_SECONDS * 1000,
    path: '/',
  });
}

export function issueSession(res: Response, config: Config, user: { id: number; token_version: number }) {
  issueCookie(res, SESSION_COOKIE, config.jwtSecret, String(user.id), user.token_version, config.cookieSecure);
}

export function issueSuperSession(res: Response, config: Config, sa: { id: number; token_version: number }) {
  issueCookie(res, SUPER_SESSION_COOKIE, config.jwtSecret, String(sa.id), sa.token_version, config.cookieSecure);
}

export function clearSession(res: Response, config: Config) {
  res.clearCookie(SESSION_COOKIE, { httpOnly: true, sameSite: 'lax', secure: config.cookieSecure, path: '/' });
}

export function clearSuperSession(res: Response, config: Config) {
  res.clearCookie(SUPER_SESSION_COOKIE, { httpOnly: true, sameSite: 'lax', secure: config.cookieSecure, path: '/' });
}

const SESSION_EXPIRED = 'Sua sessão expirou. Entre novamente.';

/**
 * Extrai o slug do tenant a partir do subdomínio (ex: `acme.balcao.app.br` →
 * `acme`). Em dev/local, retorna null — o login cai para o campo do form.
 *
 * Aceita `Host: lojista=acme` para forçar o slug em ambientes que não usam
 * subdomínio (curl, testes automatizados).
 */
function tenantFromRequest(req: Request): string | null {
  const headerOverride = req.header('X-Tenant-Slug');
  if (headerOverride) return headerOverride.trim().toLowerCase();

  const host = (req.header('x-forwarded-host') ?? req.header('host') ?? '').toLowerCase().split(':')[0]!;
  if (!host) return null;
  // host = lojamestre.balcao.app.br ou lojamestre.localhost (dev) ou lojamestre.lvh.me
  // host = app.balcao.app.br (raiz) ou localhost (dev) → sem tenant
  const parts = host.split('.');
  if (parts.length < 2) return null;
  // Heurística: se for "localhost" puro, "ip" ou 4 partes tipo "a.b.c.d", não
  // tem subdomínio significativo.
  const first = parts[0]!;
  if (first === 'localhost' || /^\d+$/.test(first)) return null;
  // Ignora subdomínios comuns que não são lojamestre.
  if (first === 'www' || first === 'app') return null;
  return first;
}

export function authenticate(ctx: AppContext): RequestHandler {
  return async (req, _res, next) => {
    const token: unknown = req.cookies?.[SESSION_COOKIE];
    if (typeof token !== 'string' || token === '') throw new HttpError(401, SESSION_EXPIRED);

    let payload: jwt.JwtPayload;
    try {
      const decoded = jwt.verify(token, ctx.config.jwtSecret, { algorithms: ['HS256'] });
      if (typeof decoded === 'string') throw new Error('payload inesperado');
      payload = decoded;
    } catch {
      throw new HttpError(401, SESSION_EXPIRED);
    }

    // O middleware `authenticate` precisa carregar o usuário (incluindo o
// tenant_id) antes de qualquer query autenticada. O pool principal
// respeita RLS, e sem app.user_id / app.tenant_id setados a policy
// users_tenant esconderia a própria linha — usar loginPool evita
// essa corrida contra o RLS. loginPool é o role oms_login (BYPASSRLS,
// sem grants em tabelas), então só pode chamar funções SECURITY DEFINER
// (find_login e load_user_with_store).
const userRes = await ctx.loginPool.query<AuthUser>(
      `select * from load_user_with_store($1)`,
      [Number(payload.sub)],
    );
    const user = userRes.rows[0] ?? null;
    if (!user || !user.active || user.token_version !== payload.tv) throw new HttpError(401, SESSION_EXPIRED);

    // Se o request veio com subdomínio (ex: acme.balcao.app.br) e o usuário
    // logado pertence a OUTRO tenant, recusamos — defesa em profundidade contra
    // sessão "vazada" entre lojamestres. RLS já garante isolamento de dados.
    const subSlug = tenantFromRequest(req);
    if (subSlug) {
      const { rows } = await ctx.pool.query<{ slug: string }>('select slug from tenants where id = $1', [user.tenant_id]);
      if (rows[0]?.slug !== subSlug) throw new HttpError(401, SESSION_EXPIRED);
    }

    req.user = user;
    next();
  };
}

export function authenticateSuper(ctx: AppContext): RequestHandler {
  return async (req, _res, next) => {
    const token: unknown = req.cookies?.[SUPER_SESSION_COOKIE];
    if (typeof token !== 'string' || token === '') throw new HttpError(401, SESSION_EXPIRED);

    let payload: jwt.JwtPayload;
    try {
      const decoded = jwt.verify(token, ctx.config.jwtSecret, { algorithms: ['HS256'] });
      if (typeof decoded === 'string') throw new Error('payload inesperado');
      payload = decoded;
    } catch {
      throw new HttpError(401, SESSION_EXPIRED);
    }

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