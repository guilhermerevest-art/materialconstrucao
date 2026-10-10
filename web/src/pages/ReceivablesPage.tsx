import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { Search } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router';
import { ReceiveDialog } from '@/components/ReceiveDialog';
import { EmptyState, PageHeader, Pagination } from '@/components/shared';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input, NativeSelect } from '@/components/ui/input';
import { Badge, Skeleton } from '@/components/ui/misc';
import { Table, TBody, TD, TH, THead, TR } from '@/components/ui/table';
import { api, toQuery } from '@/lib/api';
import { useUser } from '@/lib/auth';
import { formatDay, formatMoney, formatOrderNumber } from '@/lib/format';
import { useDebouncedValue, useDocumentTitle } from '@/lib/hooks';
import type { Paginated, Receivable, Store } from '@/lib/types';
import { cn } from '@/lib/utils';

const PAGE_SIZE = 30;

const TABS = [
  { value: 'open', label: 'Em aberto' },
  { value: 'overdue', label: 'Vencidas' },
  { value: 'paid', label: 'Pagas' },
  { value: 'cancelled', label: 'Canceladas' },
  { value: 'all', label: 'Todas' },
] as const;

type Totals = { amount: number; paid_amount: number; remaining: number; overdue: number };

export function ReceivablesPage() {
  useDocumentTitle('Contas a receber');
  const user = useUser();
  const isAdmin = user.role === 'admin';
  const [status, setStatus] = useState<(typeof TABS)[number]['value']>('open');
  const [search, setSearch] = useState('');
  const [storeId, setStoreId] = useState('');
  const [page, setPage] = useState(1);
  const [receiving, setReceiving] = useState<Receivable | null>(null);
  const q = useDebouncedValue(search.trim(), 300);

  const stores = useQuery({
    queryKey: ['stores'],
    queryFn: () => api<{ items: Store[] }>('/stores').then((r) => r.items),
    enabled: isAdmin,
  });
  const list = useQuery({
    queryKey: ['receivables', 'list', status, q, storeId, page],
    queryFn: () =>
      api<Paginated<Receivable> & { totals: Totals }>(
        `/receivables${toQuery({ status, q, store_id: storeId, page, page_size: PAGE_SIZE })}`,
      ),
    placeholderData: keepPreviousData,
    enabled: Boolean(user.finance_enabled),
  });

  if (!user.finance_enabled) {
    return (
      <EmptyState
        title="Financeiro desligado"
        description="O caixa e as contas a receber são opcionais. O administrador liga em Administração → Configurações → Financeiro."
      />
    );
  }

  const data = list.data;
  return (
    <div>
      <PageHeader title="Contas a receber" description="Parcelas dos pedidos confirmados. Receba pelo caixa." />

      {data && (
        <div className="mb-4 grid gap-3 sm:grid-cols-3">
          <div className="rounded-lg border border-border bg-card px-4 py-3">
            <p className="text-sm text-muted-foreground">Em aberto (filtro atual)</p>
            <p className="text-2xl font-bold tabular-nums">{formatMoney(data.totals.remaining)}</p>
          </div>
          <div className="rounded-lg border border-border bg-card px-4 py-3">
            <p className="text-sm text-muted-foreground">Vencido</p>
            <p className={cn('text-2xl font-bold tabular-nums', data.totals.overdue > 0 && 'text-destructive')}>
              {formatMoney(data.totals.overdue)}
            </p>
          </div>
          <div className="rounded-lg border border-border bg-card px-4 py-3">
            <p className="text-sm text-muted-foreground">Recebido (filtro atual)</p>
            <p className="text-2xl font-bold tabular-nums">{formatMoney(data.totals.paid_amount)}</p>
          </div>
        </div>
      )}

      <Card>
        <div className="flex flex-wrap items-end gap-3 border-b border-border p-4">
          <div className="flex flex-wrap rounded-md border border-input bg-background p-0.5" role="group" aria-label="Situação">
            {TABS.map((tab) => (
              <button
                key={tab.value}
                onClick={() => {
                  setStatus(tab.value);
                  setPage(1);
                }}
                aria-pressed={status === tab.value}
                className={cn(
                  'h-8 rounded px-3 text-sm font-medium whitespace-nowrap',
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
              aria-label="Buscar"
              placeholder="Cliente ou nº do pedido"
              value={search}
              onChange={(e) => {
                setSearch(e.target.value);
                setPage(1);
              }}
              className="w-full pl-9"
            />
          </div>
          {isAdmin && (stores.data?.length ?? 0) > 1 && (
            <NativeSelect aria-label="Loja" value={storeId} onChange={(e) => setStoreId(e.target.value)} className="w-full sm:w-44">
              <option value="">Todas as lojas</option>
              {stores.data!.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </NativeSelect>
          )}
        </div>

        {list.isPending ? (
          <div className="grid gap-2 p-4">
            {Array.from({ length: 5 }, (_, i) => (
              <Skeleton key={i} className="h-10" />
            ))}
          </div>
        ) : !data?.items.length ? (
          <EmptyState title="Nenhuma parcela aqui" />
        ) : (
          <>
            <Table>
              <THead>
                <TR>
                  <TH className="pl-4">Vencimento</TH>
                  <TH>Cliente</TH>
                  <TH>Pedido</TH>
                  <TH>Parcela</TH>
                  <TH>Forma</TH>
                  <TH className="text-right">Valor</TH>
                  <TH className="text-right">Falta</TH>
                  <TH className="pr-4">
                    <span className="sr-only">Ações</span>
                  </TH>
                </TR>
              </THead>
              <TBody className={cn(list.isPlaceholderData && 'opacity-60')}>
                {data.items.map((r) => (
                  <TR key={r.id}>
                    <TD className={cn('pl-4 whitespace-nowrap tabular-nums', r.overdue && 'font-semibold text-destructive')}>
                      {formatDay(r.due_date)}
                    </TD>
                    <TD className="font-medium">{r.client_name}</TD>
                    <TD className="tabular-nums">
                      {r.order_id ? (
                        <Link to={`/pedidos/${r.order_id}`} className="hover:underline">
                          {formatOrderNumber(r.order_id)}
                        </Link>
                      ) : (
                        '—'
                      )}
                    </TD>
                    <TD className="text-muted-foreground tabular-nums">
                      {r.installment}/{r.installments}
                    </TD>
                    <TD className="text-muted-foreground">{r.payment_method_name ?? '—'}</TD>
                    <TD className="text-right tabular-nums">{formatMoney(r.amount)}</TD>
                    <TD className="text-right font-semibold tabular-nums">
                      {r.status === 'open' ? (
                        formatMoney(r.remaining)
                      ) : (
                        <Badge variant={r.status === 'paid' ? 'success' : 'danger'}>{r.status === 'paid' ? 'Paga' : 'Cancelada'}</Badge>
                      )}
                    </TD>
                    <TD className="pr-4 text-right">
                      {r.status === 'open' && (
                        <Button size="sm" variant="outline" onClick={() => setReceiving(r)}>
                          Receber
                        </Button>
                      )}
                    </TD>
                  </TR>
                ))}
              </TBody>
            </Table>
            <Pagination page={page} pageSize={PAGE_SIZE} total={data.total} onPageChange={setPage} />
          </>
        )}
      </Card>
      {receiving && <ReceiveDialog receivable={receiving} onClose={() => setReceiving(null)} />}
    </div>
  );
}
