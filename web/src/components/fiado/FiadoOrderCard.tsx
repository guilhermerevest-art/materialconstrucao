import { useQuery } from '@tanstack/react-query';
import { NotebookPen } from 'lucide-react';
import { Link } from 'react-router';
import { api } from '@/lib/api';
import { formatDay, formatMoney } from '@/lib/format';
import type { FiadoAccount, Order } from '@/lib/types';
import { Button } from '../ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '../ui/card';
import { Badge } from '../ui/misc';
import { fiadoAccountKey } from './FiadoReceiveDialog';

/** Pedido vendido no fiado: o lançamento na caderneta e o saldo do cliente. */
export function FiadoOrderCard({ order }: { order: Order }) {
  const account = useQuery({
    queryKey: fiadoAccountKey(order.client_id),
    queryFn: () => api<FiadoAccount>(`/fiado/accounts/${order.client_id}`),
  });
  const data = account.data;
  if (!data) return null;
  const entry = data.entries.find((e) => e.order_id === order.id && e.kind === 'purchase');
  if (!entry) return null;
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <NotebookPen className="size-4" aria-hidden />
          Fiado
        </CardTitle>
        {entry.cancelled_at ? <Badge variant="danger">Saiu da conta</Badge> : <Badge variant="warning">Na caderneta</Badge>}
      </CardHeader>
      <CardContent className="grid gap-3 text-sm">
        {!entry.cancelled_at && entry.due_date && (
          <p>
            Vence em <strong className="tabular-nums">{formatDay(entry.due_date)}</strong>.
          </p>
        )}
        <p className="text-muted-foreground">
          Saldo do cliente: <span className="font-medium text-foreground tabular-nums">{formatMoney(Math.max(0, data.account.balance))}</span>
          {data.account.overdue > 0 && <span className="text-destructive"> · {formatMoney(data.account.overdue)} vencido</span>}
        </p>
        <Button asChild variant="outline" size="sm" className="justify-self-start">
          <Link to={`/fiado/${order.client_id}`}>Abrir a conta</Link>
        </Button>
      </CardContent>
    </Card>
  );
}
