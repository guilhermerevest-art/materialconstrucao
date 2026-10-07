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
import { Field, Input } from '@/components/ui/input';
import { Alert, Skeleton } from '@/components/ui/misc';
import { Table, TBody, TD, TH, THead, TR } from '@/components/ui/table';
import { api, ApiError } from '@/lib/api';
import { useDocumentTitle } from '@/lib/hooks';
import type { Store } from '@/lib/types';

function StoreFormDialog({ open, onOpenChange, store }: { open: boolean; onOpenChange: (open: boolean) => void; store: Store | null }) {
  const queryClient = useQueryClient();
  const [name, setName] = useState('');
  const [address, setAddress] = useState('');
  const [phone, setPhone] = useState('');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setName(store?.name ?? '');
    setAddress(store?.address ?? '');
    setPhone(store?.phone ?? '');
    setError(null);
  }, [open, store]);

  const save = useMutation({
    mutationFn: () => {
      const body = { name, address, phone };
      return store
        ? api<{ store: Store }>(`/stores/${store.id}`, { method: 'PUT', body })
        : api<{ store: Store }>('/stores', { method: 'POST', body });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['stores'] });
      toast.success(store ? 'Loja atualizada.' : 'Loja cadastrada.');
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
          <DialogTitle>{store ? 'Editar loja' : 'Nova loja'}</DialogTitle>
          <DialogDescription>Nome, endereço e telefone saem no cabeçalho do PDF.</DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="grid gap-4">
          {error && <Alert variant="danger" title={error} />}
          <Field label="Nome" htmlFor="loja-nome">
            <Input id="loja-nome" value={name} onChange={(e) => setName(e.target.value)} required autoFocus />
          </Field>
          <Field label="Endereço" htmlFor="loja-endereco">
            <Input id="loja-endereco" value={address} onChange={(e) => setAddress(e.target.value)} />
          </Field>
          <Field label="Telefone" htmlFor="loja-telefone">
            <Input id="loja-telefone" value={phone} onChange={(e) => setPhone(e.target.value)} inputMode="tel" />
          </Field>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancelar
            </Button>
            <Button type="submit" loading={save.isPending}>
              {store ? 'Salvar loja' : 'Cadastrar loja'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function StoresPage() {
  useDocumentTitle('Lojas');
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState<{ open: boolean; store: Store | null }>({ open: false, store: null });
  const [deleting, setDeleting] = useState<Store | null>(null);

  const stores = useQuery({
    queryKey: ['stores'],
    queryFn: () => api<{ items: Store[] }>('/stores').then((r) => r.items),
  });

  const remove = useMutation({
    mutationFn: (store: Store) => api<void>(`/stores/${store.id}`, { method: 'DELETE' }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['stores'] });
      toast.success('Loja excluída.');
      setDeleting(null);
    },
    onError: (err) => {
      toast.error(err instanceof ApiError ? err.message : 'Não foi possível excluir.');
      setDeleting(null);
    },
  });

  return (
    <div>
      <PageHeader
        title="Lojas"
        description="Unidades da rede. Cada vendedor pertence a uma loja e só vê os pedidos dela."
        actions={
          <Button onClick={() => setEditing({ open: true, store: null })}>
            <Plus />
            Nova loja
          </Button>
        }
      />
      <Card>
        {stores.isPending ? (
          <div className="grid gap-2 p-4">
            {Array.from({ length: 3 }, (_, i) => (
              <Skeleton key={i} className="h-10" />
            ))}
          </div>
        ) : !stores.data?.length ? (
          <EmptyState
            title="Nenhuma loja cadastrada"
            description="Cadastre as lojas antes de criar os vendedores."
            action={
              <Button onClick={() => setEditing({ open: true, store: null })}>
                <Plus />
                Nova loja
              </Button>
            }
          />
        ) : (
          <Table>
            <THead>
              <TR>
                <TH className="pl-4">Loja</TH>
                <TH>Endereço</TH>
                <TH>Telefone</TH>
                <TH className="text-right">Usuários ativos</TH>
                <TH className="pr-4">
                  <span className="sr-only">Ações</span>
                </TH>
              </TR>
            </THead>
            <TBody>
              {stores.data.map((store) => (
                <TR key={store.id}>
                  <TD className="pl-4 font-medium">{store.name}</TD>
                  <TD className="text-muted-foreground">{store.address ?? '-'}</TD>
                  <TD className="text-muted-foreground tabular-nums">{store.phone ?? '-'}</TD>
                  <TD className="text-right tabular-nums">{store.users_count}</TD>
                  <TD className="pr-4">
                    <div className="flex justify-end gap-1">
                      <Button variant="ghost" size="sm" onClick={() => setEditing({ open: true, store })}>
                        <Pencil />
                        Editar
                      </Button>
                      <Button
                        variant="destructive-ghost"
                        size="icon"
                        className="size-8"
                        onClick={() => setDeleting(store)}
                        aria-label={`Excluir ${store.name}`}
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

      <StoreFormDialog
        open={editing.open}
        onOpenChange={(open) => setEditing((current) => ({ ...current, open }))}
        store={editing.store}
      />
      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(open) => !open && setDeleting(null)}
        title={`Excluir ${deleting?.name}?`}
        description="Lojas com usuários ou pedidos registrados não podem ser excluídas."
        confirmLabel="Excluir loja"
        destructive
        loading={remove.isPending}
        onConfirm={() => deleting && remove.mutate(deleting)}
      />
    </div>
  );
}
