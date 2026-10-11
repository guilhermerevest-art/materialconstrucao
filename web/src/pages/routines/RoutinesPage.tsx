import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ClipboardCheck, Clock, ListChecks, Plus, ScanBarcode } from 'lucide-react';
import { useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { toast } from 'sonner';
import { ProductPicker, type PickedProduct } from '@/components/ProductPicker';
import { RoutineTemplateDialog } from '@/components/routines/RoutineTemplateDialog';
import { EmptyState, PageHeader } from '@/components/shared';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Field, Input, NativeSelect } from '@/components/ui/input';
import { Alert, Badge, Skeleton } from '@/components/ui/misc';
import { Table, TBody, TD, TH, THead, TR } from '@/components/ui/table';
import { useStoreOptions } from '@/pages/StockPage';
import { api, ApiError, toQuery } from '@/lib/api';
import { ME_KEY, useUser } from '@/lib/auth';
import { addDays, formatDateTime, formatDay, todayIso } from '@/lib/format';
import { useDocumentTitle } from '@/lib/hooks';
import { COUNT_STATUS, ROUTINE_STATUS, scheduleLabel } from '@/lib/routines';
import type { RoutineHistoryRow, RoutineTemplate, RoutineToday, StockCountSummary } from '@/lib/types';
import { cn } from '@/lib/utils';

type Tab = 'hoje' | 'contagens' | 'historico' | 'modelos';

const errorText = (err: unknown, fallback: string) => (err instanceof ApiError ? err.message : fallback);

/** Ligar as rotinas (admin). Ligar cria os modelos prontos. */
function EnableCard() {
  const queryClient = useQueryClient();
  const enable = useMutation({
    mutationFn: () => api('/routines/settings', { method: 'PUT', body: { enabled: true, count_items: 20 } }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ME_KEY });
      queryClient.invalidateQueries({ queryKey: ['routines'] });
      toast.success('Rotinas ligadas, com os modelos prontos. Ajuste em Modelos.');
    },
    onError: (err) => toast.error(errorText(err, 'Não foi possível ligar.')),
  });
  return (
    <Card>
      <EmptyState
        title="Rotinas e contagem de estoque"
        description="Checklists de abertura, fechamento e recebimento feitos no celular, com foto e horário, e a contagem cega do estoque: o sistema escolhe os produtos pela curva ABC, quem conta não vê o saldo e a diferença só vira ajuste quando você aprova."
        action={
          <Button onClick={() => enable.mutate()} loading={enable.isPending}>
            <ListChecks />
            Ligar rotinas
          </Button>
        }
      />
    </Card>
  );
}

function StatusBadge({ status }: { status: RoutineToday['status'] }) {
  const s = ROUTINE_STATUS[status];
  return <Badge variant={s.variant}>{s.label}</Badge>;
}

function TodayTab({ storeId }: { storeId: string }) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: ['routines', 'today', storeId],
    queryFn: () => api<{ today: string; items: RoutineToday[]; counts: StockCountSummary[] }>(`/routines/today${toQuery({ store_id: storeId })}`),
  });
  const start = useMutation({
    mutationFn: (item: RoutineToday) =>
      api<{ run: { id: number; count_id: number | null } }>('/routines/runs', { method: 'POST', body: { template_id: item.template_id, store_id: item.store_id } }),
    onSuccess: ({ run }) => {
      queryClient.invalidateQueries({ queryKey: ['routines'] });
      navigate(run.count_id ? `/rotinas/contagem/${run.count_id}` : `/rotinas/execucao/${run.id}`);
    },
    onError: (err) => toast.error(errorText(err, 'Não foi possível começar.')),
  });
  if (query.isPending) return <Skeleton className="h-48" />;
  if (query.isError) return <Alert variant="danger" title={query.error.message} />;
  const data = query.data;
  const stores = [...new Map(data.items.map((i) => [i.store_id, i.store_name])).entries()];
  return (
    <div className="grid gap-6">
      {data.counts.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>Contagens em aberto</CardTitle>
          </CardHeader>
          <ul className="divide-y divide-border border-t border-border">
            {data.counts.map((c) => (
              <li key={c.id}>
                <Link to={`/rotinas/contagem/${c.id}`} className="flex flex-wrap items-center gap-3 px-5 py-3 hover:bg-muted/50">
                  <ScanBarcode className="size-5 text-muted-foreground" />
                  <span className="min-w-0 flex-1">
                    <span className="font-medium">Contagem nº {c.id}</span>
                    <span className="block text-[13px] text-muted-foreground">
                      {c.store_name} · {c.counted} de {c.items} contados · {c.user_name}
                    </span>
                  </span>
                  <Badge variant={COUNT_STATUS[c.status].variant}>{COUNT_STATUS[c.status].label}</Badge>
                </Link>
              </li>
            ))}
          </ul>
        </Card>
      )}
      {stores.map(([id, name]) => {
        const items = data.items.filter((i) => i.store_id === id);
        const scheduled = items.filter((i) => i.due_today);
        const others = items.filter((i) => !i.due_today);
        return (
          <Card key={id}>
            <CardHeader>
              <CardTitle>{name}</CardTitle>
              <span className="text-sm text-muted-foreground">
                {scheduled.filter((i) => i.status === 'done').length} de {scheduled.length} feitas hoje
              </span>
            </CardHeader>
            <ul className="divide-y divide-border border-t border-border">
              {[...scheduled, ...others].map((item) => {
                const open = item.runs.find((r) => r.status === 'in_progress');
                const scheduledRun = item.runs.find((r) => r.scheduled);
                return (
                  <li key={item.template_id} className={cn('flex flex-wrap items-center gap-3 px-5 py-3', !item.due_today && item.frequency !== 'on_demand' && 'opacity-60')}>
                    {item.kind === 'stock_count' ? (
                      <ScanBarcode className="size-5 shrink-0 text-muted-foreground" />
                    ) : (
                      <ClipboardCheck className="size-5 shrink-0 text-muted-foreground" />
                    )}
                    <span className="min-w-0 flex-1">
                      <span className="flex flex-wrap items-center gap-2 font-medium">
                        {item.name}
                        {item.frequency !== 'on_demand' && <StatusBadge status={item.status} />}
                      </span>
                      <span className="block text-[13px] text-muted-foreground">
                        {item.frequency === 'on_demand'
                          ? item.runs.length
                            ? `${item.runs.length === 1 ? '1 vez' : `${item.runs.length} vezes`} hoje`
                            : 'Quando precisar'
                          : item.due_time
                            ? `Até ${item.due_time}`
                            : 'Hoje'}
                        {scheduledRun?.status === 'done' && scheduledRun.finished_at && ` · feita às ${formatDateTime(scheduledRun.finished_at).slice(-5)} por ${scheduledRun.user_name}`}
                        {scheduledRun?.late && ' · com atraso'}
                      </span>
                    </span>
                    {open ? (
                      <Button asChild size="sm">
                        <Link to={`/rotinas/execucao/${open.id}`}>Continuar</Link>
                      </Button>
                    ) : scheduledRun?.status === 'done' ? (
                      <Button asChild size="sm" variant="ghost">
                        <Link to={`/rotinas/execucao/${scheduledRun.id}`}>Ver</Link>
                      </Button>
                    ) : (
                      <Button
                        size="sm"
                        variant={item.due_today ? 'default' : 'outline'}
                        loading={start.isPending && start.variables?.template_id === item.template_id && start.variables.store_id === item.store_id}
                        onClick={() => start.mutate(item)}
                      >
                        {item.frequency === 'on_demand' ? 'Começar' : 'Fazer'}
                      </Button>
                    )}
                  </li>
                );
              })}
            </ul>
          </Card>
        );
      })}
      {!stores.length && <EmptyState title="Nenhuma rotina ativa" description="Crie ou ative as rotinas em Modelos." />}
    </div>
  );
}

/** Contagem avulsa com os produtos escolhidos (ex.: o que deu diferença no balcão). */
function ManualCountDialog({ storeId, onClose }: { storeId: string; onClose: () => void }) {
  const navigate = useNavigate();
  const [products, setProducts] = useState<PickedProduct[]>([]);
  const [picker, setPicker] = useState<PickedProduct | null>(null);
  const create = useMutation({
    mutationFn: () =>
      api<{ count: { id: number } }>('/stock-counts', {
        method: 'POST',
        body: { store_id: storeId ? Number(storeId) : null, product_ids: products.map((p) => p.id) },
      }),
    onSuccess: ({ count }) => navigate(`/rotinas/contagem/${count.id}`),
    onError: (err) => toast.error(errorText(err, 'Não foi possível abrir a contagem.')),
  });
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Contar produtos escolhidos</DialogTitle>
          <DialogDescription>Também é contagem cega: quem conta não vê o saldo.</DialogDescription>
        </DialogHeader>
        <ProductPicker
          value={picker}
          onChange={(p) => {
            if (p && !products.some((x) => x.id === p.id)) setProducts((ps) => [...ps, p]);
            setPicker(null);
          }}
          placeholder="Buscar produto para incluir"
        />
        {products.length > 0 && (
          <ul className="grid gap-1 text-sm">
            {products.map((p) => (
              <li key={p.id} className="flex items-center justify-between gap-2 rounded-md bg-muted/60 px-3 py-1.5">
                <span className="truncate">
                  {p.code && <span className="mr-2 text-muted-foreground tabular-nums">{p.code}</span>}
                  {p.name}
                </span>
                <button type="button" className="text-xs text-muted-foreground hover:text-destructive" onClick={() => setProducts((ps) => ps.filter((x) => x.id !== p.id))}>
                  remover
                </button>
              </li>
            ))}
          </ul>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancelar
          </Button>
          <Button onClick={() => create.mutate()} disabled={!products.length} loading={create.isPending}>
            Abrir contagem
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function CountsTab({ storeId }: { storeId: string }) {
  const navigate = useNavigate();
  const isAdmin = useUser().role === 'admin';
  const [status, setStatus] = useState<'open' | 'reviewed' | 'all'>('open');
  const [manual, setManual] = useState(false);
  const list = useQuery({
    queryKey: ['routines', 'counts', status],
    queryFn: () => api<{ items: StockCountSummary[] }>(`/stock-counts?status=${status}`).then((r) => r.items),
  });
  const cycle = useMutation({
    mutationFn: () => api<{ count: { id: number } }>('/stock-counts', { method: 'POST', body: { store_id: storeId ? Number(storeId) : null } }),
    onSuccess: ({ count }) => navigate(`/rotinas/contagem/${count.id}`),
    onError: (err) => toast.error(errorText(err, 'Não foi possível abrir a contagem.')),
  });
  return (
    <Card>
      <div className="flex flex-wrap items-center gap-3 border-b border-border p-4">
        <div className="flex rounded-md border border-input bg-background p-0.5" role="group" aria-label="Situação">
          {(
            [
              { value: 'open', label: 'Em aberto' },
              { value: 'reviewed', label: 'Conferidas' },
              { value: 'all', label: 'Todas' },
            ] as const
          ).map((f) => (
            <button
              key={f.value}
              onClick={() => setStatus(f.value)}
              aria-pressed={status === f.value}
              className={cn(
                'h-8 rounded px-3 text-sm font-medium',
                status === f.value ? 'bg-card text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground',
              )}
            >
              {f.label}
            </button>
          ))}
        </div>
        <div className="flex flex-wrap gap-2 sm:ml-auto">
          <Button variant="outline" onClick={() => setManual(true)}>
            <Plus />
            Escolher produtos
          </Button>
          <Button onClick={() => cycle.mutate()} loading={cycle.isPending}>
            <ScanBarcode />
            Contar agora
          </Button>
        </div>
      </div>
      <p className="border-b border-border px-5 py-2.5 text-[13px] text-muted-foreground">
        "Contar agora" escolhe os produtos pela curva ABC: os A a cada semana, os B a cada mês e os C a cada três meses.
        {isAdmin && ' A diferença só vira ajuste quando você confere e aprova.'}
      </p>
      {list.isPending ? (
        <Skeleton className="m-4 h-32" />
      ) : !list.data?.length ? (
        <EmptyState title="Nenhuma contagem aqui" />
      ) : (
        <Table>
          <THead>
            <TR>
              <TH className="pl-4">Nº</TH>
              <TH>Loja</TH>
              <TH>Aberta</TH>
              <TH className="text-right">Contados</TH>
              <TH className="pr-4">Situação</TH>
            </TR>
          </THead>
          <TBody>
            {list.data.map((c) => (
              <TR key={c.id} className="cursor-pointer hover:bg-muted/50" onClick={() => navigate(`/rotinas/contagem/${c.id}`)}>
                <TD className="pl-4 font-semibold tabular-nums">{c.id}</TD>
                <TD>{c.store_name}</TD>
                <TD className="text-muted-foreground">
                  {formatDateTime(c.created_at)}
                  <span className="block text-xs">
                    {c.user_name} · {c.mode === 'cycle' ? 'curva ABC' : 'escolhidos'}
                  </span>
                </TD>
                <TD className="text-right tabular-nums">
                  {c.counted} de {c.items}
                </TD>
                <TD className="pr-4">
                  <Badge variant={COUNT_STATUS[c.status].variant}>{COUNT_STATUS[c.status].label}</Badge>
                </TD>
              </TR>
            ))}
          </TBody>
        </Table>
      )}
      {manual && <ManualCountDialog storeId={storeId} onClose={() => setManual(false)} />}
    </Card>
  );
}

function HistoryTab({ storeId }: { storeId: string }) {
  const [from, setFrom] = useState(() => addDays(todayIso(), -6));
  const [to, setTo] = useState(todayIso);
  const query = useQuery({
    queryKey: ['routines', 'history', from, to, storeId],
    queryFn: () => api<{ rows: RoutineHistoryRow[] }>(`/routines/history${toQuery({ from, to, store_id: storeId })}`).then((r) => r.rows),
    enabled: Boolean(from && to),
  });
  return (
    <Card>
      <div className="flex flex-wrap items-end gap-3 border-b border-border p-4">
        <Field label="De" htmlFor="hist-de" className="w-full sm:w-40">
          <Input id="hist-de" type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
        </Field>
        <Field label="Até" htmlFor="hist-ate" className="w-full sm:w-40">
          <Input id="hist-ate" type="date" value={to} onChange={(e) => setTo(e.target.value)} />
        </Field>
        <p className="text-[13px] text-muted-foreground sm:ml-auto">Dias em que a rotina vencia, quantas foram feitas e os dias que ficaram sem.</p>
      </div>
      {query.isPending ? (
        <Skeleton className="m-4 h-32" />
      ) : query.isError ? (
        <Alert variant="danger" title={query.error.message} className="m-4" />
      ) : !query.data.length ? (
        <EmptyState title="Nada no período" />
      ) : (
        <Table>
          <THead>
            <TR>
              <TH className="pl-4">Rotina</TH>
              <TH>Loja</TH>
              <TH className="text-right">Feitas</TH>
              <TH className="text-right">Atrasadas</TH>
              <TH className="pr-4">Sem rotina</TH>
            </TR>
          </THead>
          <TBody>
            {query.data.map((row) => {
              const rate = row.due ? Math.round((100 * row.done) / row.due) : null;
              return (
                <TR key={`${row.template_id}-${row.store_id}`}>
                  <TD className="pl-4 font-medium">{row.name}</TD>
                  <TD className="text-muted-foreground">{row.store_name}</TD>
                  <TD className="text-right tabular-nums">
                    {row.frequency === 'on_demand' ? (
                      `${row.done}×`
                    ) : (
                      <span className={cn(rate !== null && rate < 100 && 'font-semibold text-destructive', rate === 100 && 'text-success')}>
                        {row.done} de {row.due}
                      </span>
                    )}
                  </TD>
                  <TD className="text-right tabular-nums">{row.late || '—'}</TD>
                  <TD className="pr-4 text-[13px] text-muted-foreground">
                    {row.missed.length ? row.missed.map((d) => formatDay(d).slice(0, 5)).join(', ') : '—'}
                  </TD>
                </TR>
              );
            })}
          </TBody>
        </Table>
      )}
    </Card>
  );
}

function TemplatesTab() {
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState<RoutineTemplate | null | 'new'>(null);
  const [countItems, setCountItems] = useState<string | null>(null);
  const templates = useQuery({
    queryKey: ['routines', 'templates'],
    queryFn: () => api<{ items: RoutineTemplate[] }>('/routines/templates').then((r) => r.items),
  });
  const settings = useQuery({
    queryKey: ['routines', 'settings'],
    queryFn: () => api<{ settings: { enabled: boolean; count_items: number } }>('/routines/settings').then((r) => r.settings),
  });
  const saveSettings = useMutation({
    mutationFn: (body: { enabled: boolean; count_items: number }) => api('/routines/settings', { method: 'PUT', body }),
    onSuccess: (_, body) => {
      queryClient.invalidateQueries({ queryKey: ['routines'] });
      queryClient.invalidateQueries({ queryKey: ME_KEY });
      toast.success(body.enabled ? 'Configuração salva.' : 'Rotinas desligadas.');
      setCountItems(null);
    },
    onError: (err) => toast.error(errorText(err, 'Não foi possível salvar.')),
  });
  const stores = useStoreOptions(true);
  const storeName = (id: number | null) => (id === null ? 'Todas as lojas' : (stores.data?.find((s) => s.id === id)?.name ?? 'Loja'));
  return (
    <div className="grid gap-6">
      <Card>
        <CardHeader>
          <CardTitle>Modelos</CardTitle>
          <Button size="sm" onClick={() => setEditing('new')}>
            <Plus />
            Novo modelo
          </Button>
        </CardHeader>
        {templates.isPending ? (
          <Skeleton className="m-4 h-32" />
        ) : (
          <ul className="divide-y divide-border border-t border-border">
            {(templates.data ?? []).map((t) => (
              <li key={t.id}>
                <button type="button" onClick={() => setEditing(t)} className="flex w-full flex-wrap items-center gap-3 px-5 py-3 text-left hover:bg-muted/50">
                  {t.kind === 'stock_count' ? <ScanBarcode className="size-5 text-muted-foreground" /> : <ClipboardCheck className="size-5 text-muted-foreground" />}
                  <span className="min-w-0 flex-1">
                    <span className="flex flex-wrap items-center gap-2 font-medium">
                      {t.name}
                      {!t.active && <Badge>Desativado</Badge>}
                    </span>
                    <span className="block text-[13px] text-muted-foreground">
                      <Clock className="mr-1 inline size-3.5 align-[-2px]" />
                      {scheduleLabel(t)} · {storeName(t.store_id)}
                      {t.kind === 'checklist' && ` · ${t.items.length} ${t.items.length === 1 ? 'item' : 'itens'}`}
                    </span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </Card>
      {settings.data && (
        <Card>
          <CardHeader>
            <div className="grid gap-1">
              <CardTitle>Configuração</CardTitle>
              <CardDescription>Quantos produtos entram em cada contagem pela curva ABC.</CardDescription>
            </div>
          </CardHeader>
          <CardContent className="flex flex-wrap items-end gap-3">
            <Field label="Produtos por contagem" htmlFor="rotinas-qtd" className="w-40">
              <Input
                id="rotinas-qtd"
                type="number"
                min={5}
                max={200}
                value={countItems ?? String(settings.data.count_items)}
                onChange={(e) => setCountItems(e.target.value)}
              />
            </Field>
            <Button
              variant="outline"
              disabled={countItems === null}
              loading={saveSettings.isPending}
              onClick={() => saveSettings.mutate({ enabled: true, count_items: Number(countItems) })}
            >
              Salvar
            </Button>
            <Button
              variant="ghost"
              className="text-destructive sm:ml-auto"
              onClick={() => saveSettings.mutate({ enabled: false, count_items: settings.data!.count_items })}
            >
              Desligar rotinas
            </Button>
          </CardContent>
        </Card>
      )}
      <RoutineTemplateDialog
        open={editing !== null}
        onOpenChange={(o) => !o && setEditing(null)}
        template={editing === 'new' ? null : editing}
        stores={stores.data ?? []}
      />
    </div>
  );
}

export function RoutinesPage() {
  useDocumentTitle('Rotinas');
  const user = useUser();
  const isAdmin = user.role === 'admin';
  const [params, setParams] = useSearchParams();
  const tabs: { value: Tab; label: string }[] = [
    { value: 'hoje', label: 'Hoje' },
    { value: 'contagens', label: 'Contagens' },
    { value: 'historico', label: 'Histórico' },
    ...(isAdmin ? [{ value: 'modelos' as const, label: 'Modelos' }] : []),
  ];
  const tab = tabs.find((t) => t.value === params.get('aba'))?.value ?? 'hoje';
  const [storeId, setStoreId] = useState('');
  const stores = useStoreOptions(isAdmin);

  if (!user.routines_enabled) {
    return (
      <div>
        <PageHeader title="Rotinas" />
        {isAdmin ? <EnableCard /> : <EmptyState title="Rotinas desligadas" description="O administrador liga em Operação → Rotinas." />}
      </div>
    );
  }

  return (
    <div>
      <PageHeader
        title="Rotinas"
        description="Abertura, fechamento, recebimento e a contagem de estoque, feitos no celular."
        actions={
          isAdmin &&
          (stores.data?.length ?? 0) > 1 &&
          tab !== 'modelos' && (
            <NativeSelect aria-label="Loja" value={storeId} onChange={(e) => setStoreId(e.target.value)} className="w-full sm:w-48">
              <option value="">Todas as lojas</option>
              {stores.data!.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </NativeSelect>
          )
        }
      />
      <div className="mb-4 flex overflow-x-auto rounded-md border border-input bg-background p-0.5 sm:inline-flex" role="tablist">
        {tabs.map((t) => (
          <button
            key={t.value}
            role="tab"
            aria-selected={tab === t.value}
            onClick={() => setParams(t.value === 'hoje' ? {} : { aba: t.value })}
            className={cn(
              'h-8 flex-1 rounded px-4 text-sm font-medium whitespace-nowrap',
              tab === t.value ? 'bg-card text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground',
            )}
          >
            {t.label}
          </button>
        ))}
      </div>
      {tab === 'hoje' && <TodayTab storeId={storeId} />}
      {tab === 'contagens' && <CountsTab storeId={storeId} />}
      {tab === 'historico' && <HistoryTab storeId={storeId} />}
      {tab === 'modelos' && <TemplatesTab />}
    </div>
  );
}
