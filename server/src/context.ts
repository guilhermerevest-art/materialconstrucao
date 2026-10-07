import type pg from 'pg';
import type { Config } from './config.js';

export type AppContext = {
  pool: pg.Pool;
  /**
   * Pool dedicado para a busca de credenciais no login. Conecta com um role
   * que tem BYPASSRLS mas NÃO tem grants em tabelas — só pode chamar
   * `find_login`. Usado só por `authRouter`; todas as demais rotas usam
   * `pool`, que respeita RLS normalmente.
   */
  loginPool: pg.Pool;
  config: Config;
};
