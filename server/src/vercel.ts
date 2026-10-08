import { attachDatabasePool } from '@vercel/functions';
import { createApp } from './app.js';
import { loadConfig } from './config.js';
import { createPool } from './db/pool.js';

// Entrada da API na Vercel: o app Express inteiro roda como uma Serverless Function.
// A instância é reaproveitada entre requisições, então o pool fica no escopo do módulo.
const config = loadConfig();
const pool = createPool(config.databaseUrl, {
  caCert: config.databaseCaCert,
  max: 5,
  idleTimeoutMillis: 5_000,
});
// Fecha conexões ociosas antes de a Vercel suspender a instância.
attachDatabasePool(pool);

export default createApp({ pool, config });
