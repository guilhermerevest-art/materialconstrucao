import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { HandCoins, HardHat, Pencil, Plus, Search, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { ClientCreditDialog } from '@/components/ClientCreditDialog';
import { ClientFormDialog } from '@/components/ClientFormDialog';
import { ClientSitesDialog } from '@/components/ClientSitesDialog';
import { EmptyState, PageHeader, Pagination } from '@/components/shared';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { ConfirmDialog } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/misc';
import { Table, TBody, TD, TH, THead, TR } from '@/components/ui/table';
import { api, ApiError, toQuery } from '@/lib/api';
import { useUser } from '@/lib/auth';
import { formatDate, formatMoney, formatWhatsapp } from '@/lib/format';
import { useDebouncedValue, useDocumentTitle } from '@/lib/hooks';
import type { Client, Paginated } from '@/lib/types';

const PAGE_SIZE = 20;

export function ClientsPage() {
  useDocumentTitle('Clientes');
  const user = useUser();
  const queryClient = useQueryClient();
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const [editing, setEditing] = useState<{ open: boolean; client: Client | null }>({ open: false, client: null });
  const [deleting, setDeleting] = useState<Client | null>(null);
  const [sitesOf, setSitesOf] = useState<Client | null>(null);
  const [creditOf, setCreditOf] = useState<Client | null>(null);
  const q = useDebouncedValue(search.trim(), 300);

  const clients = useQuery({
    queryKey: ['clients', 'list', q, page],
    queryFn: () => api<Paginated<Client>>(`/clients${toQuery({ q, page, page_size: PAGE_SIZE })}`),
    placeholderData: keepPreviousData,
  });

  const remove = useMutation({
    mutationFn: (client: Client) => api<void>(`/clients/${client.id}`, { method: 'DELETE' }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['clients'] });
      toast.success('Cliente excluído.');
      setDeleting(null);
    },
    onError: (err) => {
      toast.error(err instanceof ApiError ? err.message : 'Não foi possível excluir.');
      setDeleting(null);
    },
  });

  const data = clients.data;

  return (
    <div>
      <PageHeader
        title="Clientes"
        description="Cadastro único para todas as lojas."
        actions={
          <Button onClick={() => setEditing({ open: true, client: null })}>
            <Plus />
            Novo cliente
          </Button>
        }
      />

      <Card>
        <div className="border-b border-border p-4">
          <div className="relative max-w-md">
            <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              aria-label="Buscar cliente"
              placeholder="Buscar por nome ou WhatsApp"
              value={search}
              onChange={(e) => {
                setSearch(e.target.value);
                setPage(1);
              }}
              className="pl-9"
            />
          </div>
        </div>

        {clients.isPending ? (
          <div className="grid gap-2 p-4">
            {Array.from({ length: 6 }, (_, i) => (
              <Skeleton key={i} className="h-10" />
            ))}
          </div>
        ) : !data || data.items.length === 0 ? (
          <EmptyState
            title={q ? 'Nenhum cliente encontrado' : 'Nenhum cliente cadastrado'}
            description={q ? 'Confira o nome ou o número digitado.' : 'Cadastre aqui ou direto no lançamento do pedido.'}
            action={
              <Button onClick={() => setEditing({ open: true, client: null })}>
                <Plus />
                Novo cliente
              </Button>
            }
          />
        ) : (
          <>
            <Table>
              <THead>
                <TR>
                  <TH className="pl-4">Nome</TH>
                  <TH>WhatsApp</TH>
                  <TH>Obras</TH>
                  <TH className="text-right">Crédito</TH>
                  <TH>Cadastrado em</TH>
                  <TH className="pr-4 text-right">
                    <span className="sr-only">Ações</span>
                  </TH>
                </TR>
              </THead>
              <TBody>
                {data.items.map((client) => (
                  <TR key={client.id}>
                    <TD className="pl-4 font-medium">
                      {client.name}
                      {client.price_list_name && <span className="block text-xs font-normal text-success">Tabela {client.price_list_name}</span>}
                    </TD>
                    <TD className="tabular-nums">{formatWhatsapp(client.whatsapp)}</TD>
                    <TD>
                      <Button variant="ghost" size="sm" onClick={() => setSitesOf(client)} aria-label={`Obras de ${client.name}`}>
                        <HardHat />
                        {client.sites_count ? client.sites_count : 'Cadastrar'}
                      </Button>
                    </TD>
                    <TD className="text-right tabular-nums">
                      {user.role === 'admin' ? (
                        <Button variant="ghost" size="sm" onClick={() => setCreditOf(client)} aria-label={`Crédito de ${client.name}`}>
                          <HandCoins />
                          {client.credit_limit != null ? formatMoney(client.credit_limit) : 'Sem crediário'}
                        </Button>
                      ) : (
                        <span className="text-muted-foreground">
                          {client.credit_limit != null ? formatMoney(client.credit_limit) : '—'}
                        </span>
                      )}
                    </TD>
                    <TD className="text-muted-foreground tabular-nums">{formatDate(client.created_at)}</TD>
                    <TD className="pr-4">
                      <div className="flex justify-end gap-1">
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => setEditing({ open: true, client })}
                          aria-label={`Editar ${client.name}`}
                        >
                          <Pencil />
                          Editar
                        </Button>
                        {user.role === 'admin' && (
                          <Button
                            variant="destructive-ghost"
                            size="icon"
                            className="size-8"
                            onClick={() => setDeleting(client)}
                            aria-label={`Excluir ${client.name}`}
                          >
                            <Trash2 />
                          </Button>
                        )}
                      </div>
                    </TD>
                  </TR>
                ))}
              </TBody>
            </Table>
            <Pagination page={page} pageSize={PAGE_SIZE} total={data.total} onPageChange={setPage} />
          </>
        )}
      </Card>

      <ClientFormDialog
        open={editing.open}
        onOpenChange={(open) => setEditing((current) => ({ ...current, open }))}
        client={editing.client}
      />
      {sitesOf && <ClientSitesDialog client={sitesOf} open onOpenChange={(open) => !open && setSitesOf(null)} />}
      {creditOf && <ClientCreditDialog client={creditOf} open onOpenChange={(open) => !open && setCreditOf(null)} />}
      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(open) => !open && setDeleting(null)}
        title={`Excluir ${deleting?.name}?`}
        description="Clientes com pedidos registrados não podem ser excluídos."
        confirmLabel="Excluir cliente"
        destructive
        loading={remove.isPending}
        onConfirm={() => deleting && remove.mutate(deleting)}
      />
    </div>
  );
}
