import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Pencil, Plus, Trash2, Upload } from 'lucide-react';
import { useEffect, useRef, useState, type ChangeEvent, type FormEvent } from 'react';
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
import { cn } from '@/lib/utils';

const LOGO_MIMES = ['image/png', 'image/jpeg', 'image/webp'] as const;
const MAX_LOGO_BYTES = 500 * 1024;

/** Extrai só o base64, sem o prefixo que o FileReader anexa. */
function readLogoAsBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('Não foi possível ler o arquivo.'));
    reader.onload = () => {
      const result = reader.result;
      if (typeof result !== 'string') {
        reject(new Error('Não foi possível ler o arquivo.'));
        return;
      }
      const comma = result.indexOf(',');
      resolve(comma === -1 ? result : result.slice(comma + 1));
    };
    reader.readAsDataURL(file);
  });
}

function validateLogoFile(file: File): string | null {
  if (!LOGO_MIMES.includes(file.type as (typeof LOGO_MIMES)[number])) {
    return 'A logo deve ser um arquivo PNG, JPEG ou WEBP.';
  }
  if (file.size > MAX_LOGO_BYTES) {
    const kb = Math.ceil(file.size / 1024);
    return `A logo deve ter no máximo 500 KB. A imagem escolhida tem ${kb} KB.`;
  }
  return null;
}

type LogoPayload = { data: string; mime: string };

/** Miniatura carregada sob demanda; loja sem logo não dispara requisição. */
function StoreLogoThumb({ store, className }: { store: Store; className?: string }) {
  const logo = useQuery({
    queryKey: ['stores', 'logo', store.id],
    queryFn: () => api<LogoPayload>(`/stores/${store.id}/logo`),
    enabled: store.has_logo,
    staleTime: Infinity,
  });

  if (!store.has_logo) {
    return (
      <div
        className={cn(
          'grid size-10 shrink-0 place-items-center rounded-md border border-dashed border-border bg-muted text-[10px] leading-none text-muted-foreground',
          className,
        )}
      >
        sem logo
      </div>
    );
  }

  if (logo.isFetching) {
    return <Skeleton className={cn('size-10 rounded-md', className)} />;
  }

  const src = logo.data ? `data:${logo.data.mime};base64,${logo.data.data}` : null;
  return (
    <img
      src={src ?? ''}
      alt={`Logo da loja ${store.name}`}
      className={cn('size-10 rounded-md border border-border object-contain', className)}
    />
  );
}

/** Só aparece na edição — loja nova ainda não tem id. */
function StoreLogoField({ store }: { store: Store }) {
  const queryClient = useQueryClient();
  const inputRef = useRef<HTMLInputElement>(null);
  const [error, setError] = useState<string | null>(null);

  const upload = useMutation({
    mutationFn: (file: File) =>
      readLogoAsBase64(file).then((data) =>
        api<{ store: Store }>(`/stores/${store.id}/logo`, { method: 'PUT', body: { data, mime: file.type } }),
      ),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['stores'] });
      setError(null);
      toast.success('Logo atualizada.');
    },
    onError: (err) => setError(err instanceof ApiError ? err.message : 'Não foi possível enviar a logo.'),
  });

  const remove = useMutation({
    mutationFn: () => api<void>(`/stores/${store.id}/logo`, { method: 'DELETE' }),
    onSuccess: () => {
      queryClient.removeQueries({ queryKey: ['stores', 'logo', store.id] });
      queryClient.invalidateQueries({ queryKey: ['stores'] });
      setError(null);
      toast.success('Logo removida.');
    },
    onError: (err) => setError(err instanceof ApiError ? err.message : 'Não foi possível remover a logo.'),
  });

  function chooseFile(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    // Zerar o valor permite escolher o mesmo arquivo de novo na próxima vez.
    event.target.value = '';
    if (!file) return;
    const problem = validateLogoFile(file);
    setError(problem);
    if (!problem) upload.mutate(file);
  }

  const pending = upload.isPending || remove.isPending;

  return (
    <div className="grid gap-3 rounded-lg border border-border p-3">
      <div className="flex items-center gap-3">
        <StoreLogoThumb store={store} className="size-14" />
        <div className="grid min-w-0 flex-1 gap-1">
          <p className="text-sm font-medium text-foreground">Logo</p>
          <p className="text-[13px] text-muted-foreground">Sai no cabeçalho do PDF, ao lado do nome da loja.</p>
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <input
          ref={inputRef}
          type="file"
          accept={LOGO_MIMES.join(',')}
          onChange={chooseFile}
          className="hidden"
        />
        <Button type="button" variant="outline" size="sm" onClick={() => inputRef.current?.click()} disabled={pending}>
          <Upload />
          Escolher arquivo
        </Button>
        {store.has_logo && (
          <Button type="button" variant="destructive-ghost" size="sm" onClick={() => remove.mutate()} disabled={pending}>
            <Trash2 />
            Remover logo
          </Button>
        )}
      </div>
      {error && <p className="text-[13px] text-destructive">{error}</p>}
      {pending && <p className="text-[13px] text-muted-foreground">Enviando a logo...</p>}
    </div>
  );
}

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
          <DialogDescription>Editar informações da loja.</DialogDescription>
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
          {store && <StoreLogoField store={store} />}
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
  const [editing, setEditing] = useState<{ open: boolean; storeId: number | null }>({ open: false, storeId: null });
  const [deleting, setDeleting] = useState<Store | null>(null);

  const stores = useQuery({
    queryKey: ['stores'],
    queryFn: () => api<{ items: Store[] }>('/stores').then((r) => r.items),
  });

  const editingStore = editing.storeId === null ? null : stores.data?.find((s) => s.id === editing.storeId) ?? null;

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
          <Button onClick={() => setEditing({ open: true, storeId: null })}>
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
              <Button onClick={() => setEditing({ open: true, storeId: null })}>
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
                  <TD className="pl-4">
                    <div className="flex items-center gap-3">
                      <StoreLogoThumb store={store} />
                      <span className="font-medium">{store.name}</span>
                    </div>
                  </TD>
                  <TD className="text-muted-foreground">{store.address ?? '-'}</TD>
                  <TD className="text-muted-foreground tabular-nums">{store.phone ?? '-'}</TD>
                  <TD className="text-right tabular-nums">{store.users_count}</TD>
                  <TD className="pr-4">
                    <div className="flex justify-end gap-1">
                      <Button variant="ghost" size="sm" onClick={() => setEditing({ open: true, storeId: store.id })}>
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
        store={editingStore}
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
