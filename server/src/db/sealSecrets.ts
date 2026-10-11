import type pg from 'pg';
import { needsSealing, openSecret, sealSecret } from '../lib/secrets.js';
import { setTenantContext, withTransaction } from './session.js';

const COLUMNS = [
  { table: 'settings', column: 'evolution_api_token' },
  { table: 'fiscal_settings', column: 'acbr_client_secret' },
  { table: 'fiscal_settings', column: 'nfce_csc' },
] as const;

/**
 * Cifra as senhas de serviços que ainda estão em texto (de antes da criptografia) e
 * cifra de novo, com a chave atual, as que usam uma chave anterior. Roda no db:migrate,
 * depois de initSecrets. Fica fora do registro de alterações: o valor não mudou.
 */
export async function sealStoredSecrets(pool: pg.Pool) {
  const { rows: tenants } = await pool.query<{ id: number }>('select id from tenants order by id');
  let sealed = 0;
  for (const tenant of tenants) {
    sealed += await withTransaction(pool, async (db) => {
      await setTenantContext(db, tenant.id);
      await db.query(`select set_config('app.audit', 'off', true)`);
      let count = 0;
      for (const { table, column } of COLUMNS) {
        const { rows } = await db.query<{ value: string | null }>(
          `select ${column} as value from ${table} where tenant_id = $1 for update`,
          [tenant.id],
        );
        const value = rows[0]?.value ?? null;
        if (!needsSealing(value)) continue;
        const plain = openSecret(value);
        // Cifrado com uma chave que não existe mais: fica como está, a tela pede de novo.
        if (!plain) continue;
        await db.query(`update ${table} set ${column} = $2 where tenant_id = $1`, [tenant.id, sealSecret(plain)]);
        count++;
      }
      return count;
    });
  }
  return sealed;
}
