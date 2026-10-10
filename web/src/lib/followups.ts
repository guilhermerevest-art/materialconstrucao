import type { FollowupChannel } from './types';

export const CHANNEL_LABEL: Record<FollowupChannel, string> = {
  whatsapp: 'WhatsApp',
  call: 'Ligação',
  visit: 'Visita',
  other: 'Outro',
};

/** "hoje", "atrasado 2 dias", "em 3 dias". */
export function dueLabel(daysLate: number) {
  if (daysLate === 0) return 'hoje';
  if (daysLate > 0) return daysLate === 1 ? 'atrasado 1 dia' : `atrasado ${daysLate} dias`;
  return -daysLate === 1 ? 'amanhã' : `em ${-daysLate} dias`;
}
