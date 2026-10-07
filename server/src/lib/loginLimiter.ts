import type { Db } from '../db/pool.js';

const MAX_FAILURES = 10;
const WINDOW = '15 minutes';

/**
 * Bloqueia novas tentativas de login depois de muitas falhas seguidas para o
 * mesmo e-mail e IP. Guardado no banco para valer entre instâncias serverless.
 */
export const loginLimiter = {
  async isBlocked(db: Db, key: string): Promise<boolean> {
    const { rows } = await db.query<{ blocked: boolean }>(
      'select failures >= $2 as blocked from login_attempts where key = $1 and reset_at > now()',
      [key, MAX_FAILURES],
    );
    return rows[0]?.blocked ?? false;
  },

  async fail(db: Db, key: string): Promise<void> {
    await db.query(
      `insert into login_attempts (key, failures, reset_at)
       values ($1, 1, now() + $2::interval)
       on conflict (key) do update
          set failures = case when login_attempts.reset_at <= now() then 1 else login_attempts.failures + 1 end,
              reset_at = case when login_attempts.reset_at <= now() then now() + $2::interval else login_attempts.reset_at end`,
      [key, WINDOW],
    );
    // Limpeza oportunista de registros vencidos.
    if (Math.random() < 0.05) await db.query(`delete from login_attempts where reset_at < now() - interval '1 day'`);
  },

  async reset(db: Db, key: string): Promise<void> {
    await db.query('delete from login_attempts where key = $1', [key]);
  },
};
