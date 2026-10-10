import { useMutation, useQueryClient } from '@tanstack/react-query';
import { ArrowRight, Ban, CircleCheck, Timer, Undo2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { api, ApiError } from '@/lib/api';
import { formatDateTime } from '@/lib/format';
import type { Order, OrderWorkflow, StageNotification } from '@/lib/types';
import { cn } from '@/lib/utils';
import { elapsedMinutes, formatElapsed, slaState } from '@/lib/workflow';
import { Button } from './ui/button';
import { Card, CardContent, CardHeader, CardTitle } from './ui/card';
import { Label, Textarea } from './ui/input';
import { Badge } from './ui/misc';

/** Etapa atual do pedido no fluxo, os botões de avançar/voltar e o histórico. */
export function OrderProgressCard({ order, workflow }: { order: Order; workflow: OrderWorkflow }) {
  const queryClient = useQueryClient();
  const [backOpen, setBackOpen] = useState(false);
  const [note, setNote] = useState('');
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);

  const move = useMutation({
    mutationFn: (direction: 'next' | 'previous') =>
      api<{ order: Order; notification: StageNotification | null }>(`/orders/${order.id}/stage`, {
        method: 'POST',
        body: { direction, expected_stage_id: workflow.stage_id, note: direction === 'previous' ? note : null },
      }),
    onSuccess: ({ order: next, notification }) => {
      queryClient.setQueryData(['order', order.id], next);
      queryClient.invalidateQueries({ queryKey: ['orders'] });
      queryClient.invalidateQueries({ queryKey: ['monitor'] });
      // Chegar na etapa final registra a entrega do que faltava.
      queryClient.invalidateQueries({ queryKey: ['order-deliveries', order.id] });
      setBackOpen(false);
      setNote('');
      toast.success(`Pedido em "${next.workflow?.stage_name}".`);
      if (notification?.status === 'sent') toast.success(`${next.client_name} foi avisado pelo WhatsApp.`);
      if (notification?.status === 'failed') toast.warning(notification.error);
    },
    onError: (err) => {
      toast.error(err instanceof ApiError ? err.message : 'Não foi possível mudar a etapa.');
      if (err instanceof ApiError && err.code === 'STAGE_CHANGED') {
        queryClient.invalidateQueries({ queryKey: ['order', order.id] });
      }
    },
  });

  const minutes = elapsedMinutes(workflow.entered_at, now);
  const state = workflow.is_final ? 'ok' : slaState(minutes, workflow.sla_minutes);
  const cancelled = order.status === 'cancelled';
  const events = [...workflow.events].reverse();

  return (
    <Card>
      <CardHeader>
        <CardTitle>Andamento</CardTitle>
        {cancelled ? (
          <Badge variant="danger">
            <Ban className="size-3.5" aria-hidden />
            Cancelado
          </Badge>
        ) : workflow.is_final ? (
          <Badge variant="success">
            <CircleCheck className="size-3.5" aria-hidden />
            Concluído
          </Badge>
        ) : (
          <Badge
            variant={state === 'late' ? 'danger' : state === 'warning' ? 'warning' : 'neutral'}
            title={workflow.sla_minutes ? `Tempo esperado: ${formatElapsed(workflow.sla_minutes)}` : undefined}
          >
            <Timer className="size-3.5" aria-hidden />
            {formatElapsed(minutes)} nesta etapa
          </Badge>
        )}
      </CardHeader>
      <CardContent className="grid gap-4">
        <div>
          {cancelled && <p className="text-sm text-muted-foreground">Parou em</p>}
          <p className="text-lg leading-tight font-semibold">{workflow.stage_name}</p>
          {workflow.sector_name && !workflow.is_final && !cancelled && (
            <p className="text-sm text-muted-foreground">Setor {workflow.sector_name}</p>
          )}
        </div>

        {workflow.can_move ? (
          <div className="grid gap-2">
            {workflow.next_stage && (
              <Button variant="steel" className="w-full justify-between" loading={move.isPending && !backOpen} onClick={() => move.mutate('next')}>
                <span className="truncate">Avançar para {workflow.next_stage.name}</span>
                <ArrowRight />
              </Button>
            )}
            {workflow.previous_stage && !backOpen && (
              <Button variant="ghost" className="w-full" onClick={() => setBackOpen(true)}>
                <Undo2 />
                Voltar para {workflow.previous_stage.name}
              </Button>
            )}
            {backOpen && workflow.previous_stage && (
              <form
                className="grid gap-2 rounded-md border border-border p-3"
                onSubmit={(event) => {
                  event.preventDefault();
                  move.mutate('previous');
                }}
              >
                <Label htmlFor="voltar-motivo">Motivo (opcional)</Label>
                <Textarea
                  id="voltar-motivo"
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                  maxLength={300}
                  rows={2}
                  placeholder="Ex.: faltou um item na separação"
                  autoFocus
                />
                <div className="flex justify-end gap-2">
                  <Button type="button" variant="ghost" size="sm" onClick={() => setBackOpen(false)}>
                    Cancelar
                  </Button>
                  <Button type="submit" variant="outline" size="sm" loading={move.isPending}>
                    Voltar para {workflow.previous_stage.name}
                  </Button>
                </div>
              </form>
            )}
          </div>
        ) : (
          !workflow.is_final &&
          !cancelled && (
            <p className="text-[13px] text-muted-foreground">
              Quem é do setor {workflow.sector_name} avança este pedido.
            </p>
          )
        )}

        <div>
          <p className="mb-2 text-sm text-muted-foreground">Histórico</p>
          <ol className="grid gap-3 border-l-2 border-border pl-4">
            {events.map((event, index) => (
              <li key={event.id} className="relative text-sm">
                <span
                  className={cn(
                    'absolute top-1.5 -left-[21px] size-2.5 rounded-full border-2 border-card',
                    index === 0 ? 'bg-primary' : 'bg-input',
                  )}
                  aria-hidden
                />
                <p className="font-medium">
                  {event.from_stage_name ? event.to_stage_name : `Entrou em ${event.to_stage_name}`}
                </p>
                <p className="text-[13px] text-muted-foreground">
                  {event.user_name} · {formatDateTime(event.created_at)}
                </p>
                {event.note && <p className="mt-0.5 text-[13px] italic">{event.note}</p>}
              </li>
            ))}
          </ol>
        </div>
      </CardContent>
    </Card>
  );
}
