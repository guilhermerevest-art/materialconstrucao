import { loadEnvFile } from '../config.js';
import { runMigrations } from '../db/migrate.js';
import { checkRowLevelSecurity, createPool } from '../db/pool.js';

loadEnvFile();
const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error('Defina DATABASE_URL.');
  process.exit(1);
}

const pool = createPool(databaseUrl, { caCert: process.env.DATABASE_CA_CERT });
try {
  await runMigrations(pool);
  const warning = await checkRowLevelSecurity(pool);
  if (warning) console.warn(`[aviso] ${warning}`);
  console.log('Banco atualizado.');
} catch (err) {
  console.error((err as Error).message);
  process.exitCode = 1;
} finally {
  await pool.end();
}
