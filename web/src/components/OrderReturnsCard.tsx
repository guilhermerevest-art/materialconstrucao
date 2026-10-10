import { useQuery } from '@tanstack/react-query';
import { Undo2 } from 'lucide-react';
import { useState } from 'react';
import { api } from '@/lib/api';
import { formatDateTime, formatMoney, formatQuantity } from '@/lib/format';
import type { Order, OrderReturnsView, RefundMethod } from '@/lib/types';
import { ReturnDialog } from './ReturnDialog';
import { Button } from './ui/button';
import { Card, CardContent, CardHeader, CardTitle } from './ui/card';

export const REFUND_LABEL: Record<RefundMethod, string> = {
  cash: 'dinheiro',
  pix: 'PIX',
  card: 'estorno no cartão',
  credit: 'crédito para troca',
  fiado: 'abatido no fiado',
  receivables: 'abatido nas parcelas',
  none: 'sem devolver valor',
};

/** Devoluções do pedido e o botão para registrar outra (enquanto houver o que voltar). */
export function OrderReturnsCard({ order }: { order: Order }) {
  const [open, setOpen] = useState(false);
  const query = useQuery({
    queryKey: ['order-returns', order.id],
    queryFn: () => api<OrderReturnsView>(`/orders/${order.id}/returns`),
  });
  const data = query.data;
  if (!data) return null;
  const canReturn = data.items.some((i) => i.returnable > 0);
  if (!canReturn && !data.returns.length) return null;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Devoluções</CardTitle>
        {canReturn && (
          <Button variant="outline" size="sm" onClick={() => setOpen(true)}>
            <Undo2 />
            Devolução ou troca
          </Button>
        )}
      </CardHeader>
      {data.returns.length > 0 && (
        <CardContent className="grid gap-3 text-sm">
          {data.returns.map((r) => (
            <div key={r.id} className="grid gap-0.5 border-t border-border pt-3 first:border-t-0 first:pt-0">
              <p className="flex flex-wrap justify-between gap-2">
                <span>
                  <span className="font-medium">{formatMoney(r.amount)}</span>
                  <span className="text-muted-foreground"> · {REFUND_LABEL[r.refund_method]}</span>
                </span>
                <span className="text-[13px] text-muted-foreground">
                  {formatDateTime(r.created_at)} · {r.user_name}
                </span>
              </p>
              <p className="text-[13px] text-muted-foreground">
                {r.items
                  .map((i) => `${formatQuantity(i.quantity)} ${i.unit} ${i.product_name}${i.restock ? '' : ' (avariado)'}`)
                  .join(', ')}{' '}
                · {r.reason}
              </p>
            </div>
          ))}
        </CardContent>
      )}
      {open && <ReturnDialog order={order} view={data} onClose={() => setOpen(false)} />}
    </Card>
  );
}
