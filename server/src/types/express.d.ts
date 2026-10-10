import type { AuthUser, SuperAdmin } from '../auth.js';

declare global {
  namespace Express {
    interface Request {
      user?: AuthUser;
      /** Quando a sessão do usuário expira (segundos desde 1970), lido do cookie. */
      sessionExpiresAt?: number;
      superAdmin?: SuperAdmin;
    }
  }
}

export {};