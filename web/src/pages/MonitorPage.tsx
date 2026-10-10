import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowRight, Bell, BellOff, MapPin, Maximize, Minimize, Store as StoreIcon, Timer } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router';
import { toast } from 'sonner';
import { EmptyState, PageHeader } from '@/components/shared';
import { Button } from '@/components/ui/button';
import { Checkbox, NativeSelect } from '@/components/ui/input';
import { Badge, Skeleton } from '@/components/ui/misc';
import { api, ApiError, toQuery } from '@/lib/api';
import { useUser } from '@/lib/auth';
import { formatMoney, formatOrderNumber } from '@/lib/format';
import { useDocumentTitle } from '@/lib/hooks';
import type { Monitor, MonitorOrder, Order, Sector, StageNotification, Store } from '@/lib/types';
import { cn } from '@/lib/utils';
import { DELIVERY_LABEL, elapsedMinutes, formatElapsed, slaState, type SlaState } from '@/lib/workflow';

// A TV do depósito consulta sozinha; 10 s é rápido para quem espera e leve para o banco.
const REFRESH_MS = 10_000;

const SECTOR_KEY = 'monitor:setor';
const SOUND_KEY = 'monitor:som';
const KEEP_KEY = 'monitor:manter-conectado';

function readStorage(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeStorage(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Navegador sem armazenamento: a escolha vale só até recarregar.
  }
}

/** Bipe curto pelo Web Audio, sem arquivo de som. */
function beep() {
  try {
    const audio = new AudioContext();
    const oscillator = audio.createOscillator();
    const gain = audio.createGain();
    oscillator.type = 'sine';
    oscillator.frequency.value = 880;
    gain.gain.setValueAtTime(0.0001, audio.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.3, audio.currentTime + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, audio.currentTime + 0.5);
    oscillator.connect(gain).connect(audio.destination);
    oscillator.start();
    oscillator.stop(audio.currentTime + 0.5);
    oscillator.onended = () => audio.close();
  } catch {
    // Sem áudio no navegador: o cartão novo aparece do mesmo jeito.
  }
}

const SLA_STYLES: Record<SlaState, { card: string; badge: 'success' | 'warning' | 'danger' }> = {
  ok: { card: 'border-border', badge: 'success' },
  warning: { card: 'border-warning/60 shadow-[inset_4px_0_0_var(--color-warning)]', badge: 'warning' },
  late: { card: 'border-destructive/60 shadow-[inset_4px_0_0_var(--color-destructive)]', badge: 'danger' },
};

function OrderCard({
  order,
  now,
  showStore,
  tv,
  moving,
  onMove,
}: {
  order: MonitorOrder;
  now: number;
  showStore: boolean;
  tv: boolean;
  moving: boolean;
  onMove: () => void;
}) {
  const minutes = elapsedMinutes(order.stage_entered_at, now);
  const state = slaState(minutes, order.sla_minutes);
  const style = SLA_STYLES[state];
  return (
    <article className={cn('grid gap-2 rounded-lg border bg-card p-3', style.card, tv && 'gap-3 p-4')}>
      <div className="flex items-start justify-between gap-2">
        <Link
          to={`/pedidos/${order.id}`}
          className={cn('font-bold tabular-nums hover:underline', tv ? 'text-xl' : 'text-[15px]')}
        >
          Nº {formatOrderNumber(order.id)}
        </Link>
        <Badge
          variant={style.badge}
          className={cn('tabular-nums', tv && 'px-3 py-1 text-sm')}
          title={order.sla_minutes ? `Tempo esperado: ${formatElapsed(order.sla_minutes)}` : 'Etapa sem tempo esperado'}
        >
          <Timer className="size-3.5" aria-hidden />
          {formatElapsed(minutes)}
          <span className="sr-only">{state === 'late' ? ' (atrasado)' : state === 'warning' ? ' (quase no limite)' : ''}</span>
        </Badge>
      </div>
      <p className={cn('leading-tight font-semibold', tv ? 'text-lg' : 'text-sm')}>{order.client_name}</p>
      <div className={cn('flex flex-wrap items-center gap-1.5 text-muted-foreground', tv ? 'text-sm' : 'text-[13px]')}>
        <Badge variant={order.delivery_type === 'delivery' ? 'order' : 'neutral'}>{DELIVERY_LABEL[order.delivery_type]}</Badge>
        <span>
          {order.items_count} {order.items_count === 1 ? 'item' : 'itens'} · {formatMoney(order.total_amount)}
        </span>
      </div>
      {showStore && (
        <p className="flex items-center gap-1.5 text-[13px] text-muted-foreground">
          <StoreIcon className="size-3.5" aria-hidden />
          {order.store_name} · {order.user_name}
        </p>
      )}
      {order.delivery_address && (
        <p className="flex items-start gap-1.5 text-[13px] text-muted-foreground">
          <MapPin className="mt-0.5 size-3.5 shrink-0" aria-hidden />
          <span className="line-clamp-2">{order.delivery_address}</span>
        </p>
      )}
      {order.notes && <p className="line-clamp-2 text-[13px] text-foreground/80 italic">{order.notes}</p>}
      {order.can_move ? (
        <Button
          variant="steel"
          size={tv ? 'default' : 'sm'}
          className="mt-1 w-full justify-between"
          loading={moving}
          onClick={onMove}
        >
          <span className="truncate">{order.next_stage_name}</span>
          <ArrowRight />
        </Button>
      ) : (
        <p className="mt-1 text-[12px] text-muted-foreground">Próxima: {order.next_stage_name}</p>
      )}
    </article>
  );
}

export function MonitorPage() {
  useDocumentTitle('Monitor');
  const user = useUser();
  const isAdmin = user.role === 'admin';
  const queryClient = useQueryClient();
  const boardRef = useRef<HTMLDivElement>(null);
  // null: a pessoa ainda não escolheu; o monitor abre no primeiro setor dela.
  const [sector, setSector] = useState<string | null>(() => readStorage(SECTOR_KEY));
  const [storeId, setStoreId] = useState('');
  const [sound, setSound] = useState(() => readStorage(SOUND_KEY) === '1');
  // Ligado na TV do setor: o monitor renova a sessão e o aparelho não cai a cada 12 horas.
  const [keep, setKeep] = useState(() => readStorage(KEEP_KEY) === '1');
  const [tv, setTv] = useState(false);
  const [clock, setClock] = useState(() => Date.now());
  const [movingId, setMovingId] = useState<number | null>(null);
  const seenIds = useRef<Set<number> | null>(null);

  const sectors = useQuery({
    queryKey: ['sectors'],
    queryFn: () => api<{ items: Sector[] }>('/sectors').then((r) => r.items),
  });
  const stores = useQuery({
    queryKey: ['stores'],
    queryFn: () => api<{ items: Store[] }>('/stores').then((r) => r.items),
    enabled: isAdmin,
  });

  const monitor = useQuery({
    queryKey: ['monitor', sector ?? '', storeId, keep],
    queryFn: async () => {
      const data = await api<Monitor>(`/monitor${toQuery({ sector_id: sector ?? '', store_id: storeId, keep: keep ? 1 : '' })}`);
      // Diferença entre o relógio do servidor e o desta tela, para o tempo na etapa não depender da TV.
      return { ...data, skew: new Date(data.now).getTime() - Date.now() };
    },
    refetchInterval: REFRESH_MS,
    refetchIntervalInBackground: true,
  });

  // Sem escolha salva, abre no primeiro setor da pessoa (ou em todos, se ela não tem setor).
  const firstSector = monitor.data?.my_sector_ids[0];
  useEffect(() => {
    if (sector === null && monitor.data) setSector(firstSector ? String(firstSector) : '');
  }, [sector, monitor.data, firstSector]);

  // Setor guardado neste navegador que foi excluído depois: volta para todos.
  useEffect(() => {
    if (sector && sectors.data && !sectors.data.some((s) => String(s.id) === sector)) setSector('');
  }, [sector, sectors.data]);

  useEffect(() => {
    const timer = setInterval(() => setClock(Date.now()), 15_000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    const onChange = () => setTv(document.fullscreenElement === boardRef.current && boardRef.current !== null);
    document.addEventListener('fullscreenchange', onChange);
    return () => document.removeEventListener('fullscreenchange', onChange);
  }, []);

  // Bipe quando chega pedido novo no quadro (não na primeira carga nem ao trocar de setor).
  useEffect(() => {
    seenIds.current = null;
  }, [sector, storeId]);
  useEffect(() => {
    if (!monitor.data) return;
    const ids = new Set(monitor.data.orders.map((o) => o.id));
    const previous = seenIds.current;
    if (previous && sound && [...ids].some((id) => !previous.has(id))) beep();
    seenIds.current = ids;
  }, [monitor.data, sound]);

  const move = useMutation({
    mutationFn: (order: MonitorOrder) =>
      api<{ order: Order; notification: StageNotification | null }>(`/orders/${order.id}/stage`, {
        method: 'POST',
        body: { direction: 'next', expected_stage_id: order.stage_id },
      }),
    onMutate: (order) => setMovingId(order.id),
    onSuccess: ({ order, notification }) => {
      toast.success(`Pedido nº ${formatOrderNumber(order.id)} foi para "${order.workflow?.stage_name}".`);
      if (notification?.status === 'sent') toast.success(`${order.client_name} foi avisado pelo WhatsApp.`);
      if (notification?.status === 'failed') toast.warning(notification.error);
      queryClient.setQueryData(['order', order.id], order);
      queryClient.invalidateQueries({ queryKey: ['orders'] });
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : 'Não foi possível mover o pedido.'),
    onSettled: () => {
      setMovingId(null);
      queryClient.invalidateQueries({ queryKey: ['monitor'] });
    },
  });

  function toggleTv() {
    if (document.fullscreenElement) {
      document.exitFullscreen().catch(() => {});
      return;
    }
    boardRef.current?.requestFullscreen().catch(() => toast.error('Este navegador não deixou abrir em tela cheia.'));
  }

  function toggleSound() {
    const next = !sound;
    setSound(next);
    writeStorage(SOUND_KEY, next ? '1' : '0');
    // Navegadores só tocam som depois de um clique; este clique já serve de teste.
    if (next) beep();
  }

  const data = monitor.data;
  const now = clock + (data?.skew ?? 0);
  const sectorName = sectors.data?.find((s) => String(s.id) === sector)?.name;
  const showStore = isAdmin && !storeId;

  const controls = (
    <div className="flex flex-wrap items-center gap-2">
      <NativeSelect
        aria-label="Setor"
        value={sector ?? ''}
        onChange={(e) => {
          setSector(e.target.value);
          writeStorage(SECTOR_KEY, e.target.value);
        }}
        className="min-w-44"
      >
        <option value="">Todos os setores</option>
        {(sectors.data ?? []).map((s) => (
          <option key={s.id} value={s.id}>
            {s.name}
          </option>
        ))}
      </NativeSelect>
      {isAdmin && (
        <NativeSelect aria-label="Loja" value={storeId} onChange={(e) => setStoreId(e.target.value)} className="min-w-40">
          <option value="">Todas as lojas</option>
          {(stores.data ?? []).map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </NativeSelect>
      )}
      <label
        className="flex h-10 items-center gap-2 rounded-md border border-input bg-card px-3 text-sm font-semibold"
        title="Para a TV do setor: este aparelho continua conectado enquanto o monitor estiver aberto, sem cair a cada 12 horas."
      >
        <Checkbox
          checked={keep}
          onChange={(e) => {
            setKeep(e.target.checked);
            writeStorage(KEEP_KEY, e.target.checked ? '1' : '0');
          }}
        />
        Manter conectado
      </label>
      <Button variant="outline" onClick={toggleSound} aria-pressed={sound}>
        {sound ? <Bell /> : <BellOff />}
        {sound ? 'Som ligado' : 'Som desligado'}
      </Button>
      <Button variant="steel" onClick={toggleTv}>
        {tv ? <Minimize /> : <Maximize />}
        {tv ? 'Sair da tela cheia' : 'Modo TV'}
      </Button>
    </div>
  );

  function board() {
    if (!data) {
      return (
        <div className="flex gap-4 overflow-hidden">
          {Array.from({ length: 3 }, (_, i) => (
            <Skeleton key={i} className="h-96 w-72 shrink-0" />
          ))}
        </div>
      );
    }
    if (!data.columns.length) {
      return (
        <EmptyState
          className="rounded-lg border border-border bg-card"
          title={sector ? `Nenhuma etapa do setor ${sectorName ?? ''}` : 'Nenhum fluxo de pedidos configurado'}
          description={
            sector
              ? 'Nenhuma etapa em andamento pertence a este setor. Escolha outro setor ou veja todos.'
              : isAdmin
                ? 'Monte as etapas (Faturamento, Separação, Expedição...) para os pedidos aparecerem aqui.'
                : 'Peça ao administrador para configurar o fluxo de pedidos.'
          }
          action={
            isAdmin && !sector ? (
              <Button asChild>
                <Link to="/fluxo-de-pedidos">Configurar fluxo</Link>
              </Button>
            ) : undefined
          }
        />
      );
    }
    // Uma etapa só (a TV da separação, por exemplo): os cartões ocupam a tela em grade.
    const single = data.columns.length === 1;
    return (
      // relative: o texto para leitor de tela dos cartões (sr-only, posição absoluta) fica
      // preso ao quadro, que rola de lado, em vez de alargar a página no celular.
      <div className="relative flex min-h-0 flex-1 gap-4 overflow-x-auto pb-2">
        {data.columns.map((column) => {
          const orders = data.orders.filter((o) => o.column === column.key);
          const late = orders.filter((o) => slaState(elapsedMinutes(o.stage_entered_at, now), o.sla_minutes) === 'late').length;
          return (
            <section
              key={column.key}
              aria-label={column.name}
              className={cn(
                'flex min-w-64 flex-1 basis-0 flex-col rounded-lg bg-muted/70',
                single ? 'max-w-none' : 'max-w-md',
                tv && 'min-w-80',
              )}
            >
              <header className="flex items-center justify-between gap-2 px-3 py-2.5">
                <h2 className={cn('font-semibold', tv ? 'text-lg' : 'text-sm')}>{column.name}</h2>
                <div className="flex items-center gap-1.5">
                  {late > 0 && <Badge variant="danger">{late} atrasado{late === 1 ? '' : 's'}</Badge>}
                  <Badge variant="steel" className={cn('tabular-nums', tv && 'px-3 text-sm')}>
                    {orders.length}
                  </Badge>
                </div>
              </header>
              <div
                className={cn(
                  'grid content-start gap-2 overflow-y-auto px-2 pb-2',
                  single && 'grid-cols-[repeat(auto-fill,minmax(16rem,1fr))]',
                )}
              >
                {orders.length ? (
                  orders.map((order) => (
                    <OrderCard
                      key={order.id}
                      order={order}
                      now={now}
                      showStore={showStore}
                      tv={tv}
                      moving={movingId === order.id}
                      onMove={() => move.mutate(order)}
                    />
                  ))
                ) : (
                  <p className="col-span-full px-2 py-6 text-center text-[13px] text-muted-foreground">Nenhum pedido aqui.</p>
                )}
              </div>
            </section>
          );
        })}
      </div>
    );
  }

  return (
    <div>
      <PageHeader
        title="Monitor"
        description="Pedidos em andamento em cada etapa. Atualiza sozinho a cada 10 segundos."
        actions={controls}
      />
      <div ref={boardRef} className={cn('flex flex-col', tv && 'h-dvh gap-4 overflow-hidden bg-background p-6')}>
        {tv && (
          <div className="flex flex-wrap items-center justify-between gap-4">
            <h1 className="text-3xl font-bold tracking-tight">
              {sectorName ?? 'Todos os setores'}
              {data && <span className="ml-3 text-xl font-medium text-muted-foreground">{data.orders.length} em andamento</span>}
            </h1>
            {controls}
          </div>
        )}
        {board()}
      </div>
    </div>
  );
}
