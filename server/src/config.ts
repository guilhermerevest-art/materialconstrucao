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
  DATABASE_CA_CERT: z.string().optional(),
  JWT_SECRET: z.string().min(32, 'JWT_SECRET precisa ter pelo menos 32 caracteres'),
  COOKIE_SECURE: z.enum(['true', 'false']).optional(),
  TRUST_PROXY: z.string().optional(),
  APP_TIMEZONE: z.string().default('America/Sao_Paulo'),
  EVOLUTION_API_URL: z.string().optional(),
  EVOLUTION_API_KEY: z.string().optional(),
  EVOLUTION_TIMEOUT_MS: z.coerce.number().int().positive().default(30_000),
  ACBR_API_URL: z.string().optional(),
  ACBR_AUTH_URL: z.string().optional(),
  ACBR_CLIENT_ID: z.string().optional(),
  ACBR_CLIENT_SECRET: z.string().optional(),
  ACBR_SCOPE: z.string().optional(),
  ACBR_TIMEOUT_MS: z.coerce.number().int().positive().default(30_000),
  WEB_DIST_DIR: z.string().optional(),
  VERCEL: z.string().optional(),
});

export type Config = {
  env: 'development' | 'production' | 'test';
  port: number;
  databaseUrl: string;
  /** Certificado (PEM) da CA do Postgres, para sslmode=verify-ca/verify-full. */
  databaseCaCert?: string;
  jwtSecret: string;
  /** Cookie de sessão só por HTTPS. Padrão: ligado em produção e na Vercel. */
  cookieSecure: boolean;
  /** Repassado para o "trust proxy" do Express. Na Vercel o padrão é confiar no proxy dela. */
  trustProxy: boolean | number | string;
  timeZone: string;
  evolutionTimeoutMs: number;
  /**
   * Servidor da EvolutionAPI da plataforma (Global API Key). Com ele, cada loja
   * conecta o WhatsApp sozinha em Configurações, lendo o QR Code.
   */
  evolutionServer?: { url: string; token: string };
  /** Pasta com o build do frontend, servida pela API em produção. */
  webDistDir?: string;
  /** ACBr API (emissão de NF-e/NFC-e e distribuição DF-e). */
  acbr: AcbrConfig;
};

export type AcbrConfig = {
  /** Endereço da API: produção (padrão) ou o sandbox de homologação da ACBr. */
  url: string;
  /** Endpoint OAuth2 (client_credentials) que emite o token. */
  authUrl: string;
  scope: string;
  timeoutMs: number;
  /**
   * Conta da plataforma. Com ela, cada lojamestre só cadastra a empresa e o
   * certificado; sem ela, cada uma informa a própria conta em Configurações.
   */
  platform?: { clientId: string; clientSecret: string };
};

export const ACBR_DEFAULT_URL = 'https://prod.acbr.api.br';
export const ACBR_DEFAULT_AUTH_URL = 'https://auth.acbr.api.br/realms/ACBrAPI/protocol/openid-connect/token';
export const ACBR_DEFAULT_SCOPE = 'empresa nfe cep cnpj';

function parseHttpUrl(value: string | undefined, name: string, fallback: string) {
  const url = value?.trim().replace(/\/+$/, '') || fallback;
  if (!/^https?:\/\//.test(url)) throw new Error(`${name} precisa começar com http:// ou https://`);
  return url;
}

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
  const evolutionUrl = e.EVOLUTION_API_URL?.trim().replace(/\/+$/, '');
  const evolutionKey = e.EVOLUTION_API_KEY?.trim();
  if (evolutionUrl && !/^https?:\/\//.test(evolutionUrl)) {
    throw new Error('EVOLUTION_API_URL precisa começar com http:// ou https://');
  }
  const onVercel = Boolean(e.VERCEL);
  const acbrClientId = e.ACBR_CLIENT_ID?.trim();
  const acbrClientSecret = e.ACBR_CLIENT_SECRET?.trim();
  return {
    env: e.NODE_ENV,
    port: e.PORT,
    databaseUrl: e.DATABASE_URL,
    databaseCaCert: e.DATABASE_CA_CERT || undefined,
    jwtSecret: e.JWT_SECRET,
    cookieSecure: e.COOKIE_SECURE ? e.COOKIE_SECURE === 'true' : e.NODE_ENV === 'production' || onVercel,
    trustProxy: e.TRUST_PROXY === undefined && onVercel ? true : parseTrustProxy(e.TRUST_PROXY),
    timeZone: e.APP_TIMEZONE,
    evolutionTimeoutMs: e.EVOLUTION_TIMEOUT_MS,
    evolutionServer: evolutionUrl && evolutionKey ? { url: evolutionUrl, token: evolutionKey } : undefined,
    webDistDir: e.WEB_DIST_DIR,
    acbr: {
      url: parseHttpUrl(e.ACBR_API_URL, 'ACBR_API_URL', ACBR_DEFAULT_URL),
      authUrl: parseHttpUrl(e.ACBR_AUTH_URL, 'ACBR_AUTH_URL', ACBR_DEFAULT_AUTH_URL),
      scope: e.ACBR_SCOPE?.trim() || ACBR_DEFAULT_SCOPE,
      timeoutMs: e.ACBR_TIMEOUT_MS,
      platform: acbrClientId && acbrClientSecret ? { clientId: acbrClientId, clientSecret: acbrClientSecret } : undefined,
    },
  };
}
