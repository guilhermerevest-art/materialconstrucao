import type { AcbrConfig } from '../config.js';

/** Conta da ACBr API (OAuth2 client_credentials). */
export type AcbrCredentials = { clientId: string; clientSecret: string };

export type AcbrEnvironment = 'homologacao' | 'producao';

export class AcbrError extends Error {
  readonly kind: 'timeout' | 'unreachable' | 'http' | 'auth';
  readonly status?: number;
  /** Mensagem que a própria ACBr API devolveu, quando veio uma. */
  readonly detail?: string;

  constructor(kind: AcbrError['kind'], message: string, status?: number, detail?: string) {
    super(message);
    this.kind = kind;
    this.status = status;
    this.detail = detail;
  }
}

/**
 * Tokens por conta. Na Vercel a instância da função é reaproveitada entre
 * requisições, então o cache evita pedir um token novo a cada nota.
 */
const tokenCache = new Map<string, { token: string; expiresAt: number }>();

/** Para os testes: esquece os tokens guardados. */
export function clearAcbrTokenCache() {
  tokenCache.clear();
}

/** Lê a mensagem de erro nos formatos que a ACBr API e o servidor OAuth usam. */
export function extractAcbrMessage(text: string): string | undefined {
  if (!text.trim()) return undefined;
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return text.trim().slice(0, 300);
  }
  if (!data || typeof data !== 'object') return undefined;
  const body = data as Record<string, unknown>;
  const parts: string[] = [];
  const error = body.error;
  if (typeof error === 'string') parts.push(typeof body.error_description === 'string' ? body.error_description : error);
  else if (error && typeof error === 'object' && typeof (error as { message?: unknown }).message === 'string') {
    parts.push((error as { message: string }).message);
  } else if (typeof body.message === 'string') parts.push(body.message);
  const list = (error && typeof error === 'object' ? (error as { errors?: unknown }).errors : undefined) ?? body.errors;
  if (Array.isArray(list)) {
    for (const item of list.slice(0, 5)) {
      const message = (item as { message?: unknown })?.message;
      if (typeof message === 'string' && !parts.includes(message)) parts.push(message);
    }
  }
  return parts.join(' ').trim() || undefined;
}

type Query = Record<string, string | number | boolean | null | undefined>;

function withQuery(path: string, query?: Query) {
  if (!query) return path;
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null || value === '') continue;
    search.set(key, String(value));
  }
  const text = search.toString();
  return text ? `${path}?${text}` : path;
}

async function timedFetch(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    const name = (err as Error).name;
    if (name === 'TimeoutError' || name === 'AbortError') {
      throw new AcbrError('timeout', `Sem resposta da ACBr API em ${timeoutMs} ms`);
    }
    throw new AcbrError('unreachable', `ACBr API inacessível: ${(err as Error).message}`);
  }
}

export class AcbrClient {
  constructor(
    private readonly config: AcbrConfig,
    private readonly credentials: AcbrCredentials,
  ) {}

  private get cacheKey() {
    return `${this.config.authUrl}|${this.credentials.clientId}|${this.config.scope}`;
  }

  private async token(): Promise<string> {
    const cached = tokenCache.get(this.cacheKey);
    if (cached && cached.expiresAt > Date.now()) return cached.token;

    const res = await timedFetch(
      this.config.authUrl,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'client_credentials',
          client_id: this.credentials.clientId,
          client_secret: this.credentials.clientSecret,
          scope: this.config.scope,
        }).toString(),
      },
      this.config.timeoutMs,
    );
    const text = await res.text();
    if (!res.ok) {
      throw new AcbrError('auth', `ACBr API recusou as credenciais (HTTP ${res.status})`, res.status, extractAcbrMessage(text));
    }
    const data = JSON.parse(text) as { access_token?: string; expires_in?: number };
    if (!data.access_token) throw new AcbrError('auth', 'ACBr API não devolveu o token de acesso');
    // Renova um minuto antes de vencer.
    const ttl = Math.max(30, (data.expires_in ?? 3600) - 60);
    tokenCache.set(this.cacheKey, { token: data.access_token, expiresAt: Date.now() + ttl * 1000 });
    return data.access_token;
  }

  private async send(method: string, path: string, options: { query?: Query; body?: unknown; accept?: string }) {
    const url = `${this.config.url}${withQuery(path, options.query)}`;
    const attempt = async () =>
      timedFetch(
        url,
        {
          method,
          headers: {
            Authorization: `Bearer ${await this.token()}`,
            Accept: options.accept ?? 'application/json',
            ...(options.body === undefined ? {} : { 'Content-Type': 'application/json' }),
          },
          body: options.body === undefined ? undefined : JSON.stringify(options.body),
        },
        this.config.timeoutMs,
      );
    let res = await attempt();
    if (res.status === 401) {
      // Token revogado ou vencido antes da hora: pede outro uma vez.
      tokenCache.delete(this.cacheKey);
      res = await attempt();
    }
    if (!res.ok) {
      const text = await res.text();
      throw new AcbrError('http', `ACBr API respondeu HTTP ${res.status}`, res.status, extractAcbrMessage(text));
    }
    return res;
  }

  async request<T>(method: 'GET' | 'POST' | 'PUT' | 'DELETE', path: string, options: { query?: Query; body?: unknown } = {}) {
    const res = await this.send(method, path, options);
    const text = await res.text();
    return (text ? JSON.parse(text) : null) as T;
  }

  /** PDF (DANFE) ou XML: devolve o arquivo como veio. */
  async download(path: string, query?: Query) {
    const res = await this.send('GET', path, { query, accept: '*/*' });
    return {
      data: Buffer.from(await res.arrayBuffer()),
      contentType: res.headers.get('content-type') ?? 'application/octet-stream',
    };
  }
}

/** A conta própria da lojamestre vale mais que a da plataforma. */
export function resolveCredentials(
  config: AcbrConfig,
  settings: { acbr_client_id: string | null; acbr_client_secret: string | null } | null | undefined,
): AcbrCredentials | null {
  if (settings?.acbr_client_id && settings.acbr_client_secret) {
    return { clientId: settings.acbr_client_id, clientSecret: settings.acbr_client_secret };
  }
  return config.platform ?? null;
}

/** Motivo da falha em linguagem de balcão, apontando onde corrigir. */
export function describeAcbrError(err: unknown): string {
  if (!(err instanceof AcbrError)) return 'Erro inesperado ao falar com a ACBr API.';
  const detail = err.detail ? ` ${err.detail}` : '';
  switch (err.kind) {
    case 'timeout':
      return 'A ACBr API demorou demais para responder. Se a nota já tinha sido enviada, use "Atualizar situação" em instantes.';
    case 'unreachable':
      return 'Não foi possível conectar à ACBr API. Verifique a internet do servidor e tente de novo.';
    case 'auth':
      return `A ACBr API recusou as credenciais (client_id e client_secret). Confira em Configurações → Fiscal.${detail}`;
  }
  if (err.status === 401 || err.status === 403) {
    return `A ACBr API recusou o acesso. Confira as credenciais e os escopos da conta em Configurações → Fiscal.${detail}`;
  }
  if (err.status === 404) return `Não encontrado na ACBr API.${detail}`;
  if (err.status === 429) return 'A ACBr API recusou por excesso de requisições. Aguarde um pouco e tente de novo.';
  if (err.status && err.status >= 500) {
    return `A ACBr API está instável (HTTP ${err.status}). Tente de novo em instantes.${detail}`;
  }
  return err.detail ? `A ACBr API recusou: ${err.detail}` : `A ACBr API respondeu com erro (HTTP ${err.status}).`;
}
