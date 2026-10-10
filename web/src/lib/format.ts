import type { CancelledFrom, DiscountType, OrderStatus } from './types';

const money = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' });
const quantity = new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 3 });
const percent = new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 2 });
const dateFormat = new Intl.DateTimeFormat('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric' });
const timeFormat = new Intl.DateTimeFormat('pt-BR', { hour: '2-digit', minute: '2-digit' });

export const formatMoney = (value: number) => money.format(value);
export const formatQuantity = (value: number) => quantity.format(value);
/** 12.5 -> "12,5%". */
export const formatPercent = (value: number) => `${percent.format(value)}%`;
export const formatDate = (iso: string) => dateFormat.format(new Date(iso));
export const formatDateTime = (iso: string) => `${dateFormat.format(new Date(iso))} ${timeFormat.format(new Date(iso))}`;

export const formatOrderNumber = (id: number) => String(id).padStart(6, '0');
/** "Orçamento", "Pedido", "Orçamento perdido" ou "Pedido cancelado". */
export function documentLabel(status: OrderStatus, cancelledFrom: CancelledFrom = null) {
  if (status === 'cancelled') return cancelledFrom === 'quote' ? 'Orçamento perdido' : 'Pedido cancelado';
  return status === 'quote' ? 'Orçamento' : 'Pedido';
}

/** WhatsApp guardado só com dígitos ("5511987654321") no formato "+55 (11) 98765-4321". */
export function formatWhatsapp(digits: string) {
  if (/^55\d{10,11}$/.test(digits)) {
    const ddd = digits.slice(2, 4);
    const local = digits.slice(4);
    const cut = local.length - 4;
    return `+55 (${ddd}) ${local.slice(0, cut)}-${local.slice(cut)}`;
  }
  return `+${digits}`;
}

/**
 * Lê número digitado no padrão brasileiro: "2,5" e "1.500,75".
 * Sem vírgula, ponto seguido de 3 dígitos é milhar ("1.500" = 1500); senão é decimal ("1.5").
 */
export function parseDecimal(text: string): number | null {
  const value = text.trim().replace(/\s/g, '');
  if (!value) return null;
  let normalized: string;
  if (value.includes(',')) normalized = value.replace(/\./g, '').replace(',', '.');
  else if (/^\d{1,3}(\.\d{3})+$/.test(value)) normalized = value.replace(/\./g, '');
  else normalized = value;
  if (!/^\d+(\.\d+)?$/.test(normalized)) return null;
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

/** Número para o campo de texto: 2.5 -> "2,5". */
export const decimalToInput = (value: number) => String(value).replace('.', ',');

/**
 * Subtotal em centavos com o mesmo arredondamento do banco
 * (round(quantidade * preço, 2)), sem erro de ponto flutuante.
 */
export function lineTotalCents(unitPrice: number, qty: number) {
  return Math.round((Math.round(unitPrice * 100) * Math.round(qty * 1000)) / 1000);
}

/** Desconto em centavos, com o mesmo arredondamento do banco (round(subtotal * % / 100, 2)). */
export function discountCents(subtotalCents: number, type: DiscountType, value: number) {
  return type === 'percent' ? Math.round((subtotalCents * Math.round(value * 100)) / 10000) : Math.round(value * 100);
}

export const centsToMoney = (cents: number) => formatMoney(cents / 100);

export const initials = (name: string) =>
  name
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? '')
    .join('');

/** "2026-10-20" (dia, sem hora) para "20/10/2026". */
export function formatDay(value: string) {
  const [year, month, day] = value.slice(0, 10).split('-');
  return `${day}/${month}/${year}`;
}

/** Dia de hoje no navegador, como "2026-10-10". */
export function todayIso(date = new Date()) {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** Soma dias a "2026-10-10". */
export function addDays(iso: string, days: number) {
  const [y, m, d] = iso.split('-').map(Number);
  return todayIso(new Date(y!, m! - 1, d! + days));
}

/** "sexta-feira, 10 de outubro". */
export function formatWeekday(iso: string) {
  const [y, m, d] = iso.split('-').map(Number);
  return new Intl.DateTimeFormat('pt-BR', { weekday: 'long', day: 'numeric', month: 'long' }).format(new Date(y!, m! - 1, d!));
}
