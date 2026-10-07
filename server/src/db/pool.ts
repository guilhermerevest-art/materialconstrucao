import pg from 'pg';

// bigint (ids, contagens) e numeric (valores) chegam como string no driver.
// Os ids cabem com folga em Number e os valores têm no máximo 3 casas decimais.
pg.types.setTypeParser(pg.types.builtins.INT8, (value) => Number(value));
pg.types.setTypeParser(pg.types.builtins.NUMERIC, (value) => Number(value));

export type Db = pg.Pool | pg.PoolClient;

export type PoolOptions = pg.PoolConfig & {
  /** Certificado (PEM) da CA do servidor, para sslmode=verify-ca ou verify-full. */
  caCert?: string;
};

/**
 * Cria o pool a partir da DATABASE_URL respeitando o sslmode como no libpq:
 * "require" criptografa sem validar o certificado; "verify-ca" valida a cadeia
 * com o certificado informado; "verify-full" valida também o nome do servidor.
 */
export function createPool(databaseUrl: string, { caCert, ...options }: PoolOptions = {}) {
  const url = new URL(databaseUrl);
  const sslmode = url.searchParams.get('sslmode');
  // O driver sobrescreveria a opção ssl com o que vem na URL, então o parâmetro sai daqui.
  url.searchParams.delete('sslmode');
  url.searchParams.delete('uselibpqcompat');

  let ssl: pg.PoolConfig['ssl'] = false;
  if (sslmode === 'require' || sslmode === 'prefer' || sslmode === 'no-verify') {
    ssl = { rejectUnauthorized: false };
  } else if (sslmode === 'verify-ca' || sslmode === 'verify-full') {
    ssl = {
      rejectUnauthorized: true,
      ca: caCert?.replace(/\\n/g, '\n'),
      ...(sslmode === 'verify-ca' ? { checkServerIdentity: () => undefined } : {}),
    };
  }

  return new pg.Pool({
    connectionString: url.toString(),
    ssl,
    max: 10,
    connectionTimeoutMillis: 10_000,
    ...options,
  });
}

/** Se o usuário do banco ignora RLS, o isolamento entre lojas fica só na API. */
export async function checkRowLevelSecurity(pool: pg.Pool): Promise<string | null> {
  const { rows } = await pool.query<{ rolsuper: boolean; rolbypassrls: boolean; rolname: string }>(
    'select rolname, rolsuper, rolbypassrls from pg_roles where rolname = current_user',
  );
  const role = rows[0];
  if (role && (role.rolsuper || role.rolbypassrls)) {
    return `O usuário "${role.rolname}" do banco ignora Row Level Security (superusuário ou BYPASSRLS). Use um usuário comum para que o isolamento entre lojas também seja garantido pelo banco.`;
  }
  return null;
}
