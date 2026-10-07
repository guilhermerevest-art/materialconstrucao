const BRAZIL_DDI = '55';

/** 55 + DDD (dois dígitos de 1 a 9) + 8 ou 9 dígitos. Com 9 dígitos é celular e começa com 9. */
function isBrazilianNumber(digits: string) {
  if (!/^55[1-9]{2}\d{8,9}$/.test(digits)) return false;
  const local = digits.slice(4);
  return local.length === 8 || local.startsWith('9');
}

/**
 * Converte o que o vendedor digitou no formato que a EvolutionAPI espera:
 * só dígitos, com DDI. Sem DDI, assume Brasil e acrescenta 55.
 * Números de outros países precisam começar com + ou 00.
 * Retorna null quando não dá para montar um número válido.
 *
 *   "(11) 98765-4321"     -> "5511987654321"
 *   "+55 11 98765 4321"   -> "5511987654321"
 *   "+1 (415) 555-2671"   -> "14155552671"
 */
export function normalizeWhatsapp(input: string): string | null {
  const raw = input.trim();
  const international = raw.startsWith('+') || raw.startsWith('00');
  let digits = raw.replace(/\D/g, '');

  if (international) {
    digits = digits.replace(/^00/, '');
    if (digits.startsWith(BRAZIL_DDI)) return isBrazilianNumber(digits) ? digits : null;
    return /^[1-9]\d{7,14}$/.test(digits) ? digits : null;
  }

  // Zero de longa distância ("011 98765-4321").
  digits = digits.replace(/^0+/, '');
  if (digits.length === 10 || digits.length === 11) digits = BRAZIL_DDI + digits;
  return isBrazilianNumber(digits) ? digits : null;
}

/** Número já normalizado (guardado no banco) no formato de exibição: "+55 (11) 98765-4321". */
export function formatWhatsapp(digits: string): string {
  if (/^55\d{10,11}$/.test(digits)) {
    const ddd = digits.slice(2, 4);
    const local = digits.slice(4);
    const cut = local.length - 4;
    return `+55 (${ddd}) ${local.slice(0, cut)}-${local.slice(cut)}`;
  }
  return `+${digits}`;
}
