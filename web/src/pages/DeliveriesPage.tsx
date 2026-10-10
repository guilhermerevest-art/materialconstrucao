import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  AlertTriangle,
  ChevronLeft,
  ChevronRight,
  FileSignature,
  FileText,
  MapPin,
  PackageCheck,
  Pencil,
  Plus,
  Route as RouteIcon,
  Truck,
  Undo2,
} from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { Link, useSearchParams } from 'react-router';
import { toast } from 'sonner';
import { ReasonDialog } from '@/components/ReasonDialog';
import { EmptyState, PageHeader } from '@/components/shared';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Checkbox, Field, Input, NativeSelect } from '@/components/ui/input';
import { Alert, Badge, Skeleton } from '@/components/ui/misc';
import { api, ApiError, toQuery } from '@/lib/api';
import { useUser } from '@/lib/auth';
import { mapsUrl, PERIOD_LABEL, STATUS_LABEL, STATUS_VARIANT } from '@/lib/deliveries';
import { addDays, formatDay, formatOrderNumber, formatQuantity, formatWeekday, todayIso } from '@/lib/format';
import { useDocumentTitle } from '@/lib/hooks';
import type { Delivery, DeliveryRoute, Store, Vehicle } from '@/lib/types';
import { cn } from '@/lib/utils';

const errorMessage = (err: unknown, fallback: string) => (err instanceof ApiError ? err.message : fallback);

function DeliveryRow({
  delivery,
  selectable,
  selected,
  onSelect,
  onCancel,
  showDate,
}: {
  delivery: Delivery;
  selectable?: boolean;
  selected?: boolean;
  onSelect?: (checked: boolean) => void;
  onCancel?: () => void;
  showDate?: boolean;
}) {
  const open = delivery.status === 'scheduled' || delivery.status === 'in_route';
  return (
    <li className="flex items-start gap-3 px-3 py-3 text-sm">
      {selectable && (
        <Checkbox
          className="mt-1"
          checked={selected}
          onChange={(e) => onSelect?.(e.target.checked)}
          aria-label={`Selecionar entrega do pedido ${formatOrderNumber(delivery.order_id)}`}
        />
      )}
      <div className="grid min-w-0 flex-1 gap-0.5">
        <p className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <Link to={`/pedidos/${delivery.order_id}`} className="font-semibold tabular-nums hover:underline">
            {formatOrderNumber(delivery.order_id)}
          </Link>
          <span className="font-medium">{delivery.client_name}</span>
          <Badge variant={STATUS_VARIANT[delivery.status]}>{STATUS_LABEL[delivery.status]}</Badge>
          {delivery.period && <Badge>{PERIOD_LABEL[delivery.period]}</Badge>}
          {showDate && delivery.scheduled_date && <span className="text-muted-foreground">{formatDay(delivery.scheduled_date)}</span>}
        </p>
        {delivery.address && (
          <a
            href={mapsUrl(delivery.address)}
            target="_blank"
            rel="noreferrer"
            className="flex items-start gap-1 text-muted-foreground hover:text-foreground hover:underline"
          >
            <MapPin className="mt-0.5 size-3.5 shrink-0" aria-hidden />
            <span className="line-clamp-2 whitespace-pre-line">{delivery.address}</span>
          </a>
        )}
        <p className="text-[13px] text-muted-foreground">
          {delivery.items.map((i) => `${formatQuantity(i.quantity)} ${i.unit} ${i.product_name}`).join(' · ')}
        </p>
        {delivery.status === 'done' && delivery.receiver_name && (
          <p className="text-[13px] text-success">Recebido por {delivery.receiver_name}</p>
        )}
      </div>
      <div className="flex shrink-0 flex-col items-end gap-1 sm:flex-row">
        {(open || delivery.has_signature || delivery.has_photo) && (
          <Button asChild variant={open ? 'steel' : 'ghost'} size="sm">
            <Link to={`/entregas/${delivery.id}`}>
              <FileSignature />
              {open ? 'Confirmar' : 'Comprovante'}
            </Link>
          </Button>
        )}
        {open && onCancel && (
          <Button variant="ghost" size="sm" onClick={onCancel}>
            <Undo2 />
            Não entregue
          </Button>
        )}
      </div>
    </li>
  );
}

function RouteDialog({
  deliveryIds,
  date,
  storeId,
  onClose,
}: {
  deliveryIds: number[];
  date: string;
  storeId: number | null;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const vehicles = useQuery({ queryKey: ['vehicles'], queryFn: () => api<{ items: Vehicle[] }>('/vehicles').then((r) => r.items) });
  const [vehicleId, setVehicleId] = useState('');
  const [driver, setDriver] = useState('');
  const [notes, setNotes] = useState('');
  const save = useMutation({
    mutationFn: () =>
      api<{ route: DeliveryRoute }>('/delivery-routes', {
        method: 'POST',
        body: {
          store_id: storeId,
          route_date: date,
          vehicle_id: vehicleId ? Number(vehicleId) : null,
          driver_name: driver || null,
          notes: notes || null,
          delivery_ids: deliveryIds,
        },
      }),
    onSuccess: ({ route }) => {
      queryClient.invalidateQueries({ queryKey: ['deliveries'] });
      queryClient.invalidateQueries({ queryKey: ['delivery-routes'] });
      toast.success(`Romaneio nº ${route.id} montado.`);
      onClose();
    },
  });

  function submit(event: FormEvent) {
    event.preventDefault();
    save.mutate();
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Montar romaneio</DialogTitle>
          <DialogDescription>
            {deliveryIds.length} {deliveryIds.length === 1 ? 'entrega' : 'entregas'} em {formatDay(date)}, na ordem em que foram marcadas.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="grid gap-4">
          {save.error && <Alert variant="danger" title={errorMessage(save.error, 'Não foi possível montar o romaneio.')} />}
          <Field label="Veículo" htmlFor="romaneio-veiculo" hint={vehicles.data?.length ? undefined : 'Cadastre os veículos em "Veículos".'}>
            <NativeSelect id="romaneio-veiculo" value={vehicleId} onChange={(e) => setVehicleId(e.target.value)}>
              <option value="">Sem veículo definido</option>
              {(vehicles.data ?? [])
                .filter((v) => v.active)
                .map((v) => (
                  <option key={v.id} value={v.id}>
                    {v.name}
                    {v.plate ? ` (${v.plate})` : ''}
                  </option>
                ))}
            </NativeSelect>
          </Field>
          <Field label="Motorista" htmlFor="romaneio-motorista">
            <Input id="romaneio-motorista" value={driver} onChange={(e) => setDriver(e.target.value)} maxLength={80} />
          </Field>
          <Field label="Observações (opcional)" htmlFor="romaneio-obs">
            <Input id="romaneio-obs" value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={300} />
          </Field>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              Cancelar
            </Button>
            <Button type="submit" loading={save.isPending}>
              Montar romaneio
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function VehiclesDialog({ onClose }: { onClose: () => void }) {
  const queryClient = useQueryClient();
  const vehicles = useQuery({ queryKey: ['vehicles'], queryFn: () => api<{ items: Vehicle[] }>('/vehicles').then((r) => r.items) });
  const [editing, setEditing] = useState<Vehicle | 'new' | null>(null);
  const [name, setName] = useState('');
  const [plate, setPlate] = useState('');
  const [active, setActive] = useState(true);
  const save = useMutation({
    mutationFn: () => {
      const body = { name, plate: plate || null, active };
      return editing === 'new'
        ? api('/vehicles', { method: 'POST', body })
        : api(`/vehicles/${(editing as Vehicle).id}`, { method: 'PUT', body });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['vehicles'] });
      setEditing(null);
    },
  });

  function edit(vehicle: Vehicle | 'new') {
    setEditing(vehicle);
    setName(vehicle === 'new' ? '' : vehicle.name);
    setPlate(vehicle === 'new' ? '' : (vehicle.plate ?? ''));
    setActive(vehicle === 'new' ? true : vehicle.active);
    save.reset();
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Veículos</DialogTitle>
          <DialogDescription>Os veículos que saem com os romaneios.</DialogDescription>
        </DialogHeader>
        {editing ? (
          <form
            className="grid gap-4"
            onSubmit={(event) => {
              event.preventDefault();
              save.mutate();
            }}
          >
            {save.error && <Alert variant="danger" title={errorMessage(save.error, 'Não foi possível salvar.')} />}
            <Field label="Nome" htmlFor="veiculo-nome" hint="Ex.: Caminhão baú, Toco, Fiorino.">
              <Input id="veiculo-nome" value={name} onChange={(e) => setName(e.target.value)} maxLength={60} autoFocus />
            </Field>
            <Field label="Placa (opcional)" htmlFor="veiculo-placa">
              <Input id="veiculo-placa" value={plate} onChange={(e) => setPlate(e.target.value)} maxLength={8} placeholder="ABC1D23" />
            </Field>
            {editing !== 'new' && (
              <label className="flex items-center gap-2 text-sm">
                <Checkbox checked={active} onChange={(e) => setActive(e.target.checked)} />
                Ativo
              </label>
            )}
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setEditing(null)}>
                Voltar
              </Button>
              <Button type="submit" loading={save.isPending}>
                Salvar
              </Button>
            </DialogFooter>
          </form>
        ) : (
          <div className="grid gap-3">
            {!vehicles.data?.length ? (
              <p className="rounded-md border border-dashed border-border px-4 py-6 text-center text-sm text-muted-foreground">
                Nenhum veículo cadastrado.
              </p>
            ) : (
              <ul className="divide-y divide-border rounded-md border border-border">
                {vehicles.data.map((v) => (
                  <li key={v.id} className={cn('flex items-center gap-3 px-3 py-2 text-sm', !v.active && 'opacity-60')}>
                    <Truck className="size-4 text-muted-foreground" aria-hidden />
                    <span className="flex-1 font-medium">
                      {v.name}
                      {v.plate && <span className="ml-2 font-normal text-muted-foreground tabular-nums">{v.plate}</span>}
                    </span>
                    {!v.active && <Badge>Inativo</Badge>}
                    <Button variant="ghost" size="icon" className="size-8" onClick={() => edit(v)} aria-label={`Editar ${v.name}`}>
                      <Pencil />
                    </Button>
                  </li>
                ))}
              </ul>
            )}
            <Button variant="outline" className="justify-self-start" onClick={() => edit('new')}>
              <Plus />
              Novo veículo
            </Button>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

export function DeliveriesPage() {
  useDocumentTitle('Entregas');
  const user = useUser();
  const isAdmin = user.role === 'admin';
  const queryClient = useQueryClient();
  const [params, setParams] = useSearchParams();
  const today = todayIso();
  const date = /^\d{4}-\d{2}-\d{2}$/.test(params.get('dia') ?? '') ? params.get('dia')! : today;
  const [storeId, setStoreId] = useState<number | null>(isAdmin ? null : user.store_id);
  const [selected, setSelected] = useState<number[]>([]);
  const [routeOpen, setRouteOpen] = useState(false);
  const [vehiclesOpen, setVehiclesOpen] = useState(false);
  const [cancelling, setCancelling] = useState<Delivery | null>(null);
  const [showOverdue, setShowOverdue] = useState(false);

  const setDate = (day: string) => {
    setSelected([]);
    setShowOverdue(false);
    setParams(day === today ? {} : { dia: day });
  };

  const stores = useQuery({
    queryKey: ['stores'],
    queryFn: () => api<{ items: Store[] }>('/stores').then((r) => r.items),
    enabled: isAdmin,
  });
  const deliveries = useQuery({
    queryKey: ['deliveries', 'day', date, storeId],
    queryFn: () => api<{ items: Delivery[] }>(`/deliveries${toQuery({ from: date, store_id: storeId })}`).then((r) => r.items),
  });
  const overdue = useQuery({
    queryKey: ['deliveries', 'overdue', today, storeId],
    queryFn: () => api<{ items: Delivery[] }>(`/deliveries${toQuery({ overdue: true, from: today, store_id: storeId })}`).then((r) => r.items),
  });
  const routes = useQuery({
    queryKey: ['delivery-routes', date, storeId],
    queryFn: () => api<{ items: DeliveryRoute[] }>(`/delivery-routes${toQuery({ from: date, store_id: storeId })}`).then((r) => r.items),
  });

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ['deliveries'] });
    queryClient.invalidateQueries({ queryKey: ['delivery-routes'] });
    queryClient.invalidateQueries({ queryKey: ['order-deliveries'] });
  };

  const routeAction = useMutation({
    mutationFn: ({ route, action }: { route: DeliveryRoute; action: 'depart' | 'finish' | 'undo' }) =>
      action === 'undo'
        ? api(`/delivery-routes/${route.id}`, { method: 'DELETE' })
        : api<{ returned?: number }>(`/delivery-routes/${route.id}/${action}`, { method: 'POST' }),
    onSuccess: (result, { action }) => {
      invalidate();
      if (action === 'depart') toast.success('Saiu para entrega.');
      if (action === 'undo') toast.success('Romaneio desfeito. As entregas voltaram para a lista.');
      if (action === 'finish') {
        const returned = (result as { returned?: number } | undefined)?.returned ?? 0;
        toast.success(returned ? `Romaneio concluído. ${returned} entrega(s) voltaram para reagendar.` : 'Romaneio concluído.');
      }
    },
    onError: (err) => toast.error(errorMessage(err, 'Não foi possível concluir a ação.')),
  });

  const cancel = useMutation({
    mutationFn: ({ delivery, reason }: { delivery: Delivery; reason: string }) =>
      api(`/deliveries/${delivery.id}/cancel`, { method: 'POST', body: { reason } }),
    onSuccess: () => {
      invalidate();
      setCancelling(null);
      toast.success('Registrado. O saldo voltou para o pedido, para reagendar.');
    },
  });

  const all = deliveries.data ?? [];
  const unrouted = all.filter((d) => d.kind === 'delivery' && d.status === 'scheduled' && d.route_id === null);
  const pickups = all.filter((d) => d.kind === 'pickup' && d.status === 'scheduled');
  const done = all.filter((d) => d.status === 'done' && d.route_id === null);
  const overdueItems = overdue.data ?? [];

  return (
    <div>
      <PageHeader
        title="Entregas"
        description="Agenda do dia, romaneios de carga e retiradas agendadas."
        actions={
          isAdmin && (
            <Button variant="outline" onClick={() => setVehiclesOpen(true)}>
              <Truck />
              Veículos
            </Button>
          )
        }
      />

      <div className="mb-5 flex flex-wrap items-center gap-2">
        <Button variant="outline" size="icon" onClick={() => setDate(addDays(date, -1))} aria-label="Dia anterior">
          <ChevronLeft />
        </Button>
        <Input type="date" aria-label="Dia" value={date} onChange={(e) => e.target.value && setDate(e.target.value)} className="w-40" />
        <Button variant="outline" size="icon" onClick={() => setDate(addDays(date, 1))} aria-label="Próximo dia">
          <ChevronRight />
        </Button>
        {date !== today && (
          <Button variant="ghost" onClick={() => setDate(today)}>
            Hoje
          </Button>
        )}
        <span className="text-sm font-medium first-letter:uppercase">{formatWeekday(date)}</span>
        {isAdmin && (stores.data?.length ?? 0) > 1 && (
          <NativeSelect
            aria-label="Loja"
            value={storeId ?? ''}
            onChange={(e) => setStoreId(e.target.value ? Number(e.target.value) : null)}
            className="ml-auto w-44"
          >
            <option value="">Todas as lojas</option>
            {stores.data!.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </NativeSelect>
        )}
      </div>

      {overdueItems.length > 0 && (
        <Alert variant="danger" icon={<AlertTriangle />} title={`${overdueItems.length} ${overdueItems.length === 1 ? 'entrega atrasada' : 'entregas atrasadas'}`} className="mb-5">
          <p>Agendadas para antes de hoje e ainda não feitas. Reagende no pedido ou confirme o comprovante.</p>
          <Button variant="outline" size="sm" className="mt-2 justify-self-start" onClick={() => setShowOverdue((v) => !v)}>
            {showOverdue ? 'Esconder' : 'Ver atrasadas'}
          </Button>
          {showOverdue && (
            <ul className="mt-2 divide-y divide-border rounded-md border border-border bg-card">
              {overdueItems.map((d) => (
                <DeliveryRow key={d.id} delivery={d} showDate onCancel={() => setCancelling(d)} />
              ))}
            </ul>
          )}
        </Alert>
      )}

      {deliveries.isPending ? (
        <div className="grid gap-4">
          <Skeleton className="h-40" />
          <Skeleton className="h-40" />
        </div>
      ) : !all.length && !routes.data?.length ? (
        <Card>
          <EmptyState
            title="Nada agendado para este dia"
            description="Entregas e retiradas são agendadas no pedido, no quadro Entregas e retiradas."
          />
        </Card>
      ) : (
        <div className="grid grid-cols-1 gap-5">
          {unrouted.length > 0 && (
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <Truck className="size-4" aria-hidden />
                  Entregas sem romaneio
                </CardTitle>
                <Button size="sm" onClick={() => setRouteOpen(true)} disabled={!selected.length}>
                  <RouteIcon />
                  Montar romaneio{selected.length ? ` (${selected.length})` : ''}
                </Button>
              </CardHeader>
              <ul className="divide-y divide-border border-t border-border">
                {unrouted.map((d) => (
                  <DeliveryRow
                    key={d.id}
                    delivery={d}
                    selectable
                    selected={selected.includes(d.id)}
                    onSelect={(checked) => setSelected((s) => (checked ? [...s, d.id] : s.filter((id) => id !== d.id)))}
                    onCancel={() => setCancelling(d)}
                  />
                ))}
              </ul>
            </Card>
          )}

          {(routes.data ?? []).map((route) => {
            const items = all.filter((d) => d.route_id === route.id).sort((a, b) => (a.route_position ?? 0) - (b.route_position ?? 0));
            return (
              <Card key={route.id}>
                <CardHeader>
                  <div className="grid gap-0.5">
                    <CardTitle className="flex flex-wrap items-center gap-2">
                      <RouteIcon className="size-4" aria-hidden />
                      Romaneio nº {route.id}
                      <Badge variant={route.status === 'done' ? 'success' : route.status === 'in_route' ? 'order' : 'neutral'}>
                        {route.status === 'done' ? 'Concluído' : route.status === 'in_route' ? 'Em rota' : 'Montado'}
                      </Badge>
                    </CardTitle>
                    <p className="text-sm text-muted-foreground">
                      {[route.vehicle_name && `${route.vehicle_name}${route.vehicle_plate ? ` (${route.vehicle_plate})` : ''}`, route.driver_name && `Motorista: ${route.driver_name}`, isAdmin && !storeId && route.store_name]
                        .filter(Boolean)
                        .join(' · ') || 'Sem veículo definido'}
                    </p>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <Button asChild variant="outline" size="sm">
                      <a href={`/api/delivery-routes/${route.id}/pdf`} target="_blank" rel="noreferrer">
                        <FileText />
                        Romaneio (PDF)
                      </a>
                    </Button>
                    {route.status === 'open' && (
                      <>
                        <Button variant="ghost" size="sm" onClick={() => routeAction.mutate({ route, action: 'undo' })}>
                          Desfazer
                        </Button>
                        <Button variant="steel" size="sm" onClick={() => routeAction.mutate({ route, action: 'depart' })}>
                          <Truck />
                          Saiu para entrega
                        </Button>
                      </>
                    )}
                    {route.status === 'in_route' && (
                      <Button size="sm" onClick={() => routeAction.mutate({ route, action: 'finish' })}>
                        <PackageCheck />
                        Veículo voltou
                      </Button>
                    )}
                  </div>
                </CardHeader>
                {items.length > 0 ? (
                  <ol className="divide-y divide-border border-t border-border">
                    {items.map((d) => (
                      <DeliveryRow key={d.id} delivery={d} onCancel={() => setCancelling(d)} />
                    ))}
                  </ol>
                ) : (
                  <CardContent>
                    <p className="text-sm text-muted-foreground">As entregas deste romaneio já foram resolvidas.</p>
                  </CardContent>
                )}
              </Card>
            );
          })}

          {pickups.length > 0 && (
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <PackageCheck className="size-4" aria-hidden />
                  Retiradas agendadas
                </CardTitle>
              </CardHeader>
              <ul className="divide-y divide-border border-t border-border">
                {pickups.map((d) => (
                  <DeliveryRow key={d.id} delivery={d} onCancel={() => setCancelling(d)} />
                ))}
              </ul>
            </Card>
          )}

          {done.length > 0 && (
            <Card>
              <CardHeader>
                <CardTitle>Concluídas neste dia</CardTitle>
              </CardHeader>
              <ul className="divide-y divide-border border-t border-border">
                {done.map((d) => (
                  <DeliveryRow key={d.id} delivery={d} />
                ))}
              </ul>
            </Card>
          )}
        </div>
      )}

      {routeOpen && (
        <RouteDialog
          deliveryIds={selected}
          date={date}
          storeId={storeId}
          onClose={() => {
            setRouteOpen(false);
            setSelected([]);
          }}
        />
      )}
      {vehiclesOpen && <VehiclesDialog onClose={() => setVehiclesOpen(false)} />}
      <ReasonDialog
        open={cancelling !== null}
        onOpenChange={(o) => !o && setCancelling(null)}
        title="Entrega não feita?"
        description="A entrega sai da agenda e a quantidade volta para o saldo do pedido, para reagendar."
        confirmLabel="Registrar"
        suggestions={['Cliente ausente', 'Endereço não encontrado', 'Sem tempo na rota', 'Cliente pediu outro dia']}
        loading={cancel.isPending}
        error={cancel.error ? errorMessage(cancel.error, 'Não foi possível registrar.') : null}
        onConfirm={(reason) => cancelling && cancel.mutate({ delivery: cancelling, reason })}
      />
    </div>
  );
}
