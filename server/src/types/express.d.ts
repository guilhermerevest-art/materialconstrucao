import type { AuthUser, SuperAdmin } from '../auth.js';

declare global {
  namespace Express {
    interface Request {
      user?: AuthUser;
      superAdmin?: SuperAdmin;
    }
  }
}

export {};