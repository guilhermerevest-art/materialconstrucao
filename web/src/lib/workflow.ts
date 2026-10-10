import type { DeliveryType } from './types';

export const DELIVERY_LABEL: Record<DeliveryType, string> = {
  pickup: 'Retirada na loja',
  delivery: 'Entrega',
};

export const MESSAGE_PLACEHOLDERS = '{cliente}, {pedido}, {loja} e {etapa}';

/** Minutos desde que o pedido entrou na etapa. */
export const elapsedMinutes = (enteredAt: string, now: number) => Math.max(0, (now - new Date(enteredAt).getTime()) / 60_000);

/** "8 min", "2 h 05", "3 d 4 h". */
export function formatElapsed(minutes: number) {
  const total = Math.floor(minutes);
  if (total < 60) return `${total} min`;
  const hours = Math.floor(total / 60);
  if (hours < 24) return `${hours} h ${String(total % 60).padStart(2, '0')}`;
  return `${Math.floor(hours / 24)} d ${hours % 24} h`;
}

/** Em dia, perto de estourar (75% do tempo esperado) ou atrasado. */
export type SlaState = 'ok' | 'warning' | 'late';

export function slaState(minutes: number, slaMinutes: number | null): SlaState {
  if (!slaMinutes) return 'ok';
  if (minutes >= slaMinutes) return 'late';
  if (minutes >= slaMinutes * 0.75) return 'warning';
  return 'ok';
}

/** "90" -> "1 h 30" para mostrar o tempo esperado. */
export const formatSla = (slaMinutes: number) => formatElapsed(slaMinutes);
