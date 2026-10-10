import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CalendarPlus, FileSignature, PackageCheck, Truck, Undo2 } from 'lucide-react';
import { useEffect, useState, type FormEvent } from 'react';
import { Link } from 'react-router';
import { toast } from 'sonner';
import { api, ApiError } from '@/lib/api';
import { useUser } from '@/lib/auth';
import { KIND_LABEL, PERIOD_LABEL, STATUS_LABEL, STATUS_VARIANT } from '@/lib/deliveries';
import { addDays, decimalToInput, formatDateTime, formatDay, formatQuantity, parseDecimal, todayIso } from '@/lib/format';
import type { Delivery, DeliveryKind, DeliveryPeriod, FulfillmentLine, Order, OrderDeliveries } from '@/lib/types';
import { cn } from '@/lib/utils';
import { ReasonDialog } from './ReasonDialog';
import { Button } from './ui/button';
import { Card, CardContent, CardHeader, CardTitle } from './ui/card';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from './ui/dialog';
import { Field, Input, NativeSelect, Textarea } from './ui/input';
import { Alert, Badge, Skeleton } from './ui/misc';
import { Table, TBody, TD, TH, THead, TR } from './ui/table';

type Mode = 'pickup' | 'schedule';

/** Registrar retirada (já feita) ou agendar entrega/retirada, escolhendo quanto de cada item. */
function DeliveryDialog({
  order,
  lines,
  mode,
  onClose,
}: {
  order: Order;
  lines: FulfillmentLine[];
  mode: Mode;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const open = lines.filter((l) => l.pending > 0);
  const [qty, setQty] = useState<Record<number, string>>({});
  const [kind, setKind] = useState<DeliveryKind>(order.delivery_address ? 'delivery' : 'pickup');
  const [date, setDate] = useState(addDays(todayIso(), 1));
  const [period, setPeriod] = useState<DeliveryPeriod | ''>('');
  const [address, setAddress] = useState(order.delivery_address ?? '');
  const [receiver, setReceiver] = useState('');
  const [notes, setNotes] = useState('');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setQty(Object.fromEntries(open.map((l) => [l.order_item_id, decimalToInput(l.pending)])));
    // Só ao abrir: as quantidades sugeridas são o saldo de cada item.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const save = useMutation({
    mutationFn: (items: { order_item_id: number; quantity: number }[]) =>
      api<{ delivery: Delivery }>(`/orders/${order.id}/deliveries`, {
        method: 'POST',
        body:
          mode === 'pickup'
            ? { kind: 'pickup', status: 'done', receiver_name: receiver || null, notes: notes || null, items }
            : {
                kind,
                status: 'scheduled',
                scheduled_date: date,
                period: period || null,
                address: kind === 'delivery' ? address : null,
                notes: notes || null,
                items,
              },
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['order-deliveries', order.id] });
      queryClient.invalidateQueries({ queryKey: ['deliveries'] });
      queryClient.invalidateQueries({ queryKey: ['stock'] });
      toast.success(mode === 'pickup' ? 'Retirada registrada.' : kind === 'delivery' ? 'Entrega agendada.' : 'Retirada agendada.');
      onClose();
    },
    onError: (err) => setError(err instanceof ApiError ? err.message : 'Não foi possível salvar.'),
  });

  function submit(event: FormEvent) {
    event.preventDefault();
    const items = [];
    for (const line of open) {
      const text = qty[line.order_item_id]?.trim() ?? '';
      if (!text) continue;
      const value = parseDecimal(text);
      if (value === null) return setError(`Quantidade inválida em ${line.product_name}.`);
      if (value > line.pending) return setError(`${line.product_name}: faltam só ${formatQuantity(line.pending)} ${line.unit}.`);
      if (value > 0) items.push({ order_item_id: line.order_item_id, quantity: value });
    }
    if (!items.length) return setError('Informe a quantidade de pelo menos um item.');
    if (mode === 'schedule' && kind === 'delivery' && !address.trim()) return setError('Informe o endereço da entrega.');
    setError(null);
    save.mutate(items);
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>{mode === 'pickup' ? 'Registrar retirada' : 'Agendar entrega ou retirada'}</DialogTitle>
          <DialogDescription>
            {mode === 'pickup'
              ? 'O cliente está levando agora. Deixe só o que ele leva; o resto continua no saldo a entregar.'
              : 'Escolha o dia e quanto de cada item vai. O que ficar de fora continua no saldo.'}
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="grid gap-4">
          {error && <Alert variant="danger" title={error} />}
          {mode === 'schedule' && (
            <div className="grid gap-4 sm:grid-cols-3">
              <Field label="Tipo" htmlFor="entrega-tipo">
                <NativeSelect id="entrega-tipo" value={kind} onChange={(e) => setKind(e.target.value as DeliveryKind)}>
                  <option value="delivery">Entrega</option>
                  <option value="pickup">Retirada na loja</option>
                </NativeSelect>
              </Field>
              <Field label="Dia" htmlFor="entrega-dia">
                <Input id="entrega-dia" type="date" value={date} onChange={(e) => setDate(e.target.value)} required />
              </Field>
              <Field label="Período" htmlFor="entrega-periodo">
                <NativeSelect id="entrega-periodo" value={period} onChange={(e) => setPeriod(e.target.value as DeliveryPeriod | '')}>
                  <option value="">Qualquer horário</option>
                  <option value="morning">Manhã</option>
                  <option value="afternoon">Tarde</option>
                </NativeSelect>
              </Field>
            </div>
          )}
          {mode === 'schedule' && kind === 'delivery' && (
            <Field label="Endereço" htmlFor="entrega-endereco">
              <Textarea id="entrega-endereco" value={address} onChange={(e) => setAddress(e.target.value)} rows={2} maxLength={300} />
            </Field>
          )}
          <div className="grid gap-2">
            <p className="text-sm font-medium">Quantidades</p>
            <ul className="divide-y divide-border rounded-md border border-border">
              {open.map((line) => (
                <li key={line.order_item_id} className="flex items-center gap-3 px-3 py-2 text-sm">
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-medium">{line.product_name}</span>
                    <span className="text-[13px] text-muted-foreground">
                      falta {formatQuantity(line.pending)} {line.unit}
                    </span>
                  </span>
                  <Input
                    aria-label={`Quantidade de ${line.product_name}`}
                    inputMode="decimal"
                    className="w-24 text-right"
                    value={qty[line.order_item_id] ?? ''}
                    onChange={(e) => setQty((q) => ({ ...q, [line.order_item_id]: e.target.value }))}
                  />
                  <span className="w-8 text-muted-foreground">{line.unit}</span>
                </li>
              ))}
            </ul>
          </div>
          {mode === 'pickup' && (
            <Field label="Quem retirou (opcional)" htmlFor="retirada-quem">
              <Input id="retirada-quem" value={receiver} onChange={(e) => setReceiver(e.target.value)} maxLength={120} />
            </Field>
          )}
          <Field label="Observação (opcional)" htmlFor="entrega-obs">
            <Input id="entrega-obs" value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={300} />
          </Field>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              Cancelar
            </Button>
            <Button type="submit" loading={save.isPending}>
              {mode === 'pickup' ? 'Registrar retirada' : 'Agendar'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** Saldo a entregar do pedido e as entregas/retiradas dele. */
export function OrderDeliveriesCard({ order }: { order: Order }) {
  const user = useUser();
  const queryClient = useQueryClient();
  const [mode, setMode] = useState<Mode | null>(null);
  const [cancelling, setCancelling] = useState<Delivery | null>(null);

  const query = useQuery({
    queryKey: ['order-deliveries', order.id],
    queryFn: () => api<OrderDeliveries>(`/orders/${order.id}/deliveries`),
  });

  const cancel = useMutation({
    mutationFn: ({ delivery, reason }: { delivery: Delivery; reason: string }) =>
      api(`/deliveries/${delivery.id}/cancel`, { method: 'POST', body: { reason } }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['order-deliveries', order.id] });
      queryClient.invalidateQueries({ queryKey: ['deliveries'] });
      queryClient.invalidateQueries({ queryKey: ['stock'] });
      setCancelling(null);
      toast.success('Feito. A quantidade voltou para o saldo a entregar.');
    },
  });

  const data = query.data;
  if (query.isPending) return <Skeleton className="h-40" />;
  if (!data?.tracking) return null;

  const pendingTotal = data.items.reduce((sum, l) => sum + l.pending, 0);
  const allDone = data.items.every((l) => l.pending === 0 && l.scheduled === 0);
  const visible = data.deliveries.filter((d) => d.status !== 'cancelled' || d.cancel_reason);

  return (
    <Card>
      <CardHeader>
        <CardTitle>Entregas e retiradas</CardTitle>
        {allDone ? (
          <Badge variant="success">
            <PackageCheck className="size-3.5" aria-hidden />
            Tudo entregue
          </Badge>
        ) : (
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" size="sm" onClick={() => setMode('pickup')} disabled={pendingTotal <= 0}>
              <PackageCheck />
              Registrar retirada
            </Button>
            <Button variant="steel" size="sm" onClick={() => setMode('schedule')} disabled={pendingTotal <= 0}>
              <CalendarPlus />
              Agendar
            </Button>
          </div>
        )}
      </CardHeader>
      <div className="overflow-x-auto">
        <Table className="min-w-[520px]">
          <THead>
            <TR>
              <TH className="pl-5">Produto</TH>
              <TH className="text-right">Vendido</TH>
              <TH className="text-right">Entregue</TH>
              <TH className="text-right">Agendado</TH>
              <TH className="pr-5 text-right">A entregar</TH>
            </TR>
          </THead>
          <TBody>
            {data.items.map((line) => (
              <TR key={line.order_item_id}>
                <TD className="pl-5 font-medium">{line.product_name}</TD>
                <TD className="text-right tabular-nums">
                  {formatQuantity(line.quantity)} <span className="text-xs text-muted-foreground">{line.unit}</span>
                </TD>
                <TD className="text-right text-success tabular-nums">{line.delivered ? formatQuantity(line.delivered) : '—'}</TD>
                <TD className="text-right tabular-nums">{line.scheduled ? formatQuantity(line.scheduled) : '—'}</TD>
                <TD className={cn('pr-5 text-right font-semibold tabular-nums', line.pending > 0 && 'text-warning')}>
                  {line.pending ? formatQuantity(line.pending) : '—'}
                </TD>
              </TR>
            ))}
          </TBody>
        </Table>
      </div>
      {visible.length > 0 && (
        <CardContent className="grid gap-2 pt-4">
          {visible.map((d) => (
            <div key={d.id} className="flex flex-wrap items-start gap-3 rounded-md border border-border p-3 text-sm">
              {d.kind === 'delivery' ? (
                <Truck className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
              ) : (
                <PackageCheck className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
              )}
              <div className="grid min-w-0 flex-1 gap-0.5">
                <p className="flex flex-wrap items-center gap-2 font-medium">
                  {KIND_LABEL[d.kind]}
                  <Badge variant={STATUS_VARIANT[d.status]}>{STATUS_LABEL[d.status]}</Badge>
                  <span className="font-normal text-muted-foreground">
                    {d.status === 'done' && d.completed_at
                      ? formatDateTime(d.completed_at)
                      : d.scheduled_date
                        ? `${formatDay(d.scheduled_date)}${d.period ? ` · ${PERIOD_LABEL[d.period]}` : ''}`
                        : ''}
                  </span>
                </p>
                <p className="text-muted-foreground">
                  {d.items.map((i) => `${formatQuantity(i.quantity)} ${i.unit} ${i.product_name}`).join(' · ')}
                </p>
                {d.status === 'done' && d.receiver_name && <p className="text-[13px] text-muted-foreground">Recebido por {d.receiver_name}</p>}
                {d.status === 'cancelled' && d.cancel_reason && (
                  <p className="text-[13px] text-destructive">Cancelada: {d.cancel_reason}</p>
                )}
              </div>
              <div className="flex shrink-0 gap-1">
                {(d.status === 'scheduled' || d.status === 'in_route' || (d.status === 'done' && (d.has_signature || d.has_photo))) && (
                  <Button asChild variant="ghost" size="sm">
                    <Link to={`/entregas/${d.id}`}>
                      <FileSignature />
                      {d.status === 'done' ? 'Comprovante' : 'Confirmar'}
                    </Link>
                  </Button>
                )}
                {(d.status === 'scheduled' || d.status === 'in_route' || (d.status === 'done' && user.role === 'admin')) && (
                  <Button variant="ghost" size="sm" onClick={() => setCancelling(d)} aria-label="Cancelar esta entrega">
                    <Undo2 />
                    {d.status === 'done' ? 'Estornar' : 'Desmarcar'}
                  </Button>
                )}
              </div>
            </div>
          ))}
        </CardContent>
      )}
      {mode && <DeliveryDialog order={order} lines={data.items} mode={mode} onClose={() => setMode(null)} />}
      <ReasonDialog
        open={cancelling !== null}
        onOpenChange={(o) => !o && setCancelling(null)}
        title={cancelling?.status === 'done' ? 'Estornar esta entrega?' : 'Desmarcar esta entrega?'}
        description="A quantidade volta para o saldo a entregar do pedido."
        confirmLabel={cancelling?.status === 'done' ? 'Estornar' : 'Desmarcar'}
        suggestions={
          cancelling?.status === 'done' ? ['Registrada por engano', 'Cliente devolveu'] : ['Cliente pediu outro dia', 'Sem veículo', 'Endereço errado']
        }
        loading={cancel.isPending}
        error={cancel.error instanceof ApiError ? cancel.error.message : null}
        onConfirm={(reason) => cancelling && cancel.mutate({ delivery: cancelling, reason })}
      />
    </Card>
  );
}
