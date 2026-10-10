import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Ban, Pencil, Plus, Search, Undo2 } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { Link } from 'react-router';
import { toast } from 'sonner';
import { PayableFormDialog } from '@/components/payables/PayableFormDialog';
import { ReasonDialog } from '@/components/ReasonDialog';
import { EmptyState, PageHeader, Pagination } from '@/components/shared';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Field, Input, NativeSelect } from '@/components/ui/input';
import { Alert, Badge, Skeleton } from '@/components/ui/misc';
import { Table, TBody, TD, TH, THead, TR } from '@/components/ui/table';
import { api, ApiError, toQuery } from '@/lib/api';
import { useUser } from '@/lib/auth';
import { formatDateTime, formatDay, formatMoney, moneyToInput, parseDecimal, todayIso } from '@/lib/format';
import { useDebouncedValue, useDocumentTitle } from '@/lib/hooks';
import { PAYABLE_METHOD_LABEL, purchaseNumber } from '@/lib/purchases';
import type { Paginated, Payable, PayableMethod, PayablePayment, PayablesSummary } from '@/lib/types';
import { cn } from '@/lib/utils';

const PAGE_SIZE = 30;

const TABS = [
  { value: 'open', label: 'Em aberto' },
  { value: 'overdue', label: 'Vencidas' },
  { value: 'paid', label: 'Pagas' },
  { value: 'cancelled', label: 'Canceladas' },
  { value: 'all', label: 'Todas' },
] as const;

const useInvalidatePayables = () => {
  const queryClient = useQueryClient();
  return () => {
    queryClient.invalidateQueries({ queryKey: ['payables'] });
    queryClient.invalidateQueries({ queryKey: ['cash'] });
    queryClient.invalidateQueries({ queryKey: ['suppliers'] });
  };
};

function PayDialog({ payable, onClose }: { payable: Payable; onClose: () => void }) {
  const invalidate = useInvalidatePayables();
  const [amount, setAmount] = useState(moneyToInput(payable.remaining));
  const [paidOn, setPaidOn] = useState(todayIso());
  const [method, setMethod] = useState<PayableMethod>('boleto');
  const [note, setNote] = useState('');
  const [error, setError] = useState<{ text: string; cashClosed?: boolean } | null>(null);
  const pay = useMutation({
    mutationFn: (value: number) =>
      api(`/payables/${payable.id}/payments`, { method: 'POST', body: { amount: value, paid_on: paidOn, method, note: note || null } }),
    onSuccess: () => {
      invalidate();
      toast.success('Pagamento registrado.');
      onClose();
    },
    onError: (err) =>
      setError({
        text: err instanceof ApiError ? err.message : 'Não foi possível registrar.',
        cashClosed: err instanceof ApiError && err.code === 'CASH_CLOSED',
      }),
  });
  function submit(event: FormEvent) {
    event.preventDefault();
    const value = parseDecimal(amount);
    if (value === null || value <= 0) return setError({ text: 'Informe o valor pago.' });
    if (value > payable.remaining + 0.005) return setError({ text: `Falta pagar ${formatMoney(payable.remaining)} desta conta.` });
    setError(null);
    pay.mutate(value);
  }
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Pagar conta</DialogTitle>
          <DialogDescription>
            {payable.description}
            {payable.supplier_name ? ` · ${payable.supplier_name}` : ''} · vence {formatDay(payable.due_date)}
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="grid gap-4">
          {error && (
            <Alert variant="danger" title={error.text}>
              {error.cashClosed && (
                <Button asChild variant="outline" size="sm" className="mt-1 justify-self-start">
                  <Link to="/caixa">Abrir o caixa</Link>
                </Button>
              )}
            </Alert>
          )}
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Valor pago" htmlFor="pagar-valor" hint={`Falta ${formatMoney(payable.remaining)}`}>
              <Input id="pagar-valor" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} className="tabular-nums" />
            </Field>
            <Field label="Pago em" htmlFor="pagar-data">
              <Input id="pagar-data" type="date" value={paidOn} onChange={(e) => setPaidOn(e.target.value)} />
            </Field>
          </div>
          <Field
            label="Como foi pago"
            htmlFor="pagar-forma"
            hint={method === 'cash' ? 'Sai da gaveta do seu caixa aberto e entra no fechamento.' : 'Sai da conta da loja; não mexe no caixa.'}
          >
            <NativeSelect id="pagar-forma" value={method} onChange={(e) => setMethod(e.target.value as PayableMethod)}>
              {(Object.keys(PAYABLE_METHOD_LABEL) as PayableMethod[]).map((m) => (
                <option key={m} value={m}>
                  {PAYABLE_METHOD_LABEL[m]}
                </option>
              ))}
            </NativeSelect>
          </Field>
          <Field label="Observação" htmlFor="pagar-obs">
            <Input id="pagar-obs" value={note} onChange={(e) => setNote(e.target.value)} maxLength={200} placeholder="Opcional" />
          </Field>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              Cancelar
            </Button>
            <Button type="submit" loading={pay.isPending}>
              Registrar pagamento
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** Pagamentos da conta, com estorno, correção e cancelamento. */
function DetailDialog({ payable, onEdit, onClose }: { payable: Payable; onEdit: () => void; onClose: () => void }) {
  const invalidate = useInvalidatePayables();
  const [reversing, setReversing] = useState<PayablePayment | null>(null);
  const [cancelling, setCancelling] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const detail = useQuery({
    queryKey: ['payables', 'detail', payable.id],
    queryFn: () => api<{ payable: Payable; payments: PayablePayment[] }>(`/payables/${payable.id}`),
  });
  const reverse = useMutation({
    mutationFn: ({ id, reason }: { id: number; reason: string }) => api(`/payable-payments/${id}/reverse`, { method: 'POST', body: { reason } }),
    onSuccess: () => {
      invalidate();
      setReversing(null);
      toast.success('Pagamento estornado.');
    },
    onError: (err) => setError(err instanceof ApiError ? err.message : 'Não foi possível estornar.'),
  });
  const cancel = useMutation({
    mutationFn: (reason: string) => api(`/payables/${payable.id}/cancel`, { method: 'POST', body: { reason } }),
    onSuccess: () => {
      invalidate();
      toast.success('Conta cancelada.');
      onClose();
    },
    onError: (err) => setError(err instanceof ApiError ? err.message : 'Não foi possível cancelar.'),
  });
  const current = detail.data?.payable ?? payable;
  const payments = detail.data?.payments ?? [];
  const untouched = current.status === 'open' && current.paid_amount === 0;
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{current.description}</DialogTitle>
          <DialogDescription>
            {[current.supplier_name, current.category, current.document_number && `doc. ${current.document_number}`].filter(Boolean).join(' · ')}
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-4 text-sm">
          {error && <Alert variant="danger" title={error} />}
          <dl className="grid grid-cols-2 gap-x-4 gap-y-1 tabular-nums">
            <dt className="text-muted-foreground">Vencimento</dt>
            <dd className={cn('text-right', current.overdue && 'font-semibold text-destructive')}>{formatDay(current.due_date)}</dd>
            <dt className="text-muted-foreground">Parcela</dt>
            <dd className="text-right">
              {current.installment}/{current.installments}
            </dd>
            <dt className="text-muted-foreground">Valor</dt>
            <dd className="text-right">{formatMoney(current.amount)}</dd>
            <dt className="text-muted-foreground">Pago</dt>
            <dd className="text-right">{formatMoney(current.paid_amount)}</dd>
            <dt className="font-medium">Falta</dt>
            <dd className="text-right font-semibold">{current.status === 'cancelled' ? 'Cancelada' : formatMoney(current.remaining)}</dd>
          </dl>
          {(current.entry_id || current.purchase_order_id) && (
            <p className="text-[13px] text-muted-foreground">
              {current.entry_id && `Da entrada de nota nº ${current.entry_id}`}
              {current.purchase_order_id && (
                <>
                  {current.entry_id ? ' · ' : ''}
                  <Link to={`/compras/${current.purchase_order_id}`} className="hover:underline">
                    pedido de compra {purchaseNumber(current.purchase_order_id)}
                  </Link>
                </>
              )}
            </p>
          )}
          {current.cancel_reason && <Alert variant="danger" title={`Cancelada: ${current.cancel_reason}`} />}
          {payments.length > 0 && (
            <ul className="divide-y divide-border rounded-md border border-border">
              {payments.map((p) => (
                <li key={p.id} className={cn('flex flex-wrap items-center gap-2 px-3 py-2', p.reversed_at && 'opacity-55')}>
                  <span className="min-w-0 flex-1">
                    {formatDay(p.paid_on)} · {PAYABLE_METHOD_LABEL[p.method]}
                    <span className="block text-[12px] text-muted-foreground">
                      {p.user_name} em {formatDateTime(p.created_at)}
                      {p.note && ` · ${p.note}`}
                      {p.reversed_at && ` · estornado: ${p.reverse_reason}`}
                    </span>
                  </span>
                  <span className="font-semibold tabular-nums">{formatMoney(p.amount)}</span>
                  {!p.reversed_at && !(p.method === 'cash' && p.session_closed) && (
                    <Button variant="ghost" size="sm" onClick={() => setReversing(p)}>
                      <Undo2 />
                      Estornar
                    </Button>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
        <DialogFooter>
          {untouched && (
            <>
              <Button variant="ghost" className="text-destructive sm:mr-auto" onClick={() => setCancelling(true)}>
                <Ban />
                Cancelar conta
              </Button>
              <Button variant="outline" onClick={onEdit}>
                <Pencil />
                Corrigir
              </Button>
            </>
          )}
          <Button variant="outline" onClick={onClose}>
            Fechar
          </Button>
        </DialogFooter>
        <ReasonDialog
          open={reversing !== null}
          onOpenChange={(o) => !o && setReversing(null)}
          title="Estornar pagamento"
          description={reversing ? `${formatMoney(reversing.amount)} em ${formatDay(reversing.paid_on)}. A conta volta a ficar em aberto.` : undefined}
          confirmLabel="Estornar"
          suggestions={['Valor errado', 'Pago na conta errada', 'Lançado em dobro']}
          loading={reverse.isPending}
          onConfirm={(reason) => reversing && reverse.mutate({ id: reversing.id, reason })}
        />
        <ReasonDialog
          open={cancelling}
          onOpenChange={setCancelling}
          title="Cancelar conta"
          description="A conta sai das contas a pagar."
          confirmLabel="Cancelar conta"
          suggestions={['Lançada em dobro', 'Fornecedor cancelou o boleto', 'Valor negociado em outra conta']}
          loading={cancel.isPending}
          onConfirm={(reason) => cancel.mutate(reason)}
        />
      </DialogContent>
    </Dialog>
  );
}

export function PayablesPage() {
  useDocumentTitle('Contas a pagar');
  const user = useUser();
  const [status, setStatus] = useState<(typeof TABS)[number]['value']>('open');
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const [paying, setPaying] = useState<Payable | null>(null);
  const [viewing, setViewing] = useState<Payable | null>(null);
  const [form, setForm] = useState<{ payable: Payable | null } | null>(null);
  const q = useDebouncedValue(search.trim(), 300);
  const list = useQuery({
    queryKey: ['payables', 'list', status, q, page],
    queryFn: () =>
      api<Paginated<Payable> & { summary: PayablesSummary }>(`/payables${toQuery({ status, q, page, page_size: PAGE_SIZE })}`),
    placeholderData: keepPreviousData,
    enabled: Boolean(user.finance_enabled),
  });

  if (!user.finance_enabled) {
    return (
      <EmptyState
        title="Financeiro desligado"
        description="Contas a pagar fazem parte do financeiro, que é opcional. Ligue em Administração → Configurações → Financeiro."
      />
    );
  }

  const data = list.data;
  const summary = data?.summary;
  const cards: { label: string; value: number; danger?: boolean; filter?: (typeof TABS)[number]['value'] }[] = summary
    ? [
        { label: 'Vencido', value: summary.overdue, danger: summary.overdue > 0, filter: 'overdue' },
        { label: 'Vence hoje', value: summary.today },
        { label: 'Próximos 7 dias', value: summary.next_7_days },
        { label: 'Total em aberto', value: summary.open_total, filter: 'open' },
      ]
    : [];

  return (
    <div>
      <PageHeader
        title="Contas a pagar"
        description="Duplicatas das notas de compra e as contas da loja. Em dinheiro, o pagamento sai do caixa."
        actions={
          <Button onClick={() => setForm({ payable: null })}>
            <Plus />
            Nova conta
          </Button>
        }
      />

      {summary && (
        <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
          {cards.map((c) => (
            <button
              key={c.label}
              type="button"
              disabled={!c.filter}
              onClick={() => {
                if (!c.filter) return;
                setStatus(c.filter);
                setPage(1);
              }}
              className="rounded-lg border border-border bg-card px-4 py-3 text-left enabled:hover:border-primary/50"
            >
              <p className="text-sm text-muted-foreground">{c.label}</p>
              <p className={cn('text-xl font-bold tabular-nums sm:text-2xl', c.danger && 'text-destructive')}>{formatMoney(c.value)}</p>
            </button>
          ))}
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
              placeholder="Descrição, fornecedor, categoria ou nº"
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
              <Skeleton key={i} className="h-10" />
            ))}
          </div>
        ) : !data?.items.length ? (
          <EmptyState title="Nenhuma conta aqui" description={status === 'open' ? 'As duplicatas entram pela entrada de nota; o resto em "Nova conta".' : undefined} />
        ) : (
          <>
            <Table>
              <THead>
                <TR>
                  <TH className="pl-4">Vencimento</TH>
                  <TH>Conta</TH>
                  <TH>Fornecedor</TH>
                  <TH>Parcela</TH>
                  <TH className="text-right">Valor</TH>
                  <TH className="text-right">Falta</TH>
                  <TH className="pr-4">
                    <span className="sr-only">Ações</span>
                  </TH>
                </TR>
              </THead>
              <TBody className={cn(list.isPlaceholderData && 'opacity-60')}>
                {data.items.map((p) => (
                  <TR key={p.id} className="cursor-pointer hover:bg-muted/50" onClick={() => setViewing(p)}>
                    <TD className={cn('pl-4 whitespace-nowrap tabular-nums', p.overdue && 'font-semibold text-destructive')}>{formatDay(p.due_date)}</TD>
                    <TD className="font-medium">
                      {p.description}
                      {(p.category || p.document_number) && (
                        <span className="block text-xs font-normal text-muted-foreground">
                          {[p.category, p.document_number].filter(Boolean).join(' · ')}
                        </span>
                      )}
                    </TD>
                    <TD className="text-muted-foreground">{p.supplier_name ?? '—'}</TD>
                    <TD className="text-muted-foreground tabular-nums">
                      {p.installment}/{p.installments}
                    </TD>
                    <TD className="text-right tabular-nums">{formatMoney(p.amount)}</TD>
                    <TD className="text-right font-semibold tabular-nums">
                      {p.status === 'open' ? (
                        formatMoney(p.remaining)
                      ) : (
                        <Badge variant={p.status === 'paid' ? 'success' : 'danger'}>{p.status === 'paid' ? 'Paga' : 'Cancelada'}</Badge>
                      )}
                    </TD>
                    <TD className="pr-4 text-right">
                      {p.status === 'open' && (
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={(e) => {
                            e.stopPropagation();
                            setPaying(p);
                          }}
                        >
                          Pagar
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

      {paying && <PayDialog payable={paying} onClose={() => setPaying(null)} />}
      {viewing && (
        <DetailDialog
          payable={viewing}
          onClose={() => setViewing(null)}
          onEdit={() => {
            setForm({ payable: viewing });
            setViewing(null);
          }}
        />
      )}
      <PayableFormDialog open={form !== null} onOpenChange={(o) => !o && setForm(null)} payable={form?.payable} />
    </div>
  );
}
