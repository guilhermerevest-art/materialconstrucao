import type { ErrorRequestHandler } from 'express';
import pg from 'pg';
import { ZodError } from 'zod';

export class HttpError extends Error {
  readonly status: number;
  readonly code?: string;
  readonly details?: unknown;

  constructor(status: number, message: string, code?: string, details?: unknown) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

const UNIQUE_MESSAGES: Record<string, string> = {
  users_email_key: 'Já existe um usuário com este e-mail.',
  products_code_key: 'Já existe um produto com este código.',
  clients_whatsapp_key: 'Já existe um cliente com este WhatsApp.',
};

const IN_USE_MESSAGES: Record<string, string> = {
  orders_client_id_fkey: 'Este cliente tem pedidos registrados e não pode ser excluído.',
  order_items_product_id_fkey:
    'Este produto aparece em pedidos e não pode ser excluído. Desative-o para tirá-lo das buscas.',
  users_store_id_fkey: 'Esta loja tem usuários vinculados e não pode ser excluída.',
  orders_store_id_fkey: 'Esta loja tem pedidos registrados e não pode ser excluída.',
};

const CHECK_MESSAGES: Record<string, string> = {
  users_seller_needs_store: 'Vendedores precisam estar vinculados a uma loja.',
};

function databaseErrorResponse(err: pg.DatabaseError): { status: number; message: string } | null {
  const constraint = err.constraint ?? '';
  switch (err.code) {
    case '23505':
      return { status: 409, message: UNIQUE_MESSAGES[constraint] ?? 'Já existe um registro com estes dados.' };
    case '23503':
      if (err.detail?.includes('still referenced')) {
        return { status: 409, message: IN_USE_MESSAGES[constraint] ?? 'Este registro está em uso e não pode ser excluído.' };
      }
      return { status: 400, message: 'Um dos registros informados não existe mais. Atualize a página e tente de novo.' };
    case '23514':
      return { status: 400, message: CHECK_MESSAGES[constraint] ?? 'Dados fora do permitido.' };
    case '42501':
      return { status: 403, message: 'Você não tem permissão para esta operação.' };
    default:
      return null;
  }
}

/**
 * Campos extras da resposta. Um objeto vira campos de topo (`{ conflicts }` sai como
 * `conflicts`), que é o que o navegador lê; qualquer outro valor vai agrupado em `details`.
 */
function extraFields(details: unknown): Record<string, unknown> {
  if (details === undefined) return {};
  if (details === null || typeof details !== 'object' || Array.isArray(details)) return { details };
  return { ...details };
}

export const errorHandler: ErrorRequestHandler = (err, _req, res, _next) => {
  if (err instanceof HttpError) {
    const extra = extraFields(err.details);
    res.status(err.status).json({ ...extra, error: err.message, code: err.code });
    return;
  }
  if (err instanceof ZodError) {
    res.status(400).json({ error: err.issues[0]?.message ?? 'Dados inválidos.' });
    return;
  }
  if (err instanceof pg.DatabaseError) {
    const mapped = databaseErrorResponse(err);
    if (mapped) {
      res.status(mapped.status).json({ error: mapped.message });
      return;
    }
  }
  if (err?.type === 'entity.parse.failed') {
    res.status(400).json({ error: 'Corpo da requisição não é um JSON válido.' });
    return;
  }
  console.error(err);
  res.status(500).json({ error: 'Erro interno. Tente novamente em instantes.' });
};
