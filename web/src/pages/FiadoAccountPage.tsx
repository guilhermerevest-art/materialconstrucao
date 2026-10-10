import { useMutation, useQuery } from '@tanstack/react-query';
import { ArrowLeft, CalendarDays, Download, HandCoins, SlidersHorizontal, Undo2 } from 'lucide-react';
import { useEffect, useState, type FormEvent } from 'react';
import { Link, useParams } from 'react-router';
import { toast } from 'sonner';
import { FiadoReceiveDialog, fiadoAccountKey, useInvalidateFiado } from '@/components/fiado/FiadoReceiveDialog';
import { ReasonDialog } from '@/components/ReasonDialog';
import { EmptyState, PageHeader, WhatsAppIcon } from '@/components/shared';
import { Button } from '@/components/ui/button';
import { Card, CardHeader, CardTitle } from '@/components/ui/card';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Checkbox, Field, Input, Textarea } from '@/components/ui/input';
import { Alert, Badge, Spinner } from '@/components/ui/misc';
import { Table, TBody, TD, TH, THead, TR } from '@/components/ui/table';
import { api, ApiError } from '@/lib/api';
import { useUser } from '@/lib/auth';
import { formatDateTime, formatDay, formatMoney, formatOrderNumber, formatWhatsapp, parseDecimal } from '@/lib/format';
import { useDocumentTitle } from '@/lib/hooks';
import type { FiadoAccount, FiadoEntry, FiadoEntryKind } from '@/lib/types';
import { cn } from '@/lib/utils';

const KIND_LABEL: Record<FiadoEntryKind, string> = {
  purchase: 'Compra',
  charge: 'Multa e juros',
  payment: 'Pagamento',
  refund: 'Devolução',
  adjustment: 'Ajuste',
};

function WhatsappDialog({ account, onClose }: { account: FiadoAccount; onClose: () => void }) {
  const [message, setMessage] = useState(account.message);
  const [withPdf, setWithPdf] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const send = useMutation({
    mutationFn: () => api(`/fiado/accounts/${account.client.id}/whatsapp`, { method: 'POST', body: { message, with_pdf: withPdf } }),
    onSuccess: () => {
      toast.success(`Cobrança enviada para ${account.client.name}.`);
      onClose();
    },
    onError: (err) => setError(err instanceof ApiError ? err.message : 'Não foi possível enviar.'),
  });
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Cobrar pelo WhatsApp</DialogTitle>
          <DialogDescription>{formatWhatsapp(account.client.whatsapp)}</DialogDescription>
        </DialogHeader>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            send.mutate();
          }}
          className="grid gap-4"
        >
          {error && <Alert variant="danger" title={error} />}
          <Field label="Mensagem" htmlFor="cobranca-mensagem">
            <Textarea id="cobranca-mensagem" rows={5} value={message} onChange={(e) => setMessage(e.target.value)} maxLength={1000} />
          </Field>
          <label className="flex items-center gap-2 text-sm">
            <Checkbox checked={withPdf} onChange={(e) => setWithPdf(e.target.checked)} />
            Mandar o extrato em PDF junto
          </label>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              Cancelar
            </Button>
            <Button type="submit" variant="whatsapp" loading={send.isPending}>
              {!send.isPending && <WhatsAppIcon />}
              Enviar
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function AdjustmentDialog({ clientId, onClose }: { clientId: number; onClose: () => void }) {
  const invalidate = useInvalidateFiado();
  const [direction, setDirection] = useState<'debit' | 'credit'>('debit');
  const [amountText, setAmountText] = useState('');
  const [description, setDescription] = useState('');
  const [error, setError] = useState<string | null>(null);
  const save = useMutation({
    mutationFn: (amount: number) => api(`/fiado/accounts/${clientId}/adjustments`, { method: 'POST', body: { amount, description } }),
    onSuccess: () => {
      invalidate();
      toast.success('Ajuste lançado.');
      onClose();
    },
    onError: (err) => setError(err instanceof ApiError ? err.message : 'Não foi possível lançar.'),
  });
  function submit(event: FormEvent) {
    event.preventDefault();
    const amount = parseDecimal(amountText);
    if (amount === null || amount <= 0) return setError('Digite o valor.');
    if (description.trim().length < 3) return setError('Informe o motivo do ajuste.');
    setError(null);
    save.mutate(direction === 'debit' ? amount : -amount);
  }
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Ajuste na conta</DialogTitle>
          <DialogDescription>Para o saldo da caderneta antiga, um acerto ou uma dívida perdoada. Fica no extrato com o motivo.</DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="grid gap-4">
          {error && <Alert variant="danger" title={error} />}
          <div className="flex rounded-md border border-input p-0.5" role="radiogroup" aria-label="Tipo de ajuste">
            {(
              [
                ['debit', 'Cliente passa a dever'],
                ['credit', 'Abater da dívida'],
              ] as const
            ).map(([value, label]) => (
              <button
                key={value}
                type="button"
                role="radio"
                aria-checked={direction === value}
                onClick={() => setDirection(value)}
                className={cn(
                  'h-9 flex-1 rounded text-sm font-medium',
                  direction === value ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:bg-muted',
                )}
              >
                {label}
              </button>
            ))}
          </div>
          <Field label="Valor" htmlFor="ajuste-valor">
            <Input id="ajuste-valor" inputMode="decimal" value={amountText} onChange={(e) => setAmountText(e.target.value)} autoFocus />
          </Field>
          <Field label="Motivo" htmlFor="ajuste-motivo">
            <Input id="ajuste-motivo" value={description} onChange={(e) => setDescription(e.target.value)} maxLength={200} placeholder="Ex.: saldo da caderneta de papel" />
          </Field>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              Cancelar
            </Button>
            <Button type="submit" loading={save.isPending}>
              Lançar ajuste
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function DueDayDialog({ account, onClose }: { account: FiadoAccount; onClose: () => void }) {
  const invalidate = useInvalidateFiado();
  const [day, setDay] = useState(account.client.fiado_due_day ? String(account.client.fiado_due_day) : '');
  const [error, setError] = useState<string | null>(null);
  const save = useMutation({
    mutationFn: (dueDay: number | null) => api(`/fiado/accounts/${account.client.id}/due-day`, { method: 'PUT', body: { due_day: dueDay } }),
    onSuccess: () => {
      invalidate();
      toast.success('Dia de vencimento salvo. Vale para as próximas compras.');
      onClose();
    },
    onError: (err) => setError(err instanceof ApiError ? err.message : 'Não foi possível salvar.'),
  });
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>Dia de vencimento</DialogTitle>
          <DialogDescription>As compras do mês vencem neste dia do mês seguinte. Em branco, vale o da loja.</DialogDescription>
        </DialogHeader>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            const value = day.trim() ? Number(day) : null;
            if (value !== null && (!Number.isInteger(value) || value < 1 || value > 28)) return setError('Use um dia de 1 a 28.');
            save.mutate(value);
          }}
          className="grid gap-4"
        >
          {error && <Alert variant="danger" title={error} />}
          <Field label="Dia (1 a 28)" htmlFor="fiado-dia-cliente">
            <Input id="fiado-dia-cliente" inputMode="numeric" value={day} onChange={(e) => setDay(e.target.value.replace(/\D/g, ''))} maxLength={2} className="w-24" autoFocus />
          </Field>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              Cancelar
            </Button>
            <Button type="submit" loading={save.isPending}>
              Salvar
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** Financeiro → Fiado → cliente: situação, extrato e as ações da conta. */
export function FiadoAccountPage() {
  const clientId = Number(useParams().clientId);
  const user = useUser();
  const isAdmin = user.role === 'admin';
  const invalidate = useInvalidateFiado();
  const [dialog, setDialog] = useState<'receive' | 'whatsapp' | 'adjust' | 'due-day' | null>(null);
  const [reversing, setReversing] = useState<FiadoEntry | null>(null);
  const query = useQuery({
    queryKey: fiadoAccountKey(clientId),
    queryFn: () => api<FiadoAccount>(`/fiado/accounts/${clientId}`),
    enabled: Number.isInteger(clientId) && clientId > 0 && Boolean(user.fiado_enabled),
  });
  useDocumentTitle(query.data ? `Fiado: ${query.data.client.name}` : 'Fiado');
  const [reverseError, setReverseError] = useState<string | null>(null);
  useEffect(() => setReverseError(null), [reversing]);

  const reverse = useMutation({
    mutationFn: ({ entry, reason }: { entry: FiadoEntry; reason: string }) =>
      api(`/fiado/entries/${entry.id}/reverse`, { method: 'POST', body: { reason } }),
    onSuccess: () => {
      invalidate();
      setReversing(null);
      toast.success('Recebimento estornado.');
    },
    onError: (err) => setReverseError(err instanceof ApiError ? err.message : 'Não foi possível estornar.'),
  });

  if (!user.fiado_enabled) return <EmptyState title="Fiado desligado" description="O administrador liga em Configurações → Fiado." />;
  if (query.isPending) return <Spinner className="py-10" />;
  const data = query.data;
  if (!data) return <EmptyState title="Cliente não encontrado" />;
  const { account } = data;

  return (
    <div className="grid grid-cols-1 gap-5">
      <div>
        <Link to="/fiado" className="mb-3 inline-flex items-center gap-1.5 text-sm font-medium text-muted-foreground hover:text-foreground">
          <ArrowLeft className="size-4" />
          Fiado
        </Link>
        <PageHeader
          className="mb-0"
          title={data.client.name}
          description={`${formatWhatsapp(data.client.whatsapp)} · vence todo dia ${data.due_day}`}
          actions={
            <>
              {data.blocked && <Badge variant="danger">Bloqueado para compra fiada</Badge>}
              <Button asChild variant="outline">
                <a href={`/api/fiado/accounts/${clientId}/pdf?download=1`} download>
                  <Download />
                  Extrato
                </a>
              </Button>
              <Button variant="whatsapp" onClick={() => setDialog('whatsapp')}>
                <WhatsAppIcon />
                Cobrar
              </Button>
              {account.balance > 0 && (
                <Button onClick={() => setDialog('receive')}>
                  <HandCoins />
                  Receber
                </Button>
              )}
            </>
          }
        />
      </div>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <div className="rounded-lg border border-border bg-card px-4 py-3">
          <p className="text-sm text-muted-foreground">{account.balance < 0 ? 'Crédito do cliente' : 'Saldo devedor'}</p>
          <p className={cn('text-2xl font-bold tabular-nums', account.balance < 0 && 'text-success')}>{formatMoney(Math.abs(account.balance))}</p>
        </div>
        <div className="rounded-lg border border-border bg-card px-4 py-3">
          <p className="text-sm text-muted-foreground">Vencido</p>
          <p className={cn('text-2xl font-bold tabular-nums', account.overdue > 0 && 'text-destructive')}>{formatMoney(account.overdue)}</p>
          {account.oldest_overdue && (
            <p className="text-[13px] text-destructive">
              desde {formatDay(account.oldest_overdue)} ({account.days_late} {account.days_late === 1 ? 'dia' : 'dias'})
              {account.charges > 0 && ` · encargos ${formatMoney(account.charges)}`}
            </p>
          )}
        </div>
        <div className="rounded-lg border border-border bg-card px-4 py-3">
          <p className="text-sm text-muted-foreground">Próximo vencimento</p>
          <p className="text-2xl font-bold tabular-nums">{account.next_due ? formatDay(account.next_due) : '—'}</p>
          {account.next_due && <p className="text-[13px] text-muted-foreground tabular-nums">{formatMoney(account.next_due_amount)}</p>}
        </div>
        <div className="rounded-lg border border-border bg-card px-4 py-3">
          <p className="text-sm text-muted-foreground">Limite disponível</p>
          <p className="text-2xl font-bold tabular-nums">{data.available !== null ? formatMoney(data.available) : 'Sem limite'}</p>
          <p className="text-[13px] text-muted-foreground tabular-nums">
            {data.client.credit_limit !== null ? `de ${formatMoney(data.client.credit_limit)}` : 'Defina em Clientes → Crédito'}
            {data.store_credit_open > 0 && ` · crediário ${formatMoney(data.store_credit_open)}`}
          </p>
        </div>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Extrato</CardTitle>
          {isAdmin && (
            <div className="flex flex-wrap gap-2">
              <Button variant="ghost" size="sm" onClick={() => setDialog('due-day')}>
                <CalendarDays />
                Vencimento
              </Button>
              <Button variant="ghost" size="sm" onClick={() => setDialog('adjust')}>
                <SlidersHorizontal />
                Ajuste
              </Button>
            </div>
          )}
        </CardHeader>
        {data.entries.length === 0 ? (
          <EmptyState title="Nenhum lançamento" />
        ) : (
          <Table>
            <THead>
              <TR>
                <TH className="pl-5">Data</TH>
                <TH>Lançamento</TH>
                <TH>Vence</TH>
                <TH className="text-right">Valor</TH>
                <TH className="text-right">Saldo</TH>
                <TH className="pr-5">
                  <span className="sr-only">Ações</span>
                </TH>
              </TR>
            </THead>
            <TBody>
              {[...data.entries].reverse().map((entry) => (
                <TR key={entry.id} className={cn(entry.cancelled_at && 'opacity-55')}>
                  <TD className="pl-5 whitespace-nowrap text-muted-foreground tabular-nums">{formatDateTime(entry.created_at)}</TD>
                  <TD>
                    <span className="font-medium">{KIND_LABEL[entry.kind]}</span>
                    {entry.order_id && (
                      <Link to={`/pedidos/${entry.order_id}`} className="ml-2 text-muted-foreground hover:underline">
                        pedido {formatOrderNumber(entry.order_id)}
                      </Link>
                    )}
                    {entry.kind !== 'purchase' && entry.description && <span className="ml-2 text-muted-foreground">{entry.description}</span>}
                    {entry.payment_method_name && <span className="ml-2 text-muted-foreground">· {entry.payment_method_name}</span>}
                    <span className="block text-[12px] text-muted-foreground">
                      {entry.user_name}
                      {entry.cancelled_at && <span className="text-destructive"> · cancelado: {entry.cancel_reason}</span>}
                    </span>
                  </TD>
                  <TD className="whitespace-nowrap tabular-nums">{entry.amount > 0 && entry.due_date ? formatDay(entry.due_date) : ''}</TD>
                  <TD className={cn('text-right font-semibold whitespace-nowrap tabular-nums', entry.amount < 0 && 'text-success')}>
                    {entry.amount < 0 ? '- ' : ''}
                    {formatMoney(Math.abs(entry.amount))}
                  </TD>
                  <TD className="text-right whitespace-nowrap tabular-nums">{entry.balance_after !== null ? formatMoney(entry.balance_after) : ''}</TD>
                  <TD className="pr-5 text-right">
                    {entry.kind === 'payment' && !entry.cancelled_at && (isAdmin || entry.cash_session_id) && (
                      <Button variant="ghost" size="sm" onClick={() => setReversing(entry)}>
                        <Undo2 />
                        Estornar
                      </Button>
                    )}
                  </TD>
                </TR>
              ))}
            </TBody>
          </Table>
        )}
      </Card>

      {dialog === 'receive' && <FiadoReceiveDialog clientId={clientId} onClose={() => setDialog(null)} />}
      {dialog === 'whatsapp' && <WhatsappDialog account={data} onClose={() => setDialog(null)} />}
      {dialog === 'adjust' && <AdjustmentDialog clientId={clientId} onClose={() => setDialog(null)} />}
      {dialog === 'due-day' && <DueDayDialog account={data} onClose={() => setDialog(null)} />}
      <ReasonDialog
        open={reversing !== null}
        onOpenChange={(open) => !open && setReversing(null)}
        title="Estornar este recebimento?"
        description="O valor volta para o saldo do cliente. Os encargos cobrados junto também saem."
        confirmLabel="Estornar"
        suggestions={['Lançado errado', 'Cheque devolvido', 'PIX não caiu']}
        loading={reverse.isPending}
        error={reverseError}
        onConfirm={(reason) => reversing && reverse.mutate({ entry: reversing, reason })}
      />
    </div>
  );
}

