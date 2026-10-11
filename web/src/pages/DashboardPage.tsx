import { useQuery } from '@tanstack/react-query';
import { ArrowRight, CheckCheck, ClipboardCheck, ListChecks, MessageCircleReply, Plus } from 'lucide-react';
import type { ReactNode } from 'react';
import { Link, useNavigate } from 'react-router';
import { EmptyState, StatusBadge } from '@/components/shared';
import { Button } from '@/components/ui/button';
import { Card, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/misc';
import { Table, TBody, TD, TH, THead, TR } from '@/components/ui/table';
import { api } from '@/lib/api';
import { useUser } from '@/lib/auth';
import { formatDateTime, formatMoney, formatOrderNumber } from '@/lib/format';
import { useDocumentTitle } from '@/lib/hooks';
import { requiredSteps, useSetup } from '@/lib/setup';
import type { Dashboard, RoutineToday, StockCountSummary } from '@/lib/types';
import { cn } from '@/lib/utils';

const today = new Intl.DateTimeFormat('pt-BR', { weekday: 'long', day: 'numeric', month: 'long' }).format(new Date());

function Metric({ label, value, detail, className }: { label: string; value: ReactNode; detail?: ReactNode; className?: string }) {
  return (
    <div className={cn('rounded-lg border border-border bg-card px-5 py-4', className)}>
      <p className="text-sm text-muted-foreground">{label}</p>
      <p className="mt-1 text-3xl font-bold tracking-tight tabular-nums">{value}</p>
      {detail && <p className="mt-0.5 text-sm font-medium text-muted-foreground tabular-nums">{detail}</p>}
    </div>
  );
}

/** Rotinas de hoje que faltam (e as contagens esperando o admin conferir). */
function RoutinesBanner() {
  const user = useUser();
  const query = useQuery({
    queryKey: ['routines', 'today', ''],
    queryFn: () => api<{ items: RoutineToday[]; counts: StockCountSummary[] }>('/routines/today'),
  });
  if (!query.data) return null;
  const due = query.data.items.filter((i) => i.due_today && i.status !== 'done');
  const overdue = due.filter((i) => i.status === 'overdue').length;
  const toReview = user.role === 'admin' ? query.data.counts.filter((c) => c.status === 'submitted').length : 0;
  if (!due.length && !toReview) return null;
  const parts = [
    due.length ? `${due.length} ${due.length === 1 ? 'rotina pendente' : 'rotinas pendentes'}` : null,
    overdue ? `${overdue} ${overdue === 1 ? 'atrasada' : 'atrasadas'}` : null,
    toReview ? `${toReview} ${toReview === 1 ? 'contagem para conferir' : 'contagens para conferir'}` : null,
  ].filter(Boolean);
  return (
    <Link
      to="/rotinas"
      className={cn(
        'flex items-center gap-3 rounded-lg border px-5 py-3 hover:border-primary/50',
        overdue ? 'border-destructive/30 bg-destructive-soft text-destructive' : 'border-border bg-card',
      )}
    >
      <ClipboardCheck className="size-5 shrink-0" aria-hidden />
      <span className="min-w-0 flex-1 text-sm">
        <strong className="font-semibold">Hoje: {parts.join(' · ')}</strong>
        {due[0] && <span className="hidden text-muted-foreground sm:inline"> · {due.map((i) => i.name).slice(0, 3).join(', ')}</span>}
      </span>
      <ArrowRight className="size-4 shrink-0" aria-hidden />
    </Link>
  );
}

/** Enquanto a implantação tem passo obrigatório pendente, o admin vê quanto falta. */
function SetupBanner() {
  const setup = useSetup();
  if (!setup.data) return null;
  const required = requiredSteps(setup.data);
  const missing = required.filter((s) => s.status !== 'done').length;
  if (!missing) return null;
  return (
    <Link
      to="/implantacao"
      className="flex items-center gap-3 rounded-lg border border-border bg-card px-5 py-3 hover:border-primary/50"
    >
      <ListChecks className="size-5 shrink-0 text-primary" aria-hidden />
      <span className="min-w-0 flex-1 text-sm">
        <strong className="font-semibold">
          Implantação: {missing === 1 ? 'falta 1 passo' : `faltam ${missing} passos`}
        </strong>
        <span className="text-muted-foreground"> · {required.length - missing} de {required.length} prontos</span>
      </span>
      <ArrowRight className="size-4 shrink-0 text-muted-foreground" aria-hidden />
    </Link>
  );
}

export function DashboardPage() {
  useDocumentTitle('Início');
  const user = useUser();
  const isAdmin = user.role === 'admin';
  const navigate = useNavigate();
  const { data, isPending } = useQuery({
    queryKey: ['dashboard'],
    queryFn: () => api<Dashboard>('/dashboard'),
    refetchInterval: 60_000,
  });

  const s = data?.summary;
  const firstName = user.name.split(/\s+/)[0];

  return (
    // grid-cols-1 (minmax(0, 1fr)): sem isso a coluna cresce até a largura da tabela de
    // lojas e a página passa da tela no celular.
    <div className="grid grid-cols-1 gap-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="text-sm text-muted-foreground first-letter:uppercase">{today}</p>
          <h1 className="text-2xl font-bold tracking-tight">
            {isAdmin ? 'Movimento da rede hoje' : `${firstName}, seu movimento hoje`}
          </h1>
        </div>
        {isAdmin && (
          <div className="flex flex-wrap gap-2">
            <Button asChild variant="outline">
              <Link to="/clientes">Clientes</Link>
            </Button>
            <Button asChild variant="outline">
              <Link to="/produtos">Produtos</Link>
            </Button>
            <Button asChild>
              <Link to="/pedidos/novo">
                <Plus />
                Novo pedido
              </Link>
            </Button>
          </div>
        )}
      </div>

      <div className={cn('grid gap-4', isAdmin ? 'sm:grid-cols-3' : 'lg:grid-cols-[minmax(0,1.2fr)_1fr_1fr]')}>
        {!isAdmin && (
          <Link
            to="/pedidos/novo"
            className="group flex flex-col justify-between gap-6 rounded-lg bg-primary px-5 py-4 text-primary-foreground hover:bg-primary-hover"
          >
            <span className="flex items-center justify-between">
              <span className="text-sm font-medium text-white/85">{user.store_name}</span>
              <Plus className="size-6" />
            </span>
            <span>
              <span className="block text-2xl font-bold tracking-tight">Novo pedido</span>
              <span className="text-sm text-white/85">Orçamento ou venda, com PDF no WhatsApp do cliente</span>
            </span>
          </Link>
        )}
        {isPending || !s ? (
          Array.from({ length: isAdmin ? 3 : 2 }, (_, i) => <Skeleton key={i} className="h-28" />)
        ) : (
          <>
            <Metric
              label={isAdmin ? 'Pedidos confirmados hoje' : 'Meus pedidos hoje'}
              value={s.orders_today}
              detail={formatMoney(s.orders_today_amount)}
            />
            {isAdmin && <Metric label="Orçamentos lançados hoje" value={s.quotes_today} />}
            <Metric
              label={isAdmin ? 'Orçamentos em aberto (30 dias)' : 'Meus orçamentos em aberto (30 dias)'}
              value={s.open_quotes}
              detail={formatMoney(s.open_quotes_amount)}
            />
          </>
        )}
      </div>

      {s && s.followups_due > 0 && (
        <Link
          to={isAdmin ? '/pedidos?status=followup' : '/pedidos?status=followup&meus=1'}
          className="flex items-center gap-3 rounded-lg border border-warning/30 bg-warning-soft px-5 py-3 text-warning hover:border-warning/60"
        >
          <MessageCircleReply className="size-5 shrink-0" aria-hidden />
          <span className="min-w-0 flex-1 text-sm">
            <strong className="font-semibold">
              {s.followups_due === 1 ? '1 orçamento para retomar hoje' : `${s.followups_due} orçamentos para retomar hoje`}
            </strong>
            <span className="hidden sm:inline"> · clientes que pediram orçamento e ainda não fecharam</span>
          </span>
          <ArrowRight className="size-4 shrink-0" aria-hidden />
        </Link>
      )}

      {user.routines_enabled && <RoutinesBanner />}

      {isAdmin && <SetupBanner />}

      {isAdmin && data && data.by_store.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>Por loja, hoje</CardTitle>
          </CardHeader>
          <Table>
            <THead>
              <TR>
                <TH className="pl-5">Loja</TH>
                <TH className="text-right">Pedidos</TH>
                <TH className="text-right">Valor dos pedidos</TH>
                <TH className="pr-5 text-right">Orçamentos</TH>
              </TR>
            </THead>
            <TBody>
              {data.by_store.map((store) => (
                <TR key={store.id}>
                  <TD className="pl-5 font-medium">{store.name}</TD>
                  <TD className="text-right tabular-nums">{store.orders_today}</TD>
                  <TD className="text-right font-semibold tabular-nums">{formatMoney(store.orders_today_amount)}</TD>
                  <TD className="pr-5 text-right tabular-nums">{store.quotes_today}</TD>
                </TR>
              ))}
            </TBody>
          </Table>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle>{isAdmin ? 'Últimos lançamentos' : 'Meus últimos lançamentos'}</CardTitle>
          <Button asChild variant="link" size="sm">
            <Link to={isAdmin ? '/pedidos' : '/pedidos?meus=1'}>Ver todos</Link>
          </Button>
        </CardHeader>
        {isPending ? (
          <div className="grid gap-2 px-5 pb-5">
            {Array.from({ length: 4 }, (_, i) => (
              <Skeleton key={i} className="h-10" />
            ))}
          </div>
        ) : !data?.recent.length ? (
          <EmptyState
            title="Nenhum pedido por aqui ainda"
            description="Os orçamentos e pedidos lançados aparecem aqui."
            action={
              <Button asChild size="lg">
                <Link to="/pedidos/novo">
                  <Plus />
                  Criar primeiro pedido
                </Link>
              </Button>
            }
          />
        ) : (
          <Table>
            <THead>
              <TR>
                <TH className="pl-5">Nº</TH>
                <TH>Data</TH>
                <TH>Cliente</TH>
                {isAdmin && <TH>Loja</TH>}
                <TH>Tipo</TH>
                <TH className="text-right">Total</TH>
                <TH className="w-12 pr-5">
                  <span className="sr-only">Enviado</span>
                </TH>
              </TR>
            </THead>
            <TBody>
              {data.recent.map((order) => (
                <TR key={order.id} className="cursor-pointer hover:bg-muted/50" onClick={() => navigate(`/pedidos/${order.id}`)}>
                  <TD className="pl-5 font-semibold tabular-nums">
                    <Link to={`/pedidos/${order.id}`} onClick={(e) => e.stopPropagation()} className="hover:underline">
                      {formatOrderNumber(order.id)}
                    </Link>
                  </TD>
                  <TD className="whitespace-nowrap text-muted-foreground tabular-nums">{formatDateTime(order.created_at)}</TD>
                  <TD className="font-medium">{order.client_name}</TD>
                  {isAdmin && <TD className="text-muted-foreground">{order.store_name}</TD>}
                  <TD>
                    <StatusBadge status={order.status} cancelledFrom={order.cancelled_from} />
                  </TD>
                  <TD className="text-right font-semibold tabular-nums">{formatMoney(order.total_amount)}</TD>
                  <TD className="pr-5">
                    {order.sent_at && <CheckCheck className="size-4 text-success" aria-label="Enviado por WhatsApp" />}
                  </TD>
                </TR>
              ))}
            </TBody>
          </Table>
        )}
      </Card>
    </div>
  );
}
