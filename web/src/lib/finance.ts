import type { PaymentKind } from './types';

export const KIND_LABEL: Record<PaymentKind, string> = {
  cash: 'Dinheiro',
  pix: 'PIX',
  card: 'Cartão',
  boleto: 'Boleto',
  store_credit: 'Crediário',
  other: 'Outro',
};

/** "À vista", "3x (30/60/90 dias)", "1x em 30 dias". */
export function termsLabel(m: { installments: number; first_due_days: number; interval_days: number }) {
  if (m.installments === 1) return m.first_due_days === 0 ? 'À vista' : `Em ${m.first_due_days} dias`;
  const days = Array.from({ length: Math.min(m.installments, 4) }, (_, i) => m.first_due_days + i * m.interval_days);
  const label = days.join('/') + (m.installments > 4 ? '...' : '');
  return `${m.installments}x (${label} dias)`;
}
