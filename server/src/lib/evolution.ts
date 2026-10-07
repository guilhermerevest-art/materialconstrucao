import type { Db } from '../db/pool.js';

/** Credenciais da EvolutionAPI salvas em Configurações. */
export type EvolutionSettings = {
  url: string;
  instance: string;
  token: string;
};

export async function loadEvolutionSettings(db: Db): Promise<EvolutionSettings | null> {
  const { rows } = await db.query<{
    evolution_api_url: string | null;
    evolution_instance: string | null;
    evolution_api_token: string | null;
  }>('select evolution_api_url, evolution_instance, evolution_api_token from settings where id = 1');
  const s = rows[0];
  if (!s?.evolution_api_url || !s.evolution_instance || !s.evolution_api_token) return null;
  return { url: s.evolution_api_url.replace(/\/+$/, ''), instance: s.evolution_instance, token: s.evolution_api_token };
}

export class EvolutionError extends Error {
  readonly kind: 'timeout' | 'unreachable' | 'http';
  readonly status?: number;
  readonly body?: string;

  constructor(kind: EvolutionError['kind'], message: string, status?: number, body?: string) {
    super(message);
    this.kind = kind;
    this.status = status;
    this.body = body;
  }
}

async function evolutionRequest(
  settings: EvolutionSettings,
  path: string,
  init: { method: 'GET' | 'POST'; body?: unknown },
  timeoutMs: number,
): Promise<unknown> {
  let res: Response;
  try {
    res = await fetch(`${settings.url}${path}`, {
      method: init.method,
      headers: { 'Content-Type': 'application/json', apikey: settings.token },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    const name = (err as Error).name;
    if (name === 'TimeoutError' || name === 'AbortError') {
      throw new EvolutionError('timeout', `Sem resposta da EvolutionAPI em ${timeoutMs} ms`);
    }
    throw new EvolutionError('unreachable', `EvolutionAPI inacessível: ${(err as Error).message}`);
  }
  const text = await res.text();
  if (!res.ok) throw new EvolutionError('http', `EvolutionAPI respondeu HTTP ${res.status}`, res.status, text.slice(0, 2000));
  try {
    return text ? JSON.parse(text) : null;
  } catch {
    return text;
  }
}

/** Envia o PDF como documento. Endpoint da EvolutionAPI v2: POST /message/sendMedia/{instância}. */
export function sendPdfDocument(
  settings: EvolutionSettings,
  message: { number: string; pdf: Buffer; fileName: string; caption: string },
  timeoutMs: number,
) {
  return evolutionRequest(
    settings,
    `/message/sendMedia/${encodeURIComponent(settings.instance)}`,
    {
      method: 'POST',
      body: {
        number: message.number,
        mediatype: 'document',
        mimetype: 'application/pdf',
        media: message.pdf.toString('base64'),
        fileName: message.fileName,
        caption: message.caption,
      },
    },
    timeoutMs,
  );
}

/** Estado da conexão da instância com o WhatsApp ("open" quando o celular está conectado). */
export async function getConnectionState(settings: EvolutionSettings, timeoutMs: number): Promise<string> {
  const data = (await evolutionRequest(
    settings,
    `/instance/connectionState/${encodeURIComponent(settings.instance)}`,
    { method: 'GET' },
    timeoutMs,
  )) as { instance?: { state?: string }; state?: string } | null;
  return data?.instance?.state ?? data?.state ?? 'unknown';
}

/** Motivo da falha em linguagem de balcão, para mostrar junto do aviso de erro. */
export function describeEvolutionError(err: unknown): string {
  if (!(err instanceof EvolutionError)) return 'Erro inesperado ao falar com a EvolutionAPI.';
  if (err.kind === 'timeout') return 'A EvolutionAPI demorou demais para responder.';
  if (err.kind === 'unreachable') return 'Não foi possível conectar à EvolutionAPI. Confira a URL em Configurações.';
  if (err.body?.includes('"exists":false')) return 'Este número não tem WhatsApp. Confira o cadastro do cliente.';
  if (err.status === 401 || err.status === 403) return 'A EvolutionAPI recusou a API Key. Confira a chave em Configurações.';
  if (err.status === 404) return 'Instância não encontrada na EvolutionAPI. Confira o nome da instância em Configurações.';
  return `A EvolutionAPI respondeu com erro (HTTP ${err.status}).`;
}
