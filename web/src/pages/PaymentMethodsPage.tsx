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
import { Checkbox, Field, Input } from '@/components/ui/input';
import { Alert, Badge, Skeleton } from '@/components/ui/misc';
import { Table, TBody, TD, TH, THead, TR } from '@/components/ui/table';
import { api, ApiError } from '@/lib/api';
import { useDocumentTitle } from '@/lib/hooks';
import type { PaymentMethod } from '@/lib/types';
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
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setName(method?.name ?? '');
    setActive(method?.active ?? true);
    setError(null);
  }, [open, method]);

  const save = useMutation({
    mutationFn: () => {
      const body = { name, active };
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
