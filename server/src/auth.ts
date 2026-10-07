import bcrypt from 'bcryptjs';
import type { Request, RequestHandler, Response } from 'express';
import jwt from 'jsonwebtoken';
import type { Config } from './config.js';
import type { AppContext } from './context.js';
import type { Db } from './db/pool.js';
import type { SessionUser } from './db/session.js';
import { HttpError } from './errors.js';

export const SESSION_COOKIE = 'oms_session';
const SESSION_TTL_SECONDS = 12 * 60 * 60;
const BCRYPT_ROUNDS = 10;

export type AuthUser = SessionUser & {
  name: string;
  email: string;
  store_name: string | null;
  active: boolean;
  token_version: number;
};

export const hashPassword = (password: string) => bcrypt.hash(password, BCRYPT_ROUNDS);
export const verifyPassword = (password: string, hash: string) => bcrypt.compare(password, hash);

export async function loadAuthUser(db: Db, id: number): Promise<AuthUser | null> {
  const { rows } = await db.query<AuthUser>(
    `select u.id, u.name, u.email, u.role, u.store_id, u.active, u.token_version, s.name as store_name
       from users u
       left join stores s on s.id = u.store_id
      where u.id = $1`,
    [id],
  );
  return rows[0] ?? null;
}

export function toPublicUser(user: AuthUser) {
  const { id, name, email, role, store_id, store_name } = user;
  return { id, name, email, role, store_id, store_name };
}

export function issueSession(res: Response, config: Config, user: { id: number; token_version: number }) {
  const token = jwt.sign({ tv: user.token_version }, config.jwtSecret, {
    subject: String(user.id),
    expiresIn: SESSION_TTL_SECONDS,
  });
  res.cookie(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: config.cookieSecure,
    maxAge: SESSION_TTL_SECONDS * 1000,
    path: '/',
  });
}

export function clearSession(res: Response, config: Config) {
  res.clearCookie(SESSION_COOKIE, { httpOnly: true, sameSite: 'lax', secure: config.cookieSecure, path: '/' });
}

const SESSION_EXPIRED = 'Sua sessão expirou. Entre novamente.';

/** Exige sessão válida. O usuário é relido do banco a cada requisição, então desativar ou trocar de loja vale na hora. */
export function authenticate(ctx: AppContext): RequestHandler {
  return async (req, _res, next) => {
    const token: unknown = req.cookies?.[SESSION_COOKIE];
    if (typeof token !== 'string' || token === '') throw new HttpError(401, 'Faça login para continuar.');

    let payload: jwt.JwtPayload;
    try {
      const decoded = jwt.verify(token, ctx.config.jwtSecret, { algorithms: ['HS256'] });
      if (typeof decoded === 'string') throw new Error('payload inesperado');
      payload = decoded;
    } catch {
      throw new HttpError(401, SESSION_EXPIRED);
    }

    const user = await loadAuthUser(ctx.pool, Number(payload.sub));
    if (!user || !user.active || user.token_version !== payload.tv) throw new HttpError(401, SESSION_EXPIRED);
    req.user = user;
    next();
  };
}

export const requireAdmin: RequestHandler = (req, _res, next) => {
  if (req.user?.role !== 'admin') throw new HttpError(403, 'Acesso restrito ao administrador.');
  next();
};

export function currentUser(req: Request): AuthUser {
  if (!req.user) throw new HttpError(401, 'Faça login para continuar.');
  return req.user;
}
