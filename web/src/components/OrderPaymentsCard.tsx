import { useQuery } from '@tanstack/react-query';
import { HandCoins } from 'lucide-react';
import { useState } from 'react';
import { api } from '@/lib/api';
import { formatDateTime, formatDay, formatMoney } from '@/lib/format';
import type { Order, Receivable, ReceivablePayment } from '@/lib/types';
import { cn } from '@/lib/utils';
import { ReceiveDialog } from './ReceiveDialog';
import { Button } from './ui/button';
import { Card, CardContent, CardHeader, CardTitle } from './ui/card';
import { Badge, Skeleton } from './ui/misc';

/** Parcelas do pedido e o que já foi recebido (só com o financeiro ligado). */
export function OrderPaymentsCard({ order }: { order: Order }) {
  const [receiving, setReceiving] = useState<Receivable | null>(null);
  const query = useQuery({
    queryKey: ['order-receivables', order.id],
    queryFn: () => api<{ items: Receivable[]; payments: ReceivablePayment[] }>(`/orders/${order.id}/receivables`),
  });
  if (query.isPending) return <Skeleton className="h-32" />;
  const items = query.data?.items ?? [];
  if (!items.length) return null;
  const open = items.filter((r) => r.status === 'open').reduce((sum, r) => sum + r.remaining, 0);
  const payments = (query.data?.payments ?? []).filter((p) => !p.reversed_at);

  return (
    <Card>
      <CardHeader>
        <CardTitle>Pagamento</CardTitle>
        {open > 0 ? <Badge variant="warning">Falta {formatMoney(open)}</Badge> : <Badge variant="success">Pago</Badge>}
      </CardHeader>
      <CardContent className="grid gap-2">
        <ul className="grid gap-1.5 text-sm">
          {items.map((r) => (
            <li key={r.id} className="flex items-center gap-2">
              <span className="w-10 text-muted-foreground tabular-nums">
                {r.installment}/{r.installments}
              </span>
              <span className={cn('flex-1 tabular-nums', r.overdue && 'font-semibold text-destructive')}>{formatDay(r.due_date)}</span>
              <span className="tabular-nums">{formatMoney(r.amount)}</span>
              {r.status === 'open' ? (
                <Button size="sm" variant="outline" className="h-7 px-2" onClick={() => setReceiving(r)}>
                  <HandCoins />
                  Receber
                </Button>
              ) : (
                <Badge variant={r.status === 'paid' ? 'success' : 'danger'}>{r.status === 'paid' ? 'Paga' : 'Cancelada'}</Badge>
              )}
            </li>
          ))}
        </ul>
        {payments.length > 0 && (
          <div className="mt-2 border-t border-border pt-2 text-[13px] text-muted-foreground">
            {payments.map((p) => (
              <p key={p.id}>
                {formatMoney(p.amount)} em {p.method_name} · {formatDateTime(p.received_at)}
                {p.user_name ? ` · ${p.user_name}` : ''}
              </p>
            ))}
          </div>
        )}
      </CardContent>
      {receiving && <ReceiveDialog receivable={receiving} onClose={() => setReceiving(null)} />}
    </Card>
  );
}
