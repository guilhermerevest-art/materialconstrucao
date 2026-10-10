import { useQuery } from '@tanstack/react-query';
import { MessageCircleReply } from 'lucide-react';
import { useState } from 'react';
import { api } from '@/lib/api';
import { CHANNEL_LABEL, dueLabel } from '@/lib/followups';
import { daysBetween, formatDateTime, formatDay, todayIso } from '@/lib/format';
import type { FollowupHistory, Order } from '@/lib/types';
import { FollowupDialog } from './FollowupDialog';
import { Button } from './ui/button';
import { Card, CardContent, CardHeader, CardTitle } from './ui/card';
import { Badge, Skeleton } from './ui/misc';

/** Retomada do orçamento: quando voltar a falar com o cliente e o que já foi conversado. */
export function FollowupCard({ order }: { order: Order }) {
  const [open, setOpen] = useState(false);
  const query = useQuery({
    queryKey: ['order-followups', order.id],
    queryFn: () => api<FollowupHistory>(`/orders/${order.id}/followups`),
  });
  if (query.isPending) return <Skeleton className="h-32" />;
  const data = query.data;
  if (!data) return null;
  const daysLate = daysBetween(data.due_on, todayIso());

  return (
    <Card>
      <CardHeader>
        <CardTitle>Retomada</CardTitle>
        <Badge variant={daysLate > 0 ? 'danger' : daysLate === 0 ? 'warning' : 'neutral'}>
          {daysLate < 0 ? `${formatDay(data.due_on)} (${dueLabel(daysLate)})` : `Retomar ${dueLabel(daysLate)}`}
        </Badge>
      </CardHeader>
      <CardContent className="grid gap-3">
        <p className="text-[13px] text-muted-foreground">Último contato em {formatDateTime(data.last_contact_at)}</p>
        <Button variant="outline" className="w-full" onClick={() => setOpen(true)}>
          <MessageCircleReply />
          Retomar contato
        </Button>
        {data.items.length > 0 && (
          <ol className="grid gap-2.5 border-t border-border pt-3 text-sm">
            {data.items.map((item) => (
              <li key={item.id} className="grid gap-0.5">
                <p className="text-[13px] text-muted-foreground">
                  <span className="font-medium text-foreground">{CHANNEL_LABEL[item.channel]}</span> · {formatDateTime(item.created_at)} ·{' '}
                  {item.user_name}
                </p>
                {item.note && <p>{item.note}</p>}
                {item.message && <p className="line-clamp-3 text-muted-foreground">“{item.message}”</p>}
                {(item.with_pdf || item.next_on) && (
                  <p className="text-[13px] text-muted-foreground">
                    {item.with_pdf ? 'Com o PDF' : ''}
                    {item.with_pdf && item.next_on ? ' · ' : ''}
                    {item.next_on ? `Combinou retomar em ${formatDay(item.next_on)}` : ''}
                  </p>
                )}
              </li>
            ))}
          </ol>
        )}
      </CardContent>
      {open && (
        <FollowupDialog
          orderId={order.id}
          clientName={order.client_name}
          clientWhatsapp={order.client_whatsapp}
          onClose={() => setOpen(false)}
        />
      )}
    </Card>
  );
}
