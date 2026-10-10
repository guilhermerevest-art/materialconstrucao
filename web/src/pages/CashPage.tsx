import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowDownToLine, ArrowUpFromLine, HandCoins, Lock, Search, Undo2, Wallet } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { Link } from 'react-router';
import { toast } from 'sonner';
import { ReasonDialog } from '@/components/ReasonDialog';
import { ReceiveDialog } from '@/components/ReceiveDialog';
import { EmptyState, PageHeader, Pagination } from '@/components/shared';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Field, Input, NativeSelect } from '@/components/ui/input';
import { Alert, Badge, Skeleton } from '@/components/ui/misc';
import { Table, TBody, TD, TH, THead, TR } from '@/components/ui/table';
import { api, ApiError, toQuery } from '@/lib/api';
import { useUser } from '@/lib/auth';
import { formatDateTime, formatDay, formatMoney, formatOrderNumber, parseDecimal } from '@/lib/format';
import { useDebouncedValue, useDocumentTitle } from '@/lib/hooks';
import type { CashSession, CashSummary, CashView, Paginated, Receivable, ReceivablePayment, Store } from '@/lib/types';
import { cn } from '@/lib/utils';

const MOVEMENT_LABEL = { withdrawal: 'Sangria', deposit: 'Suprimento', refund: 'Devolução', payable: 'Conta paga' } as const;

const errorMessage = (err: unknown, fallback: string) => (err instanceof ApiError ? err.message : fallback);

function OpenCash() {
  const user = useUser();
  const isAdmin = user.role === 'admin';
  const queryClient = useQueryClient();
  const [storeId, setStoreId] = useState(user.store_id ? String(user.store_id) : '');
  const [opening, setOpening] = useState('');
  const stores = useQuery({
    queryKey: ['stores'],
    queryFn: () => api<{ items: Store[] }>('/stores').then((r) => r.items),
    enabled: isAdmin,
  });
  const open = useMutation({
    mutationFn: () =>
      api('/cash/open', {
        method: 'POST',
        body: { store_id: storeId ? Number(storeId) : (stores.data?.[0]?.id ?? null), opening_amount: parseDecimal(opening) ?? 0 },
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['cash'] });
      toast.success('Caixa aberto.');
    },
  });

  function submit(event: FormEvent) {
    event.preventDefault();
    open.mutate();
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Lock className="size-4" aria-hidden />
          Caixa fechado
        </CardTitle>
      </CardHeader>
      <CardContent>
        <form onSubmit={submit} className="flex flex-wrap items-end gap-3">
          {open.error && <Alert variant="danger" title={errorMessage(open.error, 'Não foi possível abrir o caixa.')} className="w-full" />}
          {isAdmin && (
            <Field label="Loja" htmlFor="caixa-loja" className="w-full sm:w-56">
              <NativeSelect id="caixa-loja" value={storeId} onChange={(e) => setStoreId(e.target.value)}>
                {!user.store_id && <option value="">Escolha a loja</option>}
                {(stores.data ?? []).map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </NativeSelect>
            </Field>
          )}
          <Field label="Troco inicial (R$)" htmlFor="caixa-troco" className="w-40">
            <Input id="caixa-troco" inputMode="decimal" value={opening} onChange={(e) => setOpening(e.target.value)} placeholder="0,00" />
          </Field>
          <Button type="submit" size="lg" loading={open.isPending}>
            <Wallet />
            Abrir caixa
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}

function MovementDialog({ kind, onClose }: { kind: 'withdrawal' | 'deposit'; onClose: () => void }) {
  const queryClient = useQueryClient();
  const [amount, setAmount] = useState('');
  const [reason, setReason] = useState('');
  const save = useMutation({
    mutationFn: () => api('/cash/movements', { method: 'POST', body: { kind, amount: parseDecimal(amount), reason } }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['cash'] });
      toast.success(kind === 'withdrawal' ? 'Sangria registrada.' : 'Suprimento registrado.');
      onClose();
    },
  });
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{kind === 'withdrawal' ? 'Sangria' : 'Suprimento'}</DialogTitle>
          <DialogDescription>
            {kind === 'withdrawal' ? 'Dinheiro que sai da gaveta (depósito, cofre, pagamento).' : 'Dinheiro que entra na gaveta para troco.'}
          </DialogDescription>
        </DialogHeader>
        <form
          className="grid gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            save.mutate();
          }}
        >
          {save.error && <Alert variant="danger" title={errorMessage(save.error, 'Não foi possível registrar.')} />}
          <Field label="Valor (R$)" htmlFor="mov-valor">
            <Input id="mov-valor" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} autoFocus />
          </Field>
          <Field label="Motivo" htmlFor="mov-motivo">
            <Input id="mov-motivo" value={reason} onChange={(e) => setReason(e.target.value)} maxLength={200} placeholder="Ex.: depósito no banco" />
          </Field>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              Cancelar
            </Button>
            <Button type="submit" loading={save.isPending}>
              Registrar
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function CloseDialog({ summary, onClose }: { summary: CashSummary; onClose: () => void }) {
  const queryClient = useQueryClient();
  const [counted, setCounted] = useState('');
  const [notes, setNotes] = useState('');
  const value = parseDecimal(counted);
  const difference = value === null ? null : Math.round((value - summary.expected_cash) * 100) / 100;
  const close = useMutation({
    mutationFn: () => api<{ closed: CashView }>('/cash/close', { method: 'POST', body: { counted_amount: value ?? 0, notes: notes || null } }),
    onSuccess: ({ closed }) => {
      queryClient.invalidateQueries({ queryKey: ['cash'] });
      const diff = closed.summary.difference ?? 0;
      toast.success(diff === 0 ? 'Caixa fechado e conferido.' : `Caixa fechado com diferença de ${formatMoney(diff)}.`);
      onClose();
    },
  });
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Fechar o caixa</DialogTitle>
          <DialogDescription>Conte o dinheiro da gaveta. Cartão e PIX conferem pelo extrato da maquininha e do banco.</DialogDescription>
        </DialogHeader>
        <form
          className="grid gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            close.mutate();
          }}
        >
          {close.error && <Alert variant="danger" title={errorMessage(close.error, 'Não foi possível fechar.')} />}
          <dl className="grid grid-cols-2 gap-2 rounded-md border border-border p-3 text-sm">
            <dt className="text-muted-foreground">Dinheiro esperado na gaveta</dt>
            <dd className="text-right font-semibold tabular-nums">{formatMoney(summary.expected_cash)}</dd>
            {summary.methods
              .filter((m) => m.kind !== 'cash')
              .map((m) => (
                <div key={m.method_name} className="contents">
                  <dt className="text-muted-foreground">{m.method_name}</dt>
                  <dd className="text-right tabular-nums">{formatMoney(m.amount)}</dd>
                </div>
              ))}
          </dl>
          <Field label="Dinheiro contado (R$)" htmlFor="fechar-contado">
            <Input id="fechar-contado" inputMode="decimal" value={counted} onChange={(e) => setCounted(e.target.value)} autoFocus />
          </Field>
          {difference !== null && (
            <p className={cn('text-sm font-semibold', difference === 0 ? 'text-success' : 'text-destructive')}>
              {difference === 0 ? 'Bateu certinho.' : difference > 0 ? `Sobrando ${formatMoney(difference)}` : `Faltando ${formatMoney(-difference)}`}
            </p>
          )}
          <Field label="Observação (opcional)" htmlFor="fechar-obs">
            <Input id="fechar-obs" value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={300} />
          </Field>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              Cancelar
            </Button>
            <Button type="submit" loading={close.isPending} disabled={value === null}>
              Fechar caixa
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** Busca parcelas em aberto (cliente ou nº do pedido) para receber no caixa. */
function ReceiveSearch() {
  const [search, setSearch] = useState('');
  const [receiving, setReceiving] = useState<Receivable | null>(null);
  const q = useDebouncedValue(search.trim(), 300);
  const results = useQuery({
    queryKey: ['receivables', 'search', q],
    queryFn: () => api<Paginated<Receivable>>(`/receivables${toQuery({ status: 'open', q, page_size: 15 })}`),
    placeholderData: keepPreviousData,
  });
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <HandCoins className="size-4" aria-hidden />
          Receber
        </CardTitle>
      </CardHeader>
      <CardContent className="grid gap-3">
        <div className="relative">
          <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            aria-label="Buscar cliente ou pedido"
            placeholder="Cliente ou nº do pedido"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="pl-9"
            autoFocus
          />
        </div>
        {!results.data?.items.length ? (
          <p className="py-4 text-center text-sm text-muted-foreground">{q ? 'Nada em aberto para esta busca.' : 'Nenhuma parcela em aberto.'}</p>
        ) : (
          <ul className="divide-y divide-border rounded-md border border-border">
            {results.data.items.map((r) => (
              <li key={r.id} className="flex flex-wrap items-center gap-3 px-3 py-2 text-sm">
                <div className="min-w-0 flex-1">
                  <p className="font-medium">
                    {r.client_name}
                    {r.overdue && (
                      <Badge variant="danger" className="ml-2">
                        Vencida
                      </Badge>
                    )}
                  </p>
                  <p className="text-[13px] text-muted-foreground">
                    {r.order_id ? `Pedido ${formatOrderNumber(r.order_id)} · ` : ''}
                    {r.installment}/{r.installments} · vence {formatDay(r.due_date)} · {r.payment_method_name ?? 'sem forma'}
                  </p>
                </div>
                <span className="font-semibold tabular-nums">{formatMoney(r.remaining)}</span>
                <Button size="sm" onClick={() => setReceiving(r)}>
                  Receber
                </Button>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
      {receiving && <ReceiveDialog receivable={receiving} onClose={() => setReceiving(null)} />}
    </Card>
  );
}

function History() {
  const [page, setPage] = useState(1);
  const sessions = useQuery({
    queryKey: ['cash', 'sessions', page],
    queryFn: () => api<Paginated<CashSession & { summary: CashSummary }>>(`/cash/sessions${toQuery({ page, page_size: 10 })}`),
    placeholderData: keepPreviousData,
  });
  if (!sessions.data?.items.length) return null;
  return (
    <Card>
      <CardHeader>
        <CardTitle>Caixas anteriores</CardTitle>
      </CardHeader>
      <Table>
        <THead>
          <TR>
            <TH className="pl-5">Abertura</TH>
            <TH>Operador</TH>
            <TH>Loja</TH>
            <TH className="text-right">Recebido</TH>
            <TH className="text-right">Dinheiro esperado</TH>
            <TH className="text-right">Contado</TH>
            <TH className="pr-5 text-right">Diferença</TH>
          </TR>
        </THead>
        <TBody>
          {sessions.data.items.map((s) => (
            <TR key={s.id}>
              <TD className="pl-5 whitespace-nowrap tabular-nums">{formatDateTime(s.opened_at)}</TD>
              <TD>{s.user_name}</TD>
              <TD className="text-muted-foreground">{s.store_name}</TD>
              <TD className="text-right tabular-nums">{formatMoney(s.summary.received)}</TD>
              <TD className="text-right tabular-nums">{formatMoney(s.summary.expected_cash)}</TD>
              <TD className="text-right tabular-nums">{s.closed_at ? formatMoney(s.counted_amount ?? 0) : <Badge variant="order">Aberto</Badge>}</TD>
              <TD
                className={cn(
                  'pr-5 text-right font-semibold tabular-nums',
                  s.summary.difference ? 'text-destructive' : s.summary.difference === 0 ? 'text-success' : 'text-muted-foreground',
                )}
              >
                {s.summary.difference === null ? '—' : formatMoney(s.summary.difference)}
              </TD>
            </TR>
          ))}
        </TBody>
      </Table>
      <Pagination page={page} pageSize={10} total={sessions.data.total} onPageChange={setPage} />
    </Card>
  );
}

export function CashPage() {
  useDocumentTitle('Caixa');
  const user = useUser();
  const queryClient = useQueryClient();
  const [movement, setMovement] = useState<'withdrawal' | 'deposit' | null>(null);
  const [closing, setClosing] = useState(false);
  const [reversing, setReversing] = useState<ReceivablePayment | null>(null);
  const current = useQuery({
    queryKey: ['cash', 'current'],
    queryFn: () => api<{ current: CashView | null }>('/cash/current').then((r) => r.current),
  });

  const reverse = useMutation({
    mutationFn: ({ payment, reason }: { payment: ReceivablePayment; reason: string }) =>
      api(payment.source === 'fiado' ? `/fiado/entries/${payment.id}/reverse` : `/receivable-payments/${payment.id}/reverse`, {
        method: 'POST',
        body: { reason },
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['cash'] });
      queryClient.invalidateQueries({ queryKey: ['receivables'] });
      queryClient.invalidateQueries({ queryKey: ['fiado'] });
      queryClient.invalidateQueries({ queryKey: ['order-receivables'] });
      setReversing(null);
      toast.success('Recebimento estornado. A parcela voltou a ficar em aberto.');
    },
  });

  if (!user.finance_enabled) {
    return (
      <EmptyState
        title="Financeiro desligado"
        description="O caixa e as contas a receber são opcionais. O administrador liga em Administração → Configurações → Financeiro."
      />
    );
  }

  const view = current.data;
  return (
    <div className="grid grid-cols-1 gap-5">
      <PageHeader
        className="mb-0"
        title="Caixa"
        description={
          view
            ? `Aberto por ${view.session.user_name} em ${formatDateTime(view.session.opened_at)} · ${view.session.store_name}`
            : 'Abra o caixa para receber pagamentos.'
        }
        actions={
          view && (
            <>
              <Button variant="outline" onClick={() => setMovement('deposit')}>
                <ArrowDownToLine />
                Suprimento
              </Button>
              <Button variant="outline" onClick={() => setMovement('withdrawal')}>
                <ArrowUpFromLine />
                Sangria
              </Button>
              <Button variant="steel" onClick={() => setClosing(true)}>
                <Lock />
                Fechar caixa
              </Button>
            </>
          )
        }
      />

      {current.isPending ? (
        <Skeleton className="h-40" />
      ) : !view ? (
        <OpenCash />
      ) : (
        <>
          <div className="grid gap-4 sm:grid-cols-3">
            <div className="rounded-lg border border-border bg-card px-5 py-4">
              <p className="text-sm text-muted-foreground">Recebido neste caixa</p>
              <p className="mt-1 text-3xl font-bold tracking-tight tabular-nums">{formatMoney(view.summary.received)}</p>
            </div>
            <div className="rounded-lg border border-border bg-card px-5 py-4">
              <p className="text-sm text-muted-foreground">Dinheiro na gaveta (esperado)</p>
              <p className="mt-1 text-3xl font-bold tracking-tight tabular-nums">{formatMoney(view.summary.expected_cash)}</p>
              <p className="text-[13px] text-muted-foreground tabular-nums">
                troco {formatMoney(view.session.opening_amount)}
                {view.summary.withdrawals > 0 && ` · sangrias ${formatMoney(view.summary.withdrawals)}`}
                {view.summary.deposits > 0 && ` · suprimentos ${formatMoney(view.summary.deposits)}`}
                {view.summary.refunds > 0 && ` · devoluções ${formatMoney(view.summary.refunds)}`}
                {view.summary.payables > 0 && ` · contas pagas ${formatMoney(view.summary.payables)}`}
              </p>
            </div>
            <div className="rounded-lg border border-border bg-card px-5 py-4">
              <p className="mb-1 text-sm text-muted-foreground">Por forma</p>
              {view.summary.methods.length ? (
                <dl className="grid grid-cols-[1fr_auto] gap-x-3 text-sm">
                  {view.summary.methods.map((m) => (
                    <div key={m.method_name} className="contents">
                      <dt>{m.method_name}</dt>
                      <dd className="text-right font-semibold tabular-nums">{formatMoney(m.amount)}</dd>
                    </div>
                  ))}
                </dl>
              ) : (
                <p className="text-sm text-muted-foreground">Nada recebido ainda.</p>
              )}
            </div>
          </div>

          <ReceiveSearch />

          {(view.payments.length > 0 || view.movements.length > 0) && (
            <Card>
              <CardHeader>
                <CardTitle>Movimento deste caixa</CardTitle>
              </CardHeader>
              <ul className="divide-y divide-border border-t border-border text-sm">
                {view.payments.map((p) => (
                  <li key={`${p.source ?? 'receivable'}${p.id}`} className={cn('flex flex-wrap items-center gap-3 px-5 py-2.5', p.reversed_at && 'opacity-55')}>
                    <span className="w-14 text-muted-foreground tabular-nums">{formatDateTime(p.received_at).slice(-5)}</span>
                    <span className="min-w-0 flex-1">
                      {p.client_name}
                      {p.source === 'fiado' && <span className="ml-2 text-muted-foreground">fiado</span>}
                      {p.order_id && (
                        <Link to={`/pedidos/${p.order_id}`} className="ml-2 text-muted-foreground hover:underline">
                          pedido {formatOrderNumber(p.order_id)}
                        </Link>
                      )}
                      {p.reversed_at && <span className="ml-2 text-destructive">estornado: {p.reverse_reason}</span>}
                    </span>
                    <Badge>{p.method_name}</Badge>
                    <span className="w-24 text-right font-semibold tabular-nums">{formatMoney(p.amount)}</span>
                    {!p.reversed_at && (
                      <Button variant="ghost" size="sm" onClick={() => setReversing(p)}>
                        <Undo2 />
                        Estornar
                      </Button>
                    )}
                  </li>
                ))}
                {view.movements.map((m) => (
                  <li key={`${m.kind}${m.id}`} className="flex flex-wrap items-center gap-3 px-5 py-2.5">
                    <span className="w-14 text-muted-foreground tabular-nums">{formatDateTime(m.created_at).slice(-5)}</span>
                    <span className="min-w-0 flex-1">
                      {MOVEMENT_LABEL[m.kind]}: {m.reason}
                    </span>
                    <span className={cn('w-24 text-right font-semibold tabular-nums', m.kind === 'deposit' ? 'text-success' : 'text-destructive')}>
                      {m.kind === 'deposit' ? '+' : '-'}
                      {formatMoney(m.amount)}
                    </span>
                  </li>
                ))}
              </ul>
            </Card>
          )}
        </>
      )}

      <History />

      {movement && <MovementDialog kind={movement} onClose={() => setMovement(null)} />}
      {closing && view && <CloseDialog summary={view.summary} onClose={() => setClosing(false)} />}
      <ReasonDialog
        open={reversing !== null}
        onOpenChange={(o) => !o && setReversing(null)}
        title="Estornar este recebimento?"
        description="A parcela volta a ficar em aberto. Devolva o dinheiro ao cliente, se for o caso."
        confirmLabel="Estornar"
        suggestions={['Lançado errado', 'Forma de pagamento errada', 'Devolvido ao cliente']}
        loading={reverse.isPending}
        error={reverse.error ? errorMessage(reverse.error, 'Não foi possível estornar.') : null}
        onConfirm={(reason) => reversing && reverse.mutate({ payment: reversing, reason })}
      />
    </div>
  );
}
