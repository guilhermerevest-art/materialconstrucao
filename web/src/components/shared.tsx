import { ChevronLeft, ChevronRight } from 'lucide-react';
import type { ReactNode } from 'react';
import { centsToMoney, documentLabel } from '@/lib/format';
import type { CancelledFrom, OrderStatus } from '@/lib/types';
import { cn } from '@/lib/utils';
import { Button } from './ui/button';
import { Badge } from './ui/misc';

export function BrandMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 32 32" className={cn('size-8 shrink-0', className)} aria-hidden>
      <rect width="32" height="32" rx="6" fill="#C2410C" />
      <g fill="#FFFFFF">
        <rect x="6" y="8" width="9" height="4" rx="0.5" />
        <rect x="17" y="8" width="9" height="4" rx="0.5" />
        <rect x="6" y="14" width="4" height="4" rx="0.5" />
        <rect x="12" y="14" width="9" height="4" rx="0.5" />
        <rect x="23" y="14" width="3" height="4" rx="0.5" />
        <rect x="6" y="20" width="9" height="4" rx="0.5" />
        <rect x="17" y="20" width="9" height="4" rx="0.5" />
      </g>
    </svg>
  );
}

/** Ícone do WhatsApp (o lucide não tem ícones de marca). */
export function WhatsAppIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" className={className} aria-hidden>
      <path d="M17.47 14.38c-.3-.15-1.75-.86-2.02-.96-.27-.1-.47-.15-.66.15-.2.3-.76.96-.93 1.16-.17.2-.34.22-.64.07-.3-.15-1.25-.46-2.38-1.47-.88-.79-1.47-1.76-1.65-2.06-.17-.3-.02-.46.13-.6.14-.14.3-.35.45-.52.15-.17.2-.3.3-.5.1-.2.05-.37-.03-.52-.07-.15-.66-1.6-.91-2.19-.24-.58-.48-.5-.66-.5h-.57c-.2 0-.52.07-.79.37-.27.3-1.04 1.02-1.04 2.48s1.06 2.88 1.21 3.08c.15.2 2.1 3.2 5.08 4.48.71.31 1.26.49 1.69.63.71.22 1.36.19 1.87.12.57-.09 1.75-.72 2-1.41.25-.69.25-1.29.17-1.41-.07-.12-.27-.2-.57-.35zM12.05 21.5h-.01a9.4 9.4 0 0 1-4.8-1.31l-.34-.2-3.56.93.95-3.47-.22-.36a9.4 9.4 0 0 1-1.44-5.02c0-5.2 4.23-9.43 9.43-9.43 2.52 0 4.89.98 6.67 2.77a9.37 9.37 0 0 1 2.76 6.67c0 5.2-4.23 9.42-9.44 9.42zm8.03-17.45A11.27 11.27 0 0 0 12.05.72C5.79.72.69 5.81.69 12.08c0 2 .52 3.96 1.52 5.68L.6 23.6l5.98-1.57a11.33 11.33 0 0 0 5.46 1.39h.01c6.26 0 11.36-5.1 11.36-11.36 0-3.03-1.18-5.89-3.33-8.03z" />
    </svg>
  );
}

export function StatusBadge({ status, cancelledFrom = null }: { status: OrderStatus; cancelledFrom?: CancelledFrom }) {
  if (status === 'cancelled') return <Badge variant="danger">{cancelledFrom === 'quote' ? 'Perdido' : 'Cancelado'}</Badge>;
  return <Badge variant={status}>{documentLabel(status)}</Badge>;
}

export function PageHeader({
  title,
  description,
  actions,
  className,
}: {
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn('mb-6 flex flex-wrap items-end justify-between gap-4', className)}>
      <div className="grid gap-1">
        <h1 className="text-2xl font-bold tracking-tight">{title}</h1>
        {description && <p className="text-sm text-muted-foreground">{description}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}

/** Total no formato de etiqueta de preço de prateleira. */
export function PriceTag({ cents, caption, className }: { cents: number; caption?: ReactNode; className?: string }) {
  return (
    <div
      className={cn(
        'relative rounded-lg border border-tag-edge bg-tag py-4 pr-5 pl-9 text-foreground',
        className,
      )}
    >
      {/* Furo da etiqueta */}
      <span className="absolute top-1/2 left-3.5 size-2.5 -translate-y-1/2 rounded-full border border-tag-edge bg-card" />
      <div className="flex items-baseline justify-between gap-3">
        <span className="text-sm font-semibold">Total</span>
        {caption && <span className="text-[13px] font-medium text-foreground/70">{caption}</span>}
      </div>
      <output className="mt-0.5 block text-right text-4xl leading-tight font-bold tracking-tight tabular-nums" aria-live="polite">
        {centsToMoney(cents)}
      </output>
    </div>
  );
}

/** Subtotal e desconto acima da etiqueta de total. Sem desconto, não aparece. */
export function DiscountBreakdown({
  subtotalCents,
  discountCents,
  discountLabel,
}: {
  subtotalCents: number;
  discountCents: number;
  discountLabel: string;
}) {
  if (discountCents <= 0) return null;
  return (
    <dl className="grid gap-1.5 rounded-lg border border-border bg-card px-5 py-3 text-sm">
      <div className="flex justify-between gap-3">
        <dt className="text-muted-foreground">Subtotal</dt>
        <dd className="tabular-nums">{centsToMoney(subtotalCents)}</dd>
      </div>
      <div className="flex justify-between gap-3">
        <dt className="text-muted-foreground">{discountLabel}</dt>
        <dd className="font-medium text-success tabular-nums">- {centsToMoney(discountCents)}</dd>
      </div>
    </dl>
  );
}

export function EmptyState({
  title,
  description,
  action,
  className,
}: {
  title: string;
  description?: ReactNode;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn('flex flex-col items-center gap-3 px-6 py-14 text-center', className)}>
      <EmptyIllustration />
      <h2 className="mt-2 text-lg font-semibold">{title}</h2>
      {description && <p className="max-w-sm text-sm text-muted-foreground">{description}</p>}
      {action && <div className="mt-2">{action}</div>}
    </div>
  );
}

/** Prancheta de pedido vazia ao lado de uma pilha de tijolos. */
function EmptyIllustration() {
  return (
    <svg viewBox="0 0 160 110" className="h-28 w-auto" aria-hidden>
      <rect x="0" y="100" width="160" height="4" rx="2" fill="#D8DDE1" />
      <rect x="28" y="14" width="64" height="86" rx="6" fill="#FFFFFF" stroke="#22303C" strokeWidth="2.5" />
      <rect x="46" y="8" width="28" height="12" rx="3" fill="#22303C" />
      <rect x="40" y="34" width="40" height="4" rx="2" fill="#D8DDE1" />
      <rect x="40" y="46" width="32" height="4" rx="2" fill="#D8DDE1" />
      <rect x="40" y="58" width="36" height="4" rx="2" fill="#D8DDE1" />
      <rect x="40" y="78" width="22" height="10" rx="2" fill="#FFD233" />
      <g fill="#C2410C" stroke="#F1F3F4" strokeWidth="2">
        <rect x="100" y="84" width="24" height="16" rx="2" />
        <rect x="124" y="84" width="24" height="16" rx="2" />
        <rect x="112" y="68" width="24" height="16" rx="2" />
      </g>
    </svg>
  );
}

export function Pagination({
  page,
  pageSize,
  total,
  onPageChange,
}: {
  page: number;
  pageSize: number;
  total: number;
  onPageChange: (page: number) => void;
}) {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  if (total <= pageSize) return null;
  const from = (page - 1) * pageSize + 1;
  const to = Math.min(page * pageSize, total);
  return (
    <div className="flex items-center justify-between gap-3 border-t border-border px-4 py-3 text-sm">
      <span className="text-muted-foreground tabular-nums">
        {from}–{to} de {total}
      </span>
      <div className="flex gap-2">
        <Button variant="outline" size="sm" disabled={page <= 1} onClick={() => onPageChange(page - 1)}>
          <ChevronLeft />
          Anterior
        </Button>
        <Button variant="outline" size="sm" disabled={page >= pages} onClick={() => onPageChange(page + 1)}>
          Próxima
          <ChevronRight />
        </Button>
      </div>
    </div>
  );
}
