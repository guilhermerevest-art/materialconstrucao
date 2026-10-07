import type pg from 'pg';

export type SessionUser = {
  id: number;
  role: 'admin' | 'seller';
  store_id: number | null;
};

/** Executa fn numa transação. */
export async function withTransaction<T>(pool: pg.Pool, fn: (db: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('begin');
    const result = await fn(client);
    await client.query('commit');
    return result;
  } catch (err) {
    await client.query('rollback').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Executa fn numa transação com o contexto do usuário que as políticas de RLS
 * leem (app.user_id, app.role, app.store_id). O contexto vale só para esta
 * transação, então a conexão volta limpa para o pool.
 */
export function withSession<T>(pool: pg.Pool, user: SessionUser, fn: (db: pg.PoolClient) => Promise<T>): Promise<T> {
  return withTransaction(pool, async (db) => {
    await db.query(
      `select set_config('app.user_id', $1, true),
              set_config('app.role', $2, true),
              set_config('app.store_id', $3, true)`,
      [String(user.id), user.role, user.store_id == null ? '' : String(user.store_id)],
    );
    return fn(db);
  });
}
