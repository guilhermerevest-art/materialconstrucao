/**
 * CPF e CNPJ: guardados sem máscara. O CNPJ alfanumérico (IN RFB 2.229/2024,
 * novos cadastros a partir de julho de 2026) tem letras nas 12 primeiras posições;
 * os dois dígitos verificadores continuam numéricos.
 */

/** Tira pontos, traços, barras e espaços; letras do CNPJ alfanumérico ficam maiúsculas. */
export const stripDocument = (value: string) => value.replace(/[\s./-]/g, '').toUpperCase();

export const onlyDigits = (value: string) => value.replace(/\D/g, '');

function checkDigit(values: number[], weights: number[]) {
  const sum = values.reduce((acc, value, i) => acc + value * weights[i]!, 0);
  const rest = sum % 11;
  return rest < 2 ? 0 : 11 - rest;
}

export function isValidCpf(value: string) {
  if (!/^\d{11}$/.test(value) || /^(\d)\1{10}$/.test(value)) return false;
  const digits = [...value].map(Number);
  const first = checkDigit(digits.slice(0, 9), [10, 9, 8, 7, 6, 5, 4, 3, 2]);
  const second = checkDigit(digits.slice(0, 10), [11, 10, 9, 8, 7, 6, 5, 4, 3, 2]);
  return first === digits[9] && second === digits[10];
}

export function isValidCnpj(value: string) {
  if (!/^[0-9A-Z]{12}\d{2}$/.test(value) || /^(\d)\1{13}$/.test(value)) return false;
  // No CNPJ alfanumérico cada caractere vale o código ASCII menos 48 ("A" = 17).
  const values = [...value].map((char) => char.charCodeAt(0) - 48);
  const first = checkDigit(values.slice(0, 12), [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]);
  const second = checkDigit(values.slice(0, 13), [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]);
  return first === values[12] && second === values[13];
}

/** Código IBGE de cada UF: os dois primeiros dígitos do código do município e o cUF da NF-e. */
export const UF_CODES: Record<string, number> = {
  RO: 11, AC: 12, AM: 13, RR: 14, PA: 15, AP: 16, TO: 17,
  MA: 21, PI: 22, CE: 23, RN: 24, PB: 25, PE: 26, AL: 27, SE: 28, BA: 29,
  MG: 31, ES: 32, RJ: 33, SP: 35,
  PR: 41, SC: 42, RS: 43,
  MS: 50, MT: 51, GO: 52, DF: 53,
};

export const isUf = (value: string) => value in UF_CODES;

/** O município pertence à UF: os dois primeiros dígitos do código IBGE são os da UF. */
export const cityMatchesState = (cityCode: string, uf: string) => cityCode.slice(0, 2) === String(UF_CODES[uf] ?? '');
