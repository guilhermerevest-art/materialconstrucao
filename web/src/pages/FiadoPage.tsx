import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { HandCoins, Search } from 'lucide-react';
import { useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { FiadoReceiveDialog } from '@/components/fiado/FiadoReceiveDialog';
import { EmptyState, PageHeader, Pagination } from '@/components/shared';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/misc';
import { Table, TBody, TD, TH, THead, TR } from '@/components/ui/table';
import { api, toQuery } from '@/lib/api';
import { useUser } from '@/lib/auth';
import { formatDateTime, formatDay, formatMoney, formatWhatsapp } from '@/lib/format';
import { useDebouncedValue, useDocumentTitle } from '@/lib/hooks';
import type { FiadoAccountRow, Paginated } from '@/lib/types';
import { cn } from '@/lib/utils';

const PAGE_SIZE = 30;

const TABS = [
  { value: 'open', label: 'Devendo' },
  { value: 'overdue', label: 'Vencidos' },
  { value: 'all', label: 'Todos' },
] as const;

type Totals = { balance: number; overdue: number; overdue_clients: number };

/** Financeiro → Fiado: quem deve na caderneta, o que venceu e o próximo vencimento. */
export function FiadoPage() {
  useDocumentTitle('Fiado');
  const user = useUser();
  const navigate = useNavigate();
  const [status, setStatus] = useState<(typeof TABS)[number]['value']>('open');
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const [receiving, setReceiving] = useState<number | null>(null);
  const q = useDebouncedValue(search.trim(), 300);

  const list = useQuery({
    queryKey: ['fiado', 'list', status, q, page],
    queryFn: () => api<Paginated<FiadoAccountRow> & { totals: Totals }>(`/fiado/accounts${toQuery({ status, q, page, page_size: PAGE_SIZE })}`),
    placeholderData: keepPreviousData,
    enabled: Boolean(user.fiado_enabled),
  });

  if (!user.fiado_enabled) {
    return (
      <EmptyState
        title="Fiado desligado"
        description="O fiado (caderneta) é opcional. O administrador liga em Administração → Configurações → Fiado."
      />
    );
  }

  const data = list.data;
  return (
    <div>
      <PageHeader title="Fiado" description="Caderneta dos clientes: cada compra fiada soma no saldo e vence no mês seguinte." />

      {data && (
        <div className="mb-4 grid gap-3 sm:grid-cols-3">
          <div className="rounded-lg border border-border bg-card px-4 py-3">
            <p className="text-sm text-muted-foreground">A receber</p>
            <p className="text-2xl font-bold tabular-nums">{formatMoney(data.totals.balance)}</p>
          </div>
          <div className="rounded-lg border border-border bg-card px-4 py-3">
            <p className="text-sm text-muted-foreground">Vencido</p>
            <p className={cn('text-2xl font-bold tabular-nums', data.totals.overdue > 0 && 'text-destructive')}>{formatMoney(data.totals.overdue)}</p>
          </div>
          <div className="rounded-lg border border-border bg-card px-4 py-3">
            <p className="text-sm text-muted-foreground">Clientes em atraso</p>
            <p className="text-2xl font-bold tabular-nums">{data.totals.overdue_clients}</p>
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
              aria-label="Buscar cliente"
              placeholder="Buscar cliente"
              value={search}
              onChange={(e) => {
                setSearch(e.target.value);
                setPage(1);
              }}
              className="w-full pl-9"
            />
          </div>
        </div>

        {list.isPending ? (
          <div className="grid gap-2 p-4">
            {Array.from({ length: 5 }, (_, i) => (
              <Skeleton key={i} className="h-11" />
            ))}
          </div>
        ) : !data?.items.length ? (
          <EmptyState
            title={status === 'overdue' ? 'Ninguém em atraso' : 'Nenhum cliente devendo'}
            description='A venda na forma "Fiado" (com limite no cliente) aparece aqui.'
          />
        ) : (
          <>
            <Table>
              <THead>
                <TR>
                  <TH className="pl-4">Cliente</TH>
                  <TH className="text-right">Saldo</TH>
                  <TH className="text-right">Vencido</TH>
                  <TH>Próximo vencimento</TH>
                  <TH className="text-right">Limite</TH>
                  <TH>Último pagamento</TH>
                  <TH className="pr-4">
                    <span className="sr-only">Ações</span>
                  </TH>
                </TR>
              </THead>
              <TBody className={cn(list.isPlaceholderData && 'opacity-60')}>
                {data.items.map((row) => (
                  <TR key={row.client_id} className="cursor-pointer hover:bg-muted/50" onClick={() => navigate(`/fiado/${row.client_id}`)}>
                    <TD className="pl-4">
                      <Link to={`/fiado/${row.client_id}`} onClick={(e) => e.stopPropagation()} className="font-medium hover:underline">
                        {row.client_name}
                      </Link>
                      <p className="text-[13px] text-muted-foreground tabular-nums">{formatWhatsapp(row.client_whatsapp)}</p>
                    </TD>
                    <TD className="text-right font-semibold whitespace-nowrap tabular-nums">
                      {row.balance < 0 ? <span className="text-success">Crédito {formatMoney(-row.balance)}</span> : formatMoney(row.balance)}
                    </TD>
                    <TD className="text-right whitespace-nowrap tabular-nums">
                      {row.overdue > 0 ? (
                        <>
                          <span className="font-semibold text-destructive">{formatMoney(row.overdue)}</span>
                          <span className="block text-[13px] text-destructive">
                            há {row.days_late} {row.days_late === 1 ? 'dia' : 'dias'}
                          </span>
                        </>
                      ) : (
                        <span className="text-muted-foreground">—</span>
                      )}
                    </TD>
                    <TD className="whitespace-nowrap tabular-nums">{row.next_due ? formatDay(row.next_due) : '—'}</TD>
                    <TD className="text-right whitespace-nowrap text-muted-foreground tabular-nums">
                      {row.credit_limit != null ? formatMoney(row.credit_limit) : 'Sem limite'}
                    </TD>
                    <TD className="whitespace-nowrap text-muted-foreground tabular-nums">
                      {row.last_payment_at ? formatDateTime(row.last_payment_at).slice(0, 10) : '—'}
                    </TD>
                    <TD className="pr-4 text-right">
                      {row.balance > 0 && (
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={(e) => {
                            e.stopPropagation();
                            setReceiving(row.client_id);
                          }}
                        >
                          <HandCoins />
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
      {receiving !== null && <FiadoReceiveDialog clientId={receiving} onClose={() => setReceiving(null)} />}
    </div>
  );
}
