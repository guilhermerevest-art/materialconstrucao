import type pg from 'pg';
import type { Config } from './config.js';

export type AppContext = {
  pool: pg.Pool;
  config: Config;
};
