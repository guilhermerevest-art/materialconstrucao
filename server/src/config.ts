import { existsSync } from 'node:fs';
import { z } from 'zod';

/** Carrega o .env da pasta atual ou da raiz do repositório. Variáveis já definidas no ambiente têm prioridade. */
export function loadEnvFile() {
  for (const file of ['.env', '../.env']) {
    if (existsSync(file)) {
      process.loadEnvFile(file);
      return;
    }
  }
}

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  DATABASE_URL: z.string().min(1, 'defina DATABASE_URL'),
  /** URL de conexão para o pool de login (role oms_login, BYPASSRLS). Opcional
   * em dev: se não for informada, usa a mesma DATABASE_URL e a função
   * `find_login` continua acessível ao role que conecta. Em produção, defina
   * `DATABASE_LOGIN_URL` apontando para o role dedicado, com senha própria. */
  DATABASE_LOGIN_URL: z.string().optional(),
  DATABASE_CA_CERT: z.string().optional(),
  JWT_SECRET: z.string().min(32, 'JWT_SECRET precisa ter pelo menos 32 caracteres'),
  COOKIE_SECURE: z.enum(['true', 'false']).optional(),
  TRUST_PROXY: z.string().optional(),
  APP_TIMEZONE: z.string().default('America/Sao_Paulo'),
  EVOLUTION_TIMEOUT_MS: z.coerce.number().int().positive().default(30_000),
  WEB_DIST_DIR: z.string().optional(),
  VERCEL: z.string().optional(),
});

export type Config = {
  env: 'development' | 'production' | 'test';
  port: number;
  databaseUrl: string;
  /** URL do pool de login (role `oms_login`). Veja DATABASE_LOGIN_URL. */
  databaseLoginUrl?: string;
  /** Certificado (PEM) da CA do Postgres, para sslmode=verify-ca/verify-full. */
  databaseCaCert?: string;
  jwtSecret: string;
  /** Cookie de sessão só por HTTPS. Padrão: ligado em produção e na Vercel. */
  cookieSecure: boolean;
  /** Repassado para o "trust proxy" do Express. Na Vercel o padrão é confiar no proxy dela. */
  trustProxy: boolean | number | string;
  timeZone: string;
  evolutionTimeoutMs: number;
  /** Pasta com o build do frontend, servida pela API em produção. */
  webDistDir?: string;
};

function parseTrustProxy(value: string | undefined): Config['trustProxy'] {
  if (value === undefined || value === '' || value === 'false') return false;
  if (value === 'true') return true;
  if (/^\d+$/.test(value)) return Number(value);
  return value;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    const details = parsed.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Configuração inválida:\n${details}`);
  }
  const e = parsed.data;
  try {
    new Intl.DateTimeFormat('pt-BR', { timeZone: e.APP_TIMEZONE });
  } catch {
    throw new Error(`APP_TIMEZONE inválido: ${e.APP_TIMEZONE}`);
  }
  const onVercel = Boolean(e.VERCEL);
  return {
    env: e.NODE_ENV,
    port: e.PORT,
    databaseUrl: e.DATABASE_URL,
    databaseLoginUrl: e.DATABASE_LOGIN_URL || undefined,
    databaseCaCert: e.DATABASE_CA_CERT || undefined,
    jwtSecret: e.JWT_SECRET,
    cookieSecure: e.COOKIE_SECURE ? e.COOKIE_SECURE === 'true' : e.NODE_ENV === 'production' || onVercel,
    trustProxy: e.TRUST_PROXY === undefined && onVercel ? true : parseTrustProxy(e.TRUST_PROXY),
    timeZone: e.APP_TIMEZONE,
    evolutionTimeoutMs: e.EVOLUTION_TIMEOUT_MS,
    webDistDir: e.WEB_DIST_DIR,
  };
}
