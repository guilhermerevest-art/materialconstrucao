import type { DeliveryKind, DeliveryPeriod, DeliveryStatus } from './types';

export const KIND_LABEL: Record<DeliveryKind, string> = { pickup: 'Retirada', delivery: 'Entrega' };
export const PERIOD_LABEL: Record<DeliveryPeriod, string> = { morning: 'Manhã', afternoon: 'Tarde' };
export const STATUS_LABEL: Record<DeliveryStatus, string> = {
  scheduled: 'Agendada',
  in_route: 'Em rota',
  done: 'Entregue',
  cancelled: 'Cancelada',
};
export const STATUS_VARIANT: Record<DeliveryStatus, 'neutral' | 'order' | 'success' | 'danger'> = {
  scheduled: 'neutral',
  in_route: 'order',
  done: 'success',
  cancelled: 'danger',
};

/** Link do endereço no Google Maps, para o motorista abrir no celular. */
export const mapsUrl = (address: string) => `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(address)}`;
