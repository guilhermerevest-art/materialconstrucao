const money = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' });
const quantity = new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 3 });
const percent = new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 2 });

export const formatMoney = (value: number) => money.format(value);
export const formatQuantity = (value: number) => quantity.format(value);
/** 12.5 -> "12,5%". */
export const formatPercent = (value: number) => `${percent.format(value)}%`;

/** "07/10/2026 às 14:32" no fuso da loja. */
export function formatDateTime(value: Date, timeZone: string) {
  const date = new Intl.DateTimeFormat('pt-BR', { timeZone, day: '2-digit', month: '2-digit', year: 'numeric' }).format(value);
  const time = new Intl.DateTimeFormat('pt-BR', { timeZone, hour: '2-digit', minute: '2-digit' }).format(value);
  return `${date} às ${time}`;
}

/** Dia de hoje ("2026-10-10") no fuso da loja. */
export function todayIn(timeZone: string, date = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
}

export type OrderStatus = 'quote' | 'order' | 'cancelled';

export const formatOrderNumber = (id: number) => String(id).padStart(6, '0');

/** "Orçamento", "Pedido", "Orçamento perdido" ou "Pedido cancelado". */
export function documentLabel(status: OrderStatus, cancelledFrom: 'quote' | 'order' | null = null) {
  if (status === 'cancelled') return cancelledFrom === 'quote' ? 'Orçamento perdido' : 'Pedido cancelado';
  return status === 'quote' ? 'Orçamento' : 'Pedido';
}
