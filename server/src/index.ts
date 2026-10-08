import { createApp } from './app.js';
import { loadConfig, loadEnvFile } from './config.js';
import { checkRowLevelSecurity, createPool } from './db/pool.js';

loadEnvFile();
const config = loadConfig();
const pool = createPool(config.databaseUrl, { caCert: config.databaseCaCert });

try {
  const warning = await checkRowLevelSecurity(pool);
  if (warning) console.warn(`[aviso] ${warning}`);
} catch (err) {
  console.error(`Não foi possível conectar ao banco: ${(err as Error).message}`);
  process.exit(1);
}

const app = createApp({ pool, config });
const server = app.listen(config.port, () => {
  console.log(`Servidor ouvindo em http://localhost:${config.port}`);
});

function shutdown() {
  server.close(() => {
    pool.end().finally(() => process.exit(0));
  });
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
