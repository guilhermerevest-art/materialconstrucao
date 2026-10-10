import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Pencil, Plus, Tags, Trash2 } from 'lucide-react';
import { useEffect, useState, type FormEvent } from 'react';
import { toast } from 'sonner';
import { ProductPicker } from '@/components/ProductPicker';
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
import { decimalToInput, formatMoney, formatPercent, moneyToInput, parseDecimal } from '@/lib/format';
import { useDocumentTitle } from '@/lib/hooks';
import type { PriceList, PriceListItem } from '@/lib/types';

const LISTS_KEY = ['price-lists'];

/** "10% abaixo do catálogo", "5% acima", "Preço do catálogo". */
function adjustLabel(percent: number) {
  if (percent === 0) return 'Preço do catálogo';
  return percent < 0 ? `${formatPercent(-percent)} abaixo do catálogo` : `${formatPercent(percent)} acima do catálogo`;
}

function PriceListDialog({ list, onClose }: { list: PriceList | null; onClose: () => void }) {
  const queryClient = useQueryClient();
  const [name, setName] = useState(list?.name ?? '');
  const [direction, setDirection] = useState<'down' | 'up'>(list && list.adjust_percent > 0 ? 'up' : 'down');
  const [percent, setPercent] = useState(list ? decimalToInput(Math.abs(list.adjust_percent)) : '');
  const [active, setActive] = useState(list?.active ?? true);
  const [error, setError] = useState<string | null>(null);

  const save = useMutation({
    mutationFn: (body: object) =>
      list
        ? api<{ price_list: PriceList }>(`/price-lists/${list.id}`, { method: 'PUT', body })
        : api<{ price_list: PriceList }>('/price-lists', { method: 'POST', body }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: LISTS_KEY });
      toast.success(list ? 'Tabela atualizada.' : 'Tabela criada. Ponha os clientes nela pelo cadastro do cliente.');
      onClose();
    },
    onError: (err) => setError(err instanceof ApiError ? err.message : 'Não foi possível salvar.'),
  });

  function submit(event: FormEvent) {
    event.preventDefault();
    const value = percent.trim() ? parseDecimal(percent) : 0;
    if (value === null || value < 0) return setError('Percentual inválido. Exemplo: 10');
    save.mutate({ name, adjust_percent: direction === 'down' ? -value : value, active });
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{list ? 'Editar tabela de preço' : 'Nova tabela de preço'}</DialogTitle>
          <DialogDescription>
            O preço de cada produto é o do catálogo com o ajuste abaixo, a não ser que ele tenha preço próprio na tabela.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="grid gap-4">
          {error && <Alert variant="danger" title={error} />}
          <Field label="Nome" htmlFor="tabela-nome" hint="Ex.: Atacado, Construtora, Funcionário">
            <Input id="tabela-nome" value={name} onChange={(e) => setName(e.target.value)} maxLength={60} autoFocus />
          </Field>
          <div className="grid grid-cols-[auto_1fr] items-end gap-3">
            <Field label="Ajuste" htmlFor="tabela-direcao">
              <div className="flex rounded-md border border-input p-0.5" role="radiogroup" aria-label="Ajuste" id="tabela-direcao">
                {(['down', 'up'] as const).map((value) => (
                  <button
                    key={value}
                    type="button"
                    role="radio"
                    aria-checked={direction === value}
                    onClick={() => setDirection(value)}
                    className={
                      direction === value
                        ? 'h-8 rounded bg-primary px-3 text-sm font-medium text-primary-foreground'
                        : 'h-8 rounded px-3 text-sm font-medium text-muted-foreground hover:bg-muted'
                    }
                  >
                    {value === 'down' ? 'Abaixo' : 'Acima'}
                  </button>
                ))}
              </div>
            </Field>
            <Field label="Percentual (%)" htmlFor="tabela-percentual">
              <Input
                id="tabela-percentual"
                inputMode="decimal"
                value={percent}
                onChange={(e) => setPercent(e.target.value)}
                placeholder="0"
                className="text-right tabular-nums"
              />
            </Field>
          </div>
          <label className="flex items-center gap-2 text-sm">
            <Checkbox checked={active} onChange={(e) => setActive(e.target.checked)} />
            Ativa (desativada, os clientes dela voltam ao preço do catálogo)
          </label>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              Cancelar
            </Button>
            <Button type="submit" loading={save.isPending}>
              {list ? 'Salvar' : 'Criar tabela'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

type Row = { product_id: number; code: string | null; name: string; unit: string; catalog_price: number; price: string };

/** Preços próprios da tabela: valem no lugar do catálogo com ajuste. */
function PriceListItemsDialog({ list, onClose }: { list: PriceList; onClose: () => void }) {
  const queryClient = useQueryClient();
  const items = useQuery({
    queryKey: [...LISTS_KEY, list.id, 'items'],
    queryFn: () => api<{ items: PriceListItem[] }>(`/price-lists/${list.id}/items`).then((r) => r.items),
  });
  const [rows, setRows] = useState<Row[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (items.data && rows === null) setRows(items.data.map((i) => ({ ...i, price: moneyToInput(i.price) })));
  }, [items.data, rows]);

  const save = useMutation({
    mutationFn: (body: object) => api(`/price-lists/${list.id}/items`, { method: 'PUT', body }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: LISTS_KEY });
      toast.success('Preços da tabela salvos.');
      onClose();
    },
    onError: (err) => setError(err instanceof ApiError ? err.message : 'Não foi possível salvar.'),
  });

  function submit(event: FormEvent) {
    event.preventDefault();
    const body = [];
    for (const row of rows ?? []) {
      const price = parseDecimal(row.price);
      if (price === null || price < 0) return setError(`Preço inválido em ${row.name}.`);
      body.push({ product_id: row.product_id, price: Math.round(price * 100) / 100 });
    }
    save.mutate({ items: body });
  }

  const adjusted = (catalog: number) => Math.round(catalog * (1 + list.adjust_percent / 100) * 100) / 100;

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Preços próprios: {list.name}</DialogTitle>
          <DialogDescription>
            Produtos fora desta lista seguem o ajuste da tabela ({adjustLabel(list.adjust_percent).toLowerCase()}).
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="grid gap-4">
          {error && <Alert variant="danger" title={error} />}
          <ProductPicker
            value={null}
            placeholder="Adicionar produto com preço próprio"
            onChange={(product) => {
              if (!product || !rows) return;
              if (rows.some((r) => r.product_id === product.id)) return toast.info(`${product.name} já está na tabela.`);
              const catalog = product.price ?? 0;
              setRows([
                ...rows,
                { product_id: product.id, code: product.code, name: product.name, unit: product.unit, catalog_price: catalog, price: moneyToInput(adjusted(catalog)) },
              ]);
            }}
          />
          {rows === null ? (
            <Skeleton className="h-32" />
          ) : rows.length === 0 ? (
            <p className="rounded-md border border-dashed border-input px-4 py-6 text-center text-sm text-muted-foreground">
              Nenhum preço próprio. Todos os produtos seguem o ajuste da tabela.
            </p>
          ) : (
            <div className="max-h-80 overflow-y-auto rounded-md border border-border">
              <Table>
                <THead>
                  <TR>
                    <TH className="pl-3">Produto</TH>
                    <TH className="text-right">Catálogo</TH>
                    <TH className="text-right">Na tabela</TH>
                    <TH className="w-10 pr-3">
                      <span className="sr-only">Remover</span>
                    </TH>
                  </TR>
                </THead>
                <TBody>
                  {rows.map((row) => (
                    <TR key={row.product_id}>
                      <TD className="pl-3">
                        {row.name}
                        {row.code && <span className="ml-2 text-xs text-muted-foreground">{row.code}</span>}
                      </TD>
                      <TD className="text-right text-muted-foreground tabular-nums">{formatMoney(row.catalog_price)}</TD>
                      <TD className="text-right">
                        <Input
                          aria-label={`Preço de ${row.name} na tabela`}
                          inputMode="decimal"
                          value={row.price}
                          onChange={(e) => setRows(rows.map((r) => (r.product_id === row.product_id ? { ...r, price: e.target.value } : r)))}
                          className="ml-auto h-9 w-28 text-right tabular-nums"
                        />
                      </TD>
                      <TD className="pr-3">
                        <Button
                          type="button"
                          variant="destructive-ghost"
                          size="icon"
                          aria-label={`Tirar ${row.name} da tabela`}
                          onClick={() => setRows(rows.filter((r) => r.product_id !== row.product_id))}
                        >
                          <Trash2 />
                        </Button>
                      </TD>
                    </TR>
                  ))}
                </TBody>
              </Table>
            </div>
          )}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              Cancelar
            </Button>
            <Button type="submit" loading={save.isPending} disabled={rows === null}>
              Salvar preços
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** Administração → Tabelas de preço: varejo, atacado, construtora... */
export function PriceListsPage() {
  useDocumentTitle('Tabelas de preço');
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState<{ list: PriceList | null } | null>(null);
  const [pricing, setPricing] = useState<PriceList | null>(null);
  const [deleting, setDeleting] = useState<PriceList | null>(null);
  const lists = useQuery({ queryKey: LISTS_KEY, queryFn: () => api<{ items: PriceList[] }>('/price-lists').then((r) => r.items) });

  const remove = useMutation({
    mutationFn: (list: PriceList) => api(`/price-lists/${list.id}`, { method: 'DELETE' }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: LISTS_KEY });
      queryClient.invalidateQueries({ queryKey: ['clients'] });
      toast.success('Tabela excluída. Os clientes dela voltaram ao preço do catálogo.');
      setDeleting(null);
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : 'Não foi possível excluir.'),
  });

  return (
    <div>
      <PageHeader
        title="Tabelas de preço"
        description="Preço diferente por tipo de cliente. O cliente entra na tabela pelo cadastro dele; sem tabela, vale o catálogo."
        actions={
          <Button onClick={() => setEditing({ list: null })}>
            <Plus />
            Nova tabela
          </Button>
        }
      />
      <Card>
        {lists.isPending ? (
          <div className="grid gap-2 p-4">
            <Skeleton className="h-10" />
            <Skeleton className="h-10" />
          </div>
        ) : !lists.data?.length ? (
          <EmptyState
            title="Nenhuma tabela de preço"
            description="Sem tabela, todo cliente compra pelo preço do catálogo (com as faixas por quantidade, se houver)."
            action={
              <Button onClick={() => setEditing({ list: null })}>
                <Plus />
                Criar a primeira
              </Button>
            }
          />
        ) : (
          <Table>
            <THead>
              <TR>
                <TH className="pl-4">Tabela</TH>
                <TH>Ajuste</TH>
                <TH className="text-right">Preços próprios</TH>
                <TH className="text-right">Clientes</TH>
                <TH>Situação</TH>
                <TH className="pr-4">
                  <span className="sr-only">Ações</span>
                </TH>
              </TR>
            </THead>
            <TBody>
              {lists.data.map((list) => (
                <TR key={list.id}>
                  <TD className="pl-4 font-medium">{list.name}</TD>
                  <TD className="text-muted-foreground">{adjustLabel(list.adjust_percent)}</TD>
                  <TD className="text-right tabular-nums">{list.items_count ?? 0}</TD>
                  <TD className="text-right tabular-nums">{list.clients_count ?? 0}</TD>
                  <TD>{list.active ? <Badge variant="success">Ativa</Badge> : <Badge>Inativa</Badge>}</TD>
                  <TD className="pr-4">
                    <div className="flex justify-end gap-1">
                      <Button variant="ghost" size="sm" onClick={() => setPricing(list)}>
                        <Tags />
                        Preços
                      </Button>
                      <Button variant="ghost" size="sm" onClick={() => setEditing({ list })}>
                        <Pencil />
                        Editar
                      </Button>
                      <Button variant="destructive-ghost" size="icon" aria-label={`Excluir ${list.name}`} onClick={() => setDeleting(list)}>
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
      {editing && <PriceListDialog list={editing.list} onClose={() => setEditing(null)} />}
      {pricing && <PriceListItemsDialog list={pricing} onClose={() => setPricing(null)} />}
      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(open) => !open && setDeleting(null)}
        title={`Excluir a tabela ${deleting?.name}?`}
        description="Os clientes dela voltam ao preço do catálogo. Pedidos já lançados não mudam."
        confirmLabel="Excluir"
        destructive
        loading={remove.isPending}
        onConfirm={() => deleting && remove.mutate(deleting)}
      />
    </div>
  );
}
