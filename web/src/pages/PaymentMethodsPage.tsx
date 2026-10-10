import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Pencil, Plus, Trash2 } from 'lucide-react';
import { useEffect, useState, type FormEvent } from 'react';
import { toast } from 'sonner';
import { EmptyState, PageHeader } from '@/components/shared';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import {
  ConfirmDialog,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Checkbox, Field, Input, NativeSelect } from '@/components/ui/input';
import { Alert, Badge, Skeleton } from '@/components/ui/misc';
import { Table, TBody, TD, TH, THead, TR } from '@/components/ui/table';
import { api, ApiError } from '@/lib/api';
import { useDocumentTitle } from '@/lib/hooks';
import { KIND_LABEL, termsLabel } from '@/lib/finance';
import type { PaymentKind, PaymentMethod } from '@/lib/types';
import { cn } from '@/lib/utils';

function PaymentMethodFormDialog({
  open,
  onOpenChange,
  method,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  method: PaymentMethod | null;
}) {
  const queryClient = useQueryClient();
  const [name, setName] = useState('');
  const [active, setActive] = useState(true);
  const [kind, setKind] = useState<PaymentKind>('other');
  const [installments, setInstallments] = useState('1');
  const [firstDue, setFirstDue] = useState('0');
  const [intervalDays, setIntervalDays] = useState('30');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setName(method?.name ?? '');
    setActive(method?.active ?? true);
    setKind(method?.kind ?? 'other');
    setInstallments(String(method?.installments ?? 1));
    setFirstDue(String(method?.first_due_days ?? 0));
    setIntervalDays(String(method?.interval_days ?? 30));
    setError(null);
  }, [open, method]);

  const save = useMutation({
    mutationFn: () => {
      const body = {
        name,
        active,
        kind,
        installments: Number(installments) || 1,
        first_due_days: Number(firstDue) || 0,
        interval_days: Number(intervalDays) || 30,
      };
      return method
        ? api<{ payment_method: PaymentMethod }>(`/payment-methods/${method.id}`, { method: 'PUT', body })
        : api<{ payment_method: PaymentMethod }>('/payment-methods', { method: 'POST', body });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['payment-methods'] });
      toast.success(method ? 'Forma de pagamento atualizada.' : 'Forma de pagamento cadastrada.');
      onOpenChange(false);
    },
    onError: (err) => setError(err instanceof ApiError ? err.message : 'Não foi possível salvar.'),
  });

  function submit(event: FormEvent) {
    event.preventDefault();
    save.mutate();
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{method ? 'Editar forma de pagamento' : 'Nova forma de pagamento'}</DialogTitle>
          <DialogDescription>Aparece para escolher no orçamento e no pedido, e sai no PDF.</DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="grid gap-4">
          {error && <Alert variant="danger" title={error} />}
          <Field
            label="Nome"
            htmlFor="forma-nome"
            hint={
              method?.orders_count
                ? 'Pedidos já salvos continuam com o nome antigo.'
                : 'Ex.: PIX, Cartão de crédito em 3x, Boleto 30 dias.'
            }
          >
            <Input id="forma-nome" value={name} onChange={(e) => setName(e.target.value)} maxLength={60} required autoFocus />
          </Field>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Tipo" htmlFor="forma-tipo" hint="Dinheiro conta na gaveta do caixa; crediário usa o limite do cliente.">
              <NativeSelect id="forma-tipo" value={kind} onChange={(e) => setKind(e.target.value as PaymentKind)}>
                {(Object.keys(KIND_LABEL) as PaymentKind[]).map((k) => (
                  <option key={k} value={k}>
                    {KIND_LABEL[k]}
                  </option>
                ))}
              </NativeSelect>
            </Field>
            <Field label="Parcelas" htmlFor="forma-parcelas">
              <Input
                id="forma-parcelas"
                inputMode="numeric"
                value={installments}
                onChange={(e) => setInstallments(e.target.value.replace(/\D/g, ''))}
                maxLength={2}
              />
            </Field>
            <Field label="1º vencimento (dias)" htmlFor="forma-primeiro" hint="0 = no dia da venda (à vista).">
              <Input
                id="forma-primeiro"
                inputMode="numeric"
                value={firstDue}
                onChange={(e) => setFirstDue(e.target.value.replace(/\D/g, ''))}
                maxLength={3}
              />
            </Field>
            {Number(installments) > 1 && (
              <Field label="Entre parcelas (dias)" htmlFor="forma-intervalo">
                <Input
                  id="forma-intervalo"
                  inputMode="numeric"
                  value={intervalDays}
                  onChange={(e) => setIntervalDays(e.target.value.replace(/\D/g, ''))}
                  maxLength={3}
                />
              </Field>
            )}
          </div>
          <p className="text-[13px] text-muted-foreground">
            Condição: {termsLabel({ installments: Number(installments) || 1, first_due_days: Number(firstDue) || 0, interval_days: Number(intervalDays) || 30 })}.
            Só vale com o financeiro ligado (Configurações).
          </p>
          {method && (
            <label className="flex items-center gap-2 text-sm">
              <Checkbox checked={active} onChange={(e) => setActive(e.target.checked)} />
              Ativa (desmarque para tirar da lista do orçamento e do pedido)
            </label>
          )}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancelar
            </Button>
            <Button type="submit" loading={save.isPending}>
              {method ? 'Salvar' : 'Cadastrar'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function PaymentMethodsPage() {
  useDocumentTitle('Formas de pagamento');
  const queryClient = useQueryClient();
  const methods = useQuery({
    queryKey: ['payment-methods'],
    queryFn: () => api<{ items: PaymentMethod[] }>('/payment-methods').then((r) => r.items),
  });
  const [editing, setEditing] = useState<{ open: boolean; method: PaymentMethod | null }>({ open: false, method: null });
  const [deleting, setDeleting] = useState<PaymentMethod | null>(null);

  const remove = useMutation({
    mutationFn: (method: PaymentMethod) => api<void>(`/payment-methods/${method.id}`, { method: 'DELETE' }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['payment-methods'] });
      toast.success('Forma de pagamento excluída.');
      setDeleting(null);
    },
    onError: (err) => {
      toast.error(err instanceof ApiError ? err.message : 'Não foi possível excluir.');
      setDeleting(null);
    },
  });

  const newButton = (
    <Button onClick={() => setEditing({ open: true, method: null })}>
      <Plus />
      Nova forma
    </Button>
  );

  return (
    <div>
      <PageHeader
        title="Formas de pagamento"
        description="Opções para escolher no orçamento e no pedido."
        actions={newButton}
      />
      <Card>
        {methods.isPending ? (
          <div className="grid gap-2 p-4">
            {Array.from({ length: 3 }, (_, i) => (
              <Skeleton key={i} className="h-10" />
            ))}
          </div>
        ) : !methods.data?.length ? (
          <EmptyState
            title="Nenhuma forma de pagamento"
            description="Cadastre as formas que a loja aceita, como PIX, dinheiro e cartão."
            action={newButton}
          />
        ) : (
          <Table>
            <THead>
              <TR>
                <TH className="pl-4">Forma de pagamento</TH>
                <TH>Tipo</TH>
                <TH>Condição</TH>
                <TH className="text-right">Pedidos</TH>
                <TH>Situação</TH>
                <TH className="pr-4">
                  <span className="sr-only">Ações</span>
                </TH>
              </TR>
            </THead>
            <TBody>
              {methods.data.map((method) => (
                <TR key={method.id} className={cn(!method.active && 'text-muted-foreground')}>
                  <TD className="pl-4 font-medium">{method.name}</TD>
                  <TD className="text-muted-foreground">{KIND_LABEL[method.kind]}</TD>
                  <TD className="text-muted-foreground">{termsLabel(method)}</TD>
                  <TD className="text-right tabular-nums">{method.orders_count}</TD>
                  <TD>
                    <Badge variant={method.active ? 'success' : 'neutral'}>{method.active ? 'Ativa' : 'Desativada'}</Badge>
                  </TD>
                  <TD className="pr-4">
                    <div className="flex justify-end gap-1">
                      <Button variant="ghost" size="sm" onClick={() => setEditing({ open: true, method })}>
                        <Pencil />
                        Editar
                      </Button>
                      <Button
                        variant="destructive-ghost"
                        size="icon"
                        className="size-8"
                        onClick={() => setDeleting(method)}
                        aria-label={`Excluir ${method.name}`}
                      >
                        <Trash2 />
                      </Button>
                    </div>
                  </TD>
                </TR>
              ))}
            </TBody>
          </Table>
        )}
      </Card>

      <PaymentMethodFormDialog
        open={editing.open}
        onOpenChange={(open) => setEditing((current) => ({ ...current, open }))}
        method={editing.method}
      />
      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(open) => !open && setDeleting(null)}
        title={`Excluir ${deleting?.name}?`}
        description="Formas usadas em pedidos não podem ser excluídas; desative-as para tirá-las da lista."
        confirmLabel="Excluir"
        destructive
        loading={remove.isPending}
        onConfirm={() => deleting && remove.mutate(deleting)}
      />
    </div>
  );
}
