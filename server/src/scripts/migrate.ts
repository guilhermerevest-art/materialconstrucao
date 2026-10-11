import { loadEnvFile } from '../config.js';
import { runMigrations } from '../db/migrate.js';
import { checkRowLevelSecurity, createPool } from '../db/pool.js';
import { sealStoredSecrets } from '../db/sealSecrets.js';
import { initSecrets } from '../lib/secrets.js';

loadEnvFile();
const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error('Defina DATABASE_URL.');
  process.exit(1);
}

const pool = createPool(databaseUrl, { caCert: process.env.DATABASE_CA_CERT });
try {
  await runMigrations(pool);
  // Senhas de serviços (ACBr, CSC, EvolutionAPI): cifra o que ainda está em texto.
  const jwtSecret = process.env.JWT_SECRET;
  const secretsKey = process.env.SECRETS_KEY || undefined;
  if (secretsKey && secretsKey.length < 32) throw new Error('SECRETS_KEY precisa ter pelo menos 32 caracteres.');
  if (jwtSecret && jwtSecret.length >= 32) {
    initSecrets({
      jwtSecret,
      secretsKey,
      previousKeys: process.env.SECRETS_KEY_PREVIOUS?.split(',').map((k) => k.trim()).filter(Boolean),
    });
    const sealed = await sealStoredSecrets(pool);
    if (sealed) console.log(`Senhas de serviços cifradas: ${sealed}.`);
  } else {
    console.warn('[aviso] Sem JWT_SECRET: as senhas de serviços ficam como estão até serem salvas de novo.');
  }
  const warning = await checkRowLevelSecurity(pool);
  if (warning) console.warn(`[aviso] ${warning}`);
  console.log('Banco atualizado.');
} catch (err) {
  console.error((err as Error).message);
  process.exitCode = 1;
} finally {
  await pool.end();
}
