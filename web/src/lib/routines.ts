import type { RoutineFrequency, RoutineStatus } from './types';

const WEEKDAYS = ['dom', 'seg', 'ter', 'qua', 'qui', 'sex', 'sáb'];

/** "Seg a sáb", "Toda segunda", "Dia 5 de cada mês", "Quando precisar". */
export function scheduleLabel(t: { frequency: RoutineFrequency; weekdays: number[]; month_day: number | null; due_time: string | null }) {
  const time = t.due_time ? `, até ${t.due_time}` : '';
  if (t.frequency === 'on_demand') return 'Quando precisar';
  if (t.frequency === 'monthly') return `Dia ${t.month_day} de cada mês${time}`;
  const days = [...t.weekdays].sort();
  if (days.length === 7) return `Todo dia${time}`;
  if (days.join() === '1,2,3,4,5,6') return `Seg a sáb${time}`;
  if (days.join() === '1,2,3,4,5') return `Seg a sex${time}`;
  return `${days.map((d) => WEEKDAYS[d]).join(', ')}${time}`;
}

export const WEEKDAY_OPTIONS = WEEKDAYS.map((label, value) => ({ value, label }));

export const ROUTINE_STATUS: Record<RoutineStatus, { label: string; variant: 'neutral' | 'warning' | 'danger' | 'success' | 'quote' }> = {
  pending: { label: 'Pendente', variant: 'warning' },
  overdue: { label: 'Atrasada', variant: 'danger' },
  in_progress: { label: 'Em andamento', variant: 'quote' },
  done: { label: 'Feita', variant: 'success' },
  not_due: { label: 'Não é hoje', variant: 'neutral' },
};

export const COUNT_STATUS = {
  counting: { label: 'Contando', variant: 'quote' },
  submitted: { label: 'Para conferir', variant: 'warning' },
  reviewed: { label: 'Conferida', variant: 'success' },
  cancelled: { label: 'Cancelada', variant: 'danger' },
} as const;
