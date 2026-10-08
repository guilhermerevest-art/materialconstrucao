import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { CheckCheck, Plus, Search } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { EmptyState, PageHeader, Pagination, StatusBadge } from '@/components/shared';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Checkbox, Input, Label, NativeSelect } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/misc';
import { Table, TBody, TD, TH, THead, TR } from '@/components/ui/table';
import { api, toQuery } from '@/lib/api';
import { useUser } from '@/lib/auth';
import { formatDateTime, formatMoney, formatOrderNumber } from '@/lib/format';
import { useDebouncedValue, useDocumentTitle } from '@/lib/hooks';
import type { OrderSummary, Paginated, Store } from '@/lib/types';
import { cn } from '@/lib/utils';

const PAGE_SIZE = 20;

const STATUS_TABS = [
  { value: '', label: 'Todos' },
  { value: 'quote', label: 'Orçamentos' },
  { value: 'order', label: 'Pedidos' },
];

export function OrdersPage() {
  useDocumentTitle('Pedidos');
  const user = useUser();
  const isAdmin = user.role === 'admin';
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();

  // Filtros ficam na URL: voltar do detalhe mantém a lista como estava.
  const status = params.get('status') ?? '';
  const from = params.get('de') ?? '';
  const to = params.get('ate') ?? '';
  const storeId = params.get('loja') ?? '';
  const mine = params.get('meus') === '1';
  const page = Math.max(1, Number(params.get('pagina') ?? 1) || 1);
  const [search, setSearch] = useState(params.get('q') ?? '');
  const q = useDebouncedValue(search.trim(), 300);

  function update(changes: Record<string, string | null>) {
    setParams(
      (current) => {
        const next = new URLSearchParams(current);
        for (const [key, value] of Object.entries(changes)) {
          if (value) next.set(key, value);
          else next.delete(key);
        }
        if (!('pagina' in changes)) next.delete('pagina');
        return next;
      },
      { replace: true },
    );
  }

  useEffect(() => {
    if ((params.get('q') ?? '') !== q) update({ q });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q]);

  const stores = useQuery({
    queryKey: ['stores'],
    queryFn: () => api<{ items: Store[] }>('/stores').then((r) => r.items),
    enabled: isAdmin,
  });

  const filters = { status, from, to, q, store_id: storeId, mine: mine ? 'true' : '', page, page_size: PAGE_SIZE };
  const orders = useQuery({
    queryKey: ['orders', filters],
    queryFn: () => api<Paginated<OrderSummary>>(`/orders${toQuery(filters)}`),
    placeholderData: keepPreviousData,
  });

  const hasFilters = Boolean(status || from || to || q || storeId || mine);
  const data = orders.data;

  return (
    <div>
      <PageHeader
        title="Pedidos e orçamentos"
        description={isAdmin ? 'Todas as lojas da rede.' : `Lançamentos da ${user.store_name}.`}
        actions={
          <Button asChild>
            <Link to="/pedidos/novo">
              <Plus />
              Novo pedido
            </Link>
          </Button>
        }
      />

      <Card>
        <div className="flex flex-wrap items-end gap-3 border-b border-border p-4">
          <div className="flex rounded-md border border-input bg-background p-0.5" role="group" aria-label="Tipo">
            {STATUS_TABS.map((tab) => (
              <button
                key={tab.value}
                onClick={() => update({ status: tab.value })}
                aria-pressed={status === tab.value}
                className={cn(
                  'h-8 rounded px-3 text-sm font-medium',
                  status === tab.value ? 'bg-card text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground',
                )}
              >
                {tab.label}
              </button>
            ))}
          </div>

          <div className="relative w-full sm:min-w-56 sm:flex-1">
            <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              aria-label="Buscar por cliente ou número"
              placeholder="Cliente ou nº do pedido"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="w-full pl-9"
            />
          </div>

          <div className="grid gap-1 sm:flex sm:items-end sm:gap-3">
            <div className="grid gap-1">
              <Label htmlFor="filtro-de" className="text-xs text-muted-foreground">
                De
              </Label>
              <Input id="filtro-de" type="date" value={from} onChange={(e) => update({ de: e.target.value })} className="w-full sm:w-40" />
            </div>
            <div className="grid gap-1">
              <Label htmlFor="filtro-ate" className="text-xs text-muted-foreground">
                Até
              </Label>
              <Input id="filtro-ate" type="date" value={to} onChange={(e) => update({ ate: e.target.value })} className="w-full sm:w-40" />
            </div>
          </div>

          {isAdmin && (
            <NativeSelect
              aria-label="Loja"
              value={storeId}
              onChange={(e) => update({ loja: e.target.value })}
              className="w-full sm:w-48"
            >
              <option value="">Todas as lojas</option>
              {stores.data?.map((store) => (
                <option key={store.id} value={store.id}>
                  {store.name}
                </option>
              ))}
            </NativeSelect>
          )}

          <label className="flex h-10 items-center gap-2 text-sm">
            <Checkbox checked={mine} onChange={(e) => update({ meus: e.target.checked ? '1' : null })} />
            Só os meus
          </label>

          {hasFilters && (
            <Button
              variant="ghost"
              size="sm"
              className="h-10"
              onClick={() => {
                setSearch('');
                setParams({}, { replace: true });
              }}
            >
              Limpar filtros
            </Button>
          )}
        </div>

        {orders.isPending ? (
          <div className="grid gap-2 p-4">
            {Array.from({ length: 6 }, (_, i) => (
              <Skeleton key={i} className="h-10" />
            ))}
          </div>
        ) : !data || data.items.length === 0 ? (
          hasFilters ? (
            <EmptyState
              title="Nada encontrado com esses filtros"
              description="Mude o período ou o termo da busca."
              action={
                <Button
                  variant="outline"
                  onClick={() => {
                    setSearch('');
                    setParams({}, { replace: true });
                  }}
                >
                  Limpar filtros
                </Button>
              }
            />
          ) : (
            <EmptyState
              title="Nenhum pedido por aqui ainda"
              description="Lance o primeiro orçamento ou pedido. Em seguida, envie o PDF para o cliente pelo WhatsApp."
              action={
                <Button asChild size="lg">
                  <Link to="/pedidos/novo">
                    <Plus />
                    Criar primeiro pedido
                  </Link>
                </Button>
              }
            />
          )
        ) : (
          <>
            <Table>
              <THead>
                <TR>
                  <TH className="pl-4">Nº</TH>
                  <TH>Data</TH>
                  <TH>Cliente</TH>
                  {isAdmin && <TH>Loja</TH>}
                  <TH>Vendedor</TH>
                  <TH>Tipo</TH>
                  <TH className="text-right">Total</TH>
                  <TH className="w-12 pr-4">
                    <span className="sr-only">Enviado</span>
                  </TH>
                </TR>
              </THead>
              <TBody className={cn(orders.isPlaceholderData && 'opacity-60')}>
                {data.items.map((order) => (
                  <TR
                    key={order.id}
                    className="cursor-pointer hover:bg-muted/50"
                    onClick={() => navigate(`/pedidos/${order.id}`)}
                  >
                    <TD className="pl-4 font-semibold tabular-nums">
                      <Link to={`/pedidos/${order.id}`} onClick={(e) => e.stopPropagation()} className="hover:underline">
                        {formatOrderNumber(order.id)}
                      </Link>
                    </TD>
                    <TD className="whitespace-nowrap text-muted-foreground tabular-nums">{formatDateTime(order.created_at)}</TD>
                    <TD className="font-medium">{order.client_name}</TD>
                    {isAdmin && <TD className="text-muted-foreground">{order.store_name}</TD>}
                    <TD className="text-muted-foreground">{order.user_name}</TD>
                    <TD>
                      <StatusBadge status={order.status} />
                    </TD>
                    <TD className="text-right font-semibold whitespace-nowrap tabular-nums">{formatMoney(order.total_amount)}</TD>
                    <TD className="pr-4">
                      {order.sent_at && (
                        <CheckCheck className="size-4 text-success" aria-label="Enviado por WhatsApp" />
                      )}
                    </TD>
                  </TR>
                ))}
              </TBody>
            </Table>
            <Pagination
              page={page}
              pageSize={PAGE_SIZE}
              total={data.total}
              onPageChange={(next) => update({ pagina: String(next) })}
            />
          </>
        )}
      </Card>
    </div>
  );
}
