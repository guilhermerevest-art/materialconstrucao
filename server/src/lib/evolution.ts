import type { Db } from '../db/pool.js';
import { openSecret } from './secrets.js';

/** Credenciais da EvolutionAPI salvas em Configurações. */
export type EvolutionSettings = {
  url: string;
  instance: string;
  token: string;
};

/** Servidor da EvolutionAPI e a chave usada nas chamadas (global ou da instância). */
export type EvolutionServer = {
  url: string;
  token: string;
};

export async function loadEvolutionSettings(db: Db, tenantId: number): Promise<EvolutionSettings | null> {
  const { rows } = await db.query<{
    evolution_api_url: string | null;
    evolution_instance: string | null;
    evolution_api_token: string | null;
  }>(
    'select evolution_api_url, evolution_instance, evolution_api_token from settings where tenant_id = $1',
    [tenantId],
  );
  const s = rows[0];
  const token = openSecret(s?.evolution_api_token);
  if (!s?.evolution_api_url || !s.evolution_instance || !token) return null;
  return { url: s.evolution_api_url.replace(/\/+$/, ''), instance: s.evolution_instance, token };
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
  settings: EvolutionServer,
  path: string,
  init: { method: 'GET' | 'POST' | 'DELETE'; body?: unknown },
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

/** Mensagem de texto. Endpoint da EvolutionAPI v2: POST /message/sendText/{instância}. */
export function sendTextMessage(settings: EvolutionSettings, message: { number: string; text: string }, timeoutMs: number) {
  return evolutionRequest(
    settings,
    `/message/sendText/${encodeURIComponent(settings.instance)}`,
    { method: 'POST', body: { number: message.number, text: message.text } },
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

/** QR Code para conectar o celular. `state` vem "open" quando a instância já está conectada. */
export type EvolutionQrCode = {
  state: 'open' | 'connecting';
  qrcode: string | null;
  pairingCode: string | null;
};

type QrPayload = { base64?: string | null; code?: string | null; pairingCode?: string | null } | null | undefined;

function toQrCode(qr: QrPayload): EvolutionQrCode {
  const base64 = qr?.base64 || null;
  return {
    state: 'connecting',
    qrcode: base64 && !base64.startsWith('data:') ? `data:image/png;base64,${base64}` : base64,
    pairingCode: qr?.pairingCode || null,
  };
}

/**
 * Cria a instância já pedindo o QR Code. Endpoint v2: POST /instance/create.
 * Mandamos a chave da instância (`token`); a resposta traz a que valeu em `hash`
 * (texto na v2, `{ apikey }` em versões antigas).
 */
export async function createInstance(
  server: EvolutionServer,
  instance: { name: string; token: string },
  timeoutMs: number,
): Promise<EvolutionQrCode & { token: string }> {
  const data = (await evolutionRequest(
    server,
    '/instance/create',
    {
      method: 'POST',
      body: { instanceName: instance.name, token: instance.token, qrcode: true, integration: 'WHATSAPP-BAILEYS' },
    },
    timeoutMs,
  )) as { hash?: string | { apikey?: string } | null; qrcode?: QrPayload } | null;
  const hash = data?.hash;
  const token = (typeof hash === 'string' ? hash : hash?.apikey) || instance.token;
  return { ...toQrCode(data?.qrcode), token };
}

/** Novo QR Code de uma instância existente. Endpoint v2: GET /instance/connect/{instância}. */
export async function connectInstance(server: EvolutionServer, instance: string, timeoutMs: number): Promise<EvolutionQrCode> {
  const data = (await evolutionRequest(
    server,
    `/instance/connect/${encodeURIComponent(instance)}`,
    { method: 'GET' },
    timeoutMs,
  )) as (NonNullable<QrPayload> & { instance?: { state?: string } }) | null;
  if (data?.instance?.state === 'open') return { state: 'open', qrcode: null, pairingCode: null };
  return toQrCode(data);
}

/** Desconecta o celular e apaga a instância. Instância que já não existe não é erro. */
export async function deleteInstance(server: EvolutionServer, instance: string, timeoutMs: number) {
  const name = encodeURIComponent(instance);
  try {
    await evolutionRequest(server, `/instance/logout/${name}`, { method: 'DELETE' }, timeoutMs);
  } catch (err) {
    // Instância desconectada recusa o logout; segue para apagar.
    if (!(err instanceof EvolutionError && err.kind === 'http')) throw err;
  }
  try {
    await evolutionRequest(server, `/instance/delete/${name}`, { method: 'DELETE' }, timeoutMs);
  } catch (err) {
    if (!(err instanceof EvolutionError && err.status === 404)) throw err;
  }
}

/**
 * De onde vem a chave da chamada, para a mensagem de erro apontar onde corrigir:
 * - manual: URL, instância e chave preenchidas à mão em Configurações;
 * - platform: Global API Key da plataforma (EVOLUTION_API_URL e EVOLUTION_API_KEY), ao criar ou apagar instâncias;
 * - managed: chave da instância criada pela conexão automática.
 */
export type EvolutionKeySource = 'manual' | 'platform' | 'managed';

/** Instância criada pela conexão automática quando está no servidor da plataforma. */
export function keySourceOf(settings: EvolutionSettings, server: EvolutionServer | undefined): EvolutionKeySource {
  return server && settings.url === server.url ? 'managed' : 'manual';
}

const PLATFORM_UNREACHABLE =
  'Não foi possível conectar à EvolutionAPI da plataforma. Confira a variável EVOLUTION_API_URL do servidor.';

const FIX_HINTS: Record<EvolutionKeySource, { unreachable: string; key: string; notFound: string }> = {
  manual: {
    unreachable: 'Não foi possível conectar à EvolutionAPI. Confira a URL em Configurações.',
    key: 'A EvolutionAPI recusou a API Key. Confira a chave em Configurações.',
    notFound: 'Instância não encontrada na EvolutionAPI. Confira o nome da instância em Configurações.',
  },
  platform: {
    unreachable: PLATFORM_UNREACHABLE,
    key:
      'A EvolutionAPI recusou a Global API Key. Confira a variável EVOLUTION_API_KEY do servidor: ' +
      'ela precisa ser igual à AUTHENTICATION_API_KEY da Evolution.',
    notFound:
      'A EvolutionAPI não reconheceu o endereço. Confira se EVOLUTION_API_URL é só o endereço do servidor, sem /manager.',
  },
  managed: {
    unreachable: PLATFORM_UNREACHABLE,
    key: 'A EvolutionAPI recusou a chave da instância. Desconecte e conecte o WhatsApp de novo em Configurações.',
    notFound: 'A instância do WhatsApp não existe mais na EvolutionAPI. Conecte o WhatsApp de novo em Configurações.',
  },
};

/** Motivo da falha em linguagem de balcão, para mostrar junto do aviso de erro. */
export function describeEvolutionError(err: unknown, source: EvolutionKeySource = 'manual'): string {
  if (!(err instanceof EvolutionError)) return 'Erro inesperado ao falar com a EvolutionAPI.';
  const hints = FIX_HINTS[source];
  if (err.kind === 'timeout') return 'A EvolutionAPI demorou demais para responder.';
  if (err.kind === 'unreachable') return hints.unreachable;
  if (err.body?.includes('"exists":false')) return 'Este número não tem WhatsApp. Confira o cadastro do cliente.';
  if (err.status === 401 || err.status === 403) return hints.key;
  if (err.status === 404) return hints.notFound;
  return `A EvolutionAPI respondeu com erro (HTTP ${err.status}).`;
}
