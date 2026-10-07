import { z } from 'zod';
import { HttpError } from '../errors.js';

/** Id vindo da URL. Id malformado responde como registro inexistente. */
export function parseId(value: unknown, notFoundMessage = 'Registro não encontrado.'): number {
  const parsed = z.coerce.number().int().positive().max(Number.MAX_SAFE_INTEGER).safeParse(value);
  if (!parsed.success) throw new HttpError(404, notFoundMessage);
  return parsed.data;
}

const blankToUndefined = (value: unknown) => (typeof value === 'string' && value.trim() === '' ? undefined : value);

/** Texto opcional de formulário: vazio vira null. */
export const optionalText = (max: number) =>
  z.preprocess(
    (value) => (value === undefined || blankToUndefined(value) === undefined ? null : value),
    z.string().trim().max(max, `Use no máximo ${max} caracteres.`).nullable(),
  );

/** Parâmetro de busca opcional na query string. */
export const optionalQuery = z.preprocess(blankToUndefined, z.string().trim().max(100).optional());

export const optionalQueryId = z.preprocess(blankToUndefined, z.coerce.number().int().positive().optional());

export const pagination = {
  page: z.coerce.number().int().min(1).default(1),
  page_size: z.coerce.number().int().min(1).max(100).default(20),
};

/** Padrão para LIKE com os curingas do usuário escapados. */
export const likePattern = (term: string) => `%${term.replace(/[\\%_]/g, '\\$&')}%`;
