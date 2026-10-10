import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { HardHat, Pencil, Plus, Trash2 } from 'lucide-react';
import { useEffect, useState, type FormEvent } from 'react';
import { toast } from 'sonner';
import { api, ApiError } from '@/lib/api';
import { formatWhatsapp } from '@/lib/format';
import type { ClientSite } from '@/lib/types';
import { cn } from '@/lib/utils';
import { Button } from './ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from './ui/dialog';
import { Checkbox, Field, Input, Textarea } from './ui/input';
import { Alert, Badge, Skeleton } from './ui/misc';

type Draft = { name: string; address: string; contact_name: string; contact_phone: string; notes: string; active: boolean };

const emptyDraft: Draft = { name: '', address: '', contact_name: '', contact_phone: '', notes: '', active: true };

export function useClientSites(clientId: number | null | undefined) {
  return useQuery({
    queryKey: ['client-sites', clientId],
    queryFn: () => api<{ items: ClientSite[] }>(`/clients/${clientId}/sites`).then((r) => r.items),
    enabled: Boolean(clientId),
  });
}

/** Endereço de entrega montado a partir da obra: o endereço e, se houver, o contato na obra. */
export function siteDeliveryAddress(site: ClientSite) {
  const contact = [site.contact_name, site.contact_phone ? formatWhatsapp(site.contact_phone) : null].filter(Boolean).join(' ');
  return contact ? `${site.address}\nContato na obra: ${contact}` : site.address;
}

/** Obras (endereços de entrega) de um cliente. Na tela de clientes e no PDV, para cadastrar sem sair do pedido. */
export function ClientSitesDialog({
  client,
  open,
  onOpenChange,
  startNew = false,
  onCreated,
}: {
  client: { id: number; name: string };
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Abre direto no formulário de obra nova (atalho do PDV). */
  startNew?: boolean;
  onCreated?: (site: ClientSite) => void;
}) {
  const queryClient = useQueryClient();
  const sites = useClientSites(open ? client.id : null);
  const [editing, setEditing] = useState<ClientSite | 'new' | null>(null);
  const [draft, setDraft] = useState<Draft>(emptyDraft);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setEditing(startNew ? 'new' : null);
    setDraft(emptyDraft);
    setError(null);
  }, [open, startNew]);

  function edit(site: ClientSite | 'new') {
    setEditing(site);
    setError(null);
    setDraft(
      site === 'new'
        ? emptyDraft
        : {
            name: site.name,
            address: site.address,
            contact_name: site.contact_name ?? '',
            contact_phone: site.contact_phone ? formatWhatsapp(site.contact_phone) : '',
            notes: site.notes ?? '',
            active: site.active,
          },
    );
  }

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ['client-sites', client.id] });
    queryClient.invalidateQueries({ queryKey: ['clients'] });
  };

  const save = useMutation({
    mutationFn: () =>
      editing === 'new'
        ? api<{ site: ClientSite }>(`/clients/${client.id}/sites`, { method: 'POST', body: draft })
        : api<{ site: ClientSite }>(`/client-sites/${(editing as ClientSite).id}`, { method: 'PUT', body: draft }),
    onSuccess: ({ site }) => {
      invalidate();
      toast.success(editing === 'new' ? `Obra "${site.name}" cadastrada.` : 'Obra atualizada.');
      if (editing === 'new') onCreated?.(site);
      setEditing(null);
    },
    onError: (err) => setError(err instanceof ApiError ? err.message : 'Não foi possível salvar.'),
  });

  const remove = useMutation({
    mutationFn: (site: ClientSite) => api(`/client-sites/${site.id}`, { method: 'DELETE' }),
    onSuccess: () => {
      invalidate();
      toast.success('Obra excluída.');
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : 'Não foi possível excluir.'),
  });

  function submit(event: FormEvent) {
    event.preventDefault();
    save.mutate();
  }

  const set = (patch: Partial<Draft>) => setDraft((current) => ({ ...current, ...patch }));

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>Obras de {client.name}</DialogTitle>
          <DialogDescription>Endereços de entrega do cliente. No pedido, escolher a obra preenche o endereço.</DialogDescription>
        </DialogHeader>

        {editing ? (
          <form onSubmit={submit} className="grid gap-4">
            {error && <Alert variant="danger" title={error} />}
            <Field label="Nome da obra" htmlFor="obra-nome" hint="Como o vendedor reconhece. Ex.: Obra Rua das Flores, Casa da praia.">
              <Input id="obra-nome" value={draft.name} onChange={(e) => set({ name: e.target.value })} maxLength={80} autoFocus />
            </Field>
            <Field label="Endereço" htmlFor="obra-endereco">
              <Textarea
                id="obra-endereco"
                value={draft.address}
                onChange={(e) => set({ address: e.target.value })}
                maxLength={300}
                rows={2}
                placeholder="Rua, número, bairro, cidade, referência"
              />
            </Field>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Contato na obra (opcional)" htmlFor="obra-contato">
                <Input id="obra-contato" value={draft.contact_name} onChange={(e) => set({ contact_name: e.target.value })} maxLength={80} />
              </Field>
              <Field label="Telefone do contato" htmlFor="obra-telefone">
                <Input
                  id="obra-telefone"
                  inputMode="tel"
                  value={draft.contact_phone}
                  onChange={(e) => set({ contact_phone: e.target.value })}
                  placeholder="(11) 98765-4321"
                />
              </Field>
            </div>
            <Field label="Observações (opcional)" htmlFor="obra-obs" hint="Ex.: portão azul, descarregar pela lateral.">
              <Input id="obra-obs" value={draft.notes} onChange={(e) => set({ notes: e.target.value })} maxLength={300} />
            </Field>
            {editing !== 'new' && (
              <label className="flex items-center gap-2 text-sm">
                <Checkbox checked={draft.active} onChange={(e) => set({ active: e.target.checked })} />
                Ativa (desmarque quando a obra acabar: some da escolha no pedido)
              </label>
            )}
            <div className="flex justify-end gap-2">
              <Button type="button" variant="outline" onClick={() => (startNew && editing === 'new' ? onOpenChange(false) : setEditing(null))}>
                Cancelar
              </Button>
              <Button type="submit" loading={save.isPending}>
                {editing === 'new' ? 'Cadastrar obra' : 'Salvar'}
              </Button>
            </div>
          </form>
        ) : (
          <div className="grid gap-3">
            {sites.isPending ? (
              <Skeleton className="h-20" />
            ) : !sites.data?.length ? (
              <p className="rounded-md border border-dashed border-border px-4 py-6 text-center text-sm text-muted-foreground">
                Nenhuma obra cadastrada.
              </p>
            ) : (
              <ul className="grid gap-2">
                {sites.data.map((site) => (
                  <li
                    key={site.id}
                    className={cn('flex items-start gap-3 rounded-md border border-border p-3', !site.active && 'opacity-60')}
                  >
                    <HardHat className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
                    <div className="grid min-w-0 flex-1 gap-0.5 text-sm">
                      <p className="flex flex-wrap items-center gap-2 font-medium">
                        {site.name}
                        {!site.active && <Badge>Encerrada</Badge>}
                      </p>
                      <p className="whitespace-pre-line text-muted-foreground">{site.address}</p>
                      {(site.contact_name || site.contact_phone) && (
                        <p className="text-[13px] text-muted-foreground">
                          Contato: {site.contact_name} {site.contact_phone && formatWhatsapp(site.contact_phone)}
                        </p>
                      )}
                      {site.orders_count > 0 && (
                        <p className="text-[13px] text-muted-foreground">
                          {site.orders_count} {site.orders_count === 1 ? 'pedido' : 'pedidos'}
                        </p>
                      )}
                    </div>
                    <div className="flex shrink-0 gap-1">
                      <Button variant="ghost" size="icon" className="size-8" onClick={() => edit(site)} aria-label={`Editar ${site.name}`}>
                        <Pencil />
                      </Button>
                      <Button
                        variant="destructive-ghost"
                        size="icon"
                        className="size-8"
                        loading={remove.isPending && remove.variables?.id === site.id}
                        onClick={() => remove.mutate(site)}
                        aria-label={`Excluir ${site.name}`}
                      >
                        <Trash2 />
                      </Button>
                    </div>
                  </li>
                ))}
              </ul>
            )}
            <Button variant="outline" className="justify-self-start" onClick={() => edit('new')}>
              <Plus />
              Nova obra
            </Button>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
