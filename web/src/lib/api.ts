import type { Client } from './types';

export class ApiError extends Error {
  readonly status: number;
  readonly code?: string;
  /** Cadastros que já usam o mesmo valor quando o conflito é de unicidade. */
  readonly conflicts?: Client[];
  /** O que falta para emitir a nota fiscal (cadastro da empresa, do cliente ou do produto). */
  readonly problems?: string[];

  constructor(message: string, status: number, code?: string, conflicts?: Client[], problems?: string[]) {
    super(message);
    this.status = status;
    this.code = code;
    this.conflicts = conflicts;
    this.problems = problems;
  }
}

let onUnauthorized: (() => void) | null = null;

/** Chamado quando a sessão expira no meio do uso (qualquer 401 fora do login). */
export function setUnauthorizedHandler(handler: () => void) {
  onUnauthorized = handler;
}

type Method = 'GET' | 'POST' | 'PUT' | 'DELETE';

export async function api<T>(path: string, options: { method?: Method; body?: unknown } = {}): Promise<T> {
  const { method = 'GET', body } = options;
  let res: Response;
  try {
    res = await fetch(`/api${path}`, {
      method,
      credentials: 'same-origin',
      headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new ApiError('Sem conexão com o servidor. Verifique a internet e tente de novo.', 0);
  }

  if (res.status === 204) return undefined as T;
  const data = (await res.json().catch(() => null)) as {
    error?: string;
    code?: string;
    conflicts?: Client[];
    problems?: string[];
  } | null;
  if (!res.ok) {
    if (res.status === 401 && !path.startsWith('/auth/')) onUnauthorized?.();
    throw new ApiError(
      data?.error ?? `Erro ${res.status}. Tente de novo.`,
      res.status,
      data?.code,
      data?.conflicts,
      data?.problems,
    );
  }
  return data as T;
}

/** Monta a query string ignorando valores vazios. */
export function toQuery(params: Record<string, string | number | boolean | null | undefined>) {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === '' || value === false) continue;
    search.set(key, String(value));
  }
  const text = search.toString();
  return text ? `?${text}` : '';
}
