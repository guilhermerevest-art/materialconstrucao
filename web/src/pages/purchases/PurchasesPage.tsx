import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, Search, ShoppingCart } from 'lucide-react';
import { useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { toast } from 'sonner';
import { SupplierFormDialog } from '@/components/purchases/SupplierFormDialog';
import { useSuppliers } from '@/components/purchases/SupplierSelect';
import { EmptyState, PageHeader, Pagination } from '@/components/shared';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Checkbox, Input, NativeSelect } from '@/components/ui/input';
import { Alert, Badge, Skeleton } from '@/components/ui/misc';
import { Table, TBody, TD, TH, THead, TR } from '@/components/ui/table';
import { useStoreOptions } from '@/pages/StockPage';
import { api, ApiError, toQuery } from '@/lib/api';
import { useUser } from '@/lib/auth';
import { formatDocument } from '@/lib/fiscal';
import { decimalToInput, formatDate, formatDay, formatMoney, formatQuantity, formatWhatsapp, parseDecimal } from '@/lib/format';
import { useDebouncedValue, useDocumentTitle } from '@/lib/hooks';
import { PURCHASE_STATUS, purchaseNumber } from '@/lib/purchases';
import type { Paginated, PurchaseOrder, PurchaseSuggestion, Store, Supplier } from '@/lib/types';
import { cn } from '@/lib/utils';

const PAGE_SIZE = 30;

const TABS = [
  { value: 'pedidos', label: 'Pedidos de compra' },
  { value: 'sugestao', label: 'O que comprar' },
  { value: 'fornecedores', label: 'Fornecedores' },
] as const;
type Tab = (typeof TABS)[number]['value'];

const STATUS_FILTERS = [
  { value: 'open', label: 'Em andamento' },
  { value: 'received', label: 'Recebidos' },
  { value: 'cancelled', label: 'Cancelados' },
  { value: 'all', label: 'Todos' },
] as const;

function OrdersTab() {
  const [status, setStatus] = useState<(typeof STATUS_FILTERS)[number]['value']>('open');
  const [supplierId, setSupplierId] = useState('');
  const [page, setPage] = useState(1);
  const suppliers = useSuppliers();
  const list = useQuery({
    queryKey: ['purchase-orders', 'list', status, supplierId, page],
    queryFn: () =>
      api<Paginated<PurchaseOrder>>(`/purchase-orders${toQuery({ status, supplier_id: supplierId, page, page_size: PAGE_SIZE })}`),
    placeholderData: keepPreviousData,
  });
  const data = list.data;
  return (
    <Card>
      <div className="flex flex-wrap items-end gap-3 border-b border-border p-4">
        <div className="flex flex-wrap rounded-md border border-input bg-background p-0.5" role="group" aria-label="Situação">
          {STATUS_FILTERS.map((f) => (
            <button
              key={f.value}
              onClick={() => {
                setStatus(f.value);
                setPage(1);
              }}
              aria-pressed={status === f.value}
              className={cn(
                'h-8 rounded px-3 text-sm font-medium whitespace-nowrap',
                status === f.value ? 'bg-card text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground',
              )}
            >
              {f.label}
            </button>
          ))}
        </div>
        <NativeSelect
          aria-label="Fornecedor"
          value={supplierId}
          onChange={(e) => {
            setSupplierId(e.target.value);
            setPage(1);
          }}
          className="w-full sm:w-56"
        >
          <option value="">Todos os fornecedores</option>
          {(suppliers.data ?? []).map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </NativeSelect>
      </div>
      {list.isPending ? (
        <Skeleton className="m-4 h-40" />
      ) : !data?.items.length ? (
        <EmptyState
          title="Nenhum pedido de compra"
          description={status === 'open' ? 'Monte um pedido em "O que comprar" ou em "Novo pedido de compra".' : undefined}
        />
      ) : (
        <>
          <Table>
            <THead>
              <TR>
                <TH className="pl-4">Nº</TH>
                <TH>Fornecedor</TH>
                <TH>Loja</TH>
                <TH>Pedido em</TH>
                <TH>Previsão</TH>
                <TH>Situação</TH>
                <TH className="pr-4 text-right">Valor</TH>
              </TR>
            </THead>
            <TBody className={cn(list.isPlaceholderData && 'opacity-60')}>
              {data.items.map((po) => (
                <TR key={po.id}>
                  <TD className="pl-4 font-semibold whitespace-nowrap tabular-nums">
                    <Link to={`/compras/${po.id}`} className="hover:underline">
                      {purchaseNumber(po.id)}
                    </Link>
                  </TD>
                  <TD className="font-medium">
                    <Link to={`/compras/${po.id}`} className="hover:underline">
                      {po.supplier_name}
                    </Link>
                    <span className="block text-xs font-normal text-muted-foreground">
                      {po.items_count} {po.items_count === 1 ? 'produto' : 'produtos'}
                    </span>
                  </TD>
                  <TD className="text-muted-foreground">{po.store_name}</TD>
                  <TD className="whitespace-nowrap text-muted-foreground tabular-nums">{formatDate(po.created_at)}</TD>
                  <TD className="whitespace-nowrap text-muted-foreground tabular-nums">{po.expected_date ? formatDay(po.expected_date) : '—'}</TD>
                  <TD>
                    <Badge variant={PURCHASE_STATUS[po.status].variant}>{PURCHASE_STATUS[po.status].label}</Badge>
                  </TD>
                  <TD className="pr-4 text-right font-semibold tabular-nums">{po.total_amount > 0 ? formatMoney(po.total_amount) : '—'}</TD>
                </TR>
              ))}
            </TBody>
          </Table>
          <Pagination page={page} pageSize={PAGE_SIZE} total={data.total} onPageChange={setPage} />
        </>
      )}
    </Card>
  );
}

type Line = { checked: boolean; qty: string; supplierId: string };

/**
 * Abaixo do mínimo, descontado o que já foi pedido. Cada produto vai para o último
 * fornecedor dele; o botão monta um rascunho de pedido por fornecedor.
 */
function SuggestionsTab({ stores }: { stores: Store[] }) {
  const user = useUser();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [storeId, setStoreId] = useState<number | null>(user.store_id);
  const [lines, setLines] = useState<Record<number, Line>>({});
  const [error, setError] = useState<string | null>(null);
  const suppliers = useSuppliers();
  const query = useQuery({
    queryKey: ['purchase-orders', 'suggestions', storeId],
    queryFn: () => api<{ store_id: number; items: PurchaseSuggestion[] }>(`/purchase-orders/suggestions${toQuery({ store_id: storeId })}`),
  });
  const currentStore = storeId ?? query.data?.store_id ?? null;
  const items = query.data?.items ?? [];
  // Com unidade de compra, a sugestão já vem em sacos inteiros.
  const line = (s: PurchaseSuggestion): Line =>
    lines[s.product_id] ?? {
      checked: true,
      qty: decimalToInput(s.suggested_purchase ?? s.suggested),
      supplierId: s.supplier_id ? String(s.supplier_id) : '',
    };
  const update = (s: PurchaseSuggestion, patch: Partial<Line>) => setLines((ls) => ({ ...ls, [s.product_id]: { ...line(s), ...patch } }));

  const create = useMutation({
    mutationFn: async (
      groups: { supplierId: number; items: { product_id: number; quantity: number; unit_cost: number | null; use_purchase_unit: boolean }[] }[],
    ) => {
      const ids: number[] = [];
      for (const group of groups) {
        const { purchase_order } = await api<{ purchase_order: { id: number } }>('/purchase-orders', {
          method: 'POST',
          body: { store_id: currentStore, supplier_id: group.supplierId, items: group.items },
        });
        ids.push(purchase_order.id);
      }
      return ids;
    },
    onSuccess: (ids) => {
      queryClient.invalidateQueries({ queryKey: ['purchase-orders'] });
      setLines({});
      if (ids.length === 1) {
        toast.success('Pedido de compra criado. Confira e mande ao fornecedor.');
        navigate(`/compras/${ids[0]}`);
      } else {
        toast.success(`${ids.length} pedidos de compra criados, um por fornecedor.`);
        navigate('/compras');
      }
    },
    onError: (err) => setError(err instanceof ApiError ? err.message : 'Não foi possível criar os pedidos.'),
  });

  function submit() {
    const groups = new Map<number, { product_id: number; quantity: number; unit_cost: number | null; use_purchase_unit: boolean }[]>();
    for (const s of items) {
      const l = line(s);
      if (!l.checked) continue;
      const qty = parseDecimal(l.qty);
      if (qty === null || qty <= 0) return setError(`Informe a quantidade de ${s.name}.`);
      if (!l.supplierId) return setError(`Escolha o fornecedor de ${s.name}.`);
      const group = groups.get(Number(l.supplierId)) ?? [];
      const factor = s.purchase_unit ? s.purchase_factor : null;
      group.push({
        product_id: s.product_id,
        quantity: qty,
        unit_cost: s.unit_cost !== null && factor ? Math.round(s.unit_cost * factor * 10_000) / 10_000 : s.unit_cost,
        use_purchase_unit: Boolean(factor),
      });
      groups.set(Number(l.supplierId), group);
    }
    if (!groups.size) return setError('Marque o que vai comprar.');
    setError(null);
    create.mutate([...groups].map(([supplierId, groupItems]) => ({ supplierId, items: groupItems })));
  }

  const checked = items.filter((s) => line(s).checked);
  const supplierCount = new Set(checked.map((s) => line(s).supplierId || 'x')).size;

  return (
    <Card>
      <div className="flex flex-wrap items-center gap-3 border-b border-border p-4">
        {stores.length > 1 && (
          <NativeSelect
            aria-label="Loja"
            value={currentStore ?? ''}
            onChange={(e) => {
              setStoreId(Number(e.target.value));
              setLines({});
            }}
            className="w-full sm:w-48"
          >
            {stores.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </NativeSelect>
        )}
        <p className="flex-1 text-sm text-muted-foreground">
          Produtos abaixo do estoque mínimo, já descontado o que foi pedido e ainda não chegou.
        </p>
      </div>
      {error && <Alert variant="danger" title={error} className="m-4" />}
      {query.isPending ? (
        <Skeleton className="m-4 h-40" />
      ) : !items.length ? (
        <EmptyState
          title="Nada para comprar"
          description="Nenhum produto abaixo do mínimo nesta loja. Defina o mínimo de cada produto em Estoque → Extrato e ajuste."
        />
      ) : (
        <>
          <Table>
            <THead>
              <TR>
                <TH className="w-10 pl-4">
                  <span className="sr-only">Comprar</span>
                </TH>
                <TH>Produto</TH>
                <TH className="text-right">Saldo</TH>
                <TH className="text-right">Mínimo</TH>
                <TH className="text-right">Já pedido</TH>
                <TH className="text-right">Comprar</TH>
                <TH className="pr-4">Fornecedor</TH>
              </TR>
            </THead>
            <TBody>
              {items.map((s) => {
                const l = line(s);
                return (
                  <TR key={s.product_id} className={cn(!l.checked && 'opacity-55')}>
                    <TD className="pl-4">
                      <Checkbox checked={l.checked} onChange={(e) => update(s, { checked: e.target.checked })} aria-label={`Comprar ${s.name}`} />
                    </TD>
                    <TD className="font-medium">
                      {s.name}
                      <span className="block text-xs font-normal text-muted-foreground tabular-nums">
                        {s.code ?? ''}
                        {s.unit_cost !== null && ` · último custo ${formatMoney(s.unit_cost)}`}
                      </span>
                    </TD>
                    <TD className={cn('text-right tabular-nums', s.quantity < 0 && 'font-semibold text-destructive')}>
                      {formatQuantity(s.quantity)} <span className="text-xs text-muted-foreground">{s.unit}</span>
                    </TD>
                    <TD className="text-right text-muted-foreground tabular-nums">{formatQuantity(s.min_quantity)}</TD>
                    <TD className="text-right text-muted-foreground tabular-nums">{s.on_order ? formatQuantity(s.on_order) : '—'}</TD>
                    <TD className="text-right">
                      <div className="flex items-center justify-end gap-1.5">
                        <Input
                          aria-label={`Quantidade de ${s.name}`}
                          inputMode="decimal"
                          value={l.qty}
                          onChange={(e) => update(s, { qty: e.target.value })}
                          className="h-9 w-20 text-right tabular-nums"
                        />
                        <span className="w-8 text-left text-xs text-muted-foreground">{s.purchase_unit ?? s.unit}</span>
                      </div>
                      {s.purchase_unit && s.purchase_factor && (
                        <span className="block text-[11px] text-muted-foreground tabular-nums">
                          {formatQuantity(s.purchase_factor)} {s.unit} cada
                        </span>
                      )}
                    </TD>
                    <TD className="pr-4">
                      <NativeSelect
                        aria-label={`Fornecedor de ${s.name}`}
                        value={l.supplierId}
                        onChange={(e) => update(s, { supplierId: e.target.value })}
                        className={cn('h-9 w-full min-w-40', l.checked && !l.supplierId && 'border-destructive')}
                      >
                        <option value="">Escolha</option>
                        {(suppliers.data ?? []).map((sp) => (
                          <option key={sp.id} value={sp.id}>
                            {sp.name}
                          </option>
                        ))}
                      </NativeSelect>
                    </TD>
                  </TR>
                );
              })}
            </TBody>
          </Table>
          <div className="flex flex-wrap items-center justify-end gap-3 border-t border-border p-4">
            <span className="text-sm text-muted-foreground">
              {checked.length} {checked.length === 1 ? 'produto' : 'produtos'}
              {checked.length > 0 && ` · ${supplierCount} ${supplierCount === 1 ? 'pedido' : 'pedidos'}`}
            </span>
            <Button onClick={submit} loading={create.isPending} disabled={!checked.length}>
              <ShoppingCart />
              Montar pedido de compra
            </Button>
          </div>
        </>
      )}
    </Card>
  );
}

function SuppliersTab() {
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const [editing, setEditing] = useState<Supplier | null | 'new'>(null);
  const q = useDebouncedValue(search.trim(), 300);
  const list = useQuery({
    queryKey: ['suppliers', 'list', q, page],
    queryFn: () => api<Paginated<Supplier>>(`/suppliers${toQuery({ q, status: 'all', page, page_size: PAGE_SIZE })}`),
    placeholderData: keepPreviousData,
  });
  const data = list.data;
  return (
    <Card>
      <div className="flex flex-wrap items-end gap-3 border-b border-border p-4">
        <div className="relative w-full sm:min-w-56 sm:flex-1">
          <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            aria-label="Buscar fornecedor"
            placeholder="Nome, contato ou CNPJ"
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
              setPage(1);
            }}
            className="w-full pl-9"
          />
        </div>
        <Button variant="outline" onClick={() => setEditing('new')}>
          <Plus />
          Novo fornecedor
        </Button>
      </div>
      {list.isPending ? (
        <Skeleton className="m-4 h-40" />
      ) : !data?.items.length ? (
        <EmptyState title="Nenhum fornecedor" description="A nota de compra cadastra o fornecedor pelo CNPJ. Você também pode cadastrar à mão." />
      ) : (
        <>
          <Table>
            <THead>
              <TR>
                <TH className="pl-4">Fornecedor</TH>
                <TH>Contato</TH>
                <TH>Última nota</TH>
                <TH className="text-right">Pedidos abertos</TH>
                <TH className="pr-4 text-right">A pagar</TH>
              </TR>
            </THead>
            <TBody className={cn(list.isPlaceholderData && 'opacity-60')}>
              {data.items.map((s) => (
                <TR key={s.id} className="cursor-pointer hover:bg-muted/50" onClick={() => setEditing(s)}>
                  <TD className="pl-4 font-medium">
                    {s.name}
                    {!s.active && <Badge className="ml-2">Inativo</Badge>}
                    {s.document && <span className="block text-xs font-normal text-muted-foreground tabular-nums">{formatDocument(s.document)}</span>}
                  </TD>
                  <TD className="text-muted-foreground">
                    {s.contact_name ?? '—'}
                    {s.whatsapp && <span className="block text-xs tabular-nums">{formatWhatsapp(s.whatsapp)}</span>}
                  </TD>
                  <TD className="whitespace-nowrap text-muted-foreground tabular-nums">{s.last_entry_at ? formatDate(s.last_entry_at) : '—'}</TD>
                  <TD className="text-right tabular-nums">{s.open_orders || '—'}</TD>
                  <TD className="pr-4 text-right font-semibold tabular-nums">{s.open_payables ? formatMoney(s.open_payables) : '—'}</TD>
                </TR>
              ))}
            </TBody>
          </Table>
          <Pagination page={page} pageSize={PAGE_SIZE} total={data.total} onPageChange={setPage} />
        </>
      )}
      <SupplierFormDialog
        open={editing !== null}
        onOpenChange={(open) => !open && setEditing(null)}
        supplier={editing === 'new' ? null : editing}
      />
    </Card>
  );
}

export function PurchasesPage() {
  useDocumentTitle('Compras');
  const [params, setParams] = useSearchParams();
  const tab: Tab = TABS.some((t) => t.value === params.get('aba')) ? (params.get('aba') as Tab) : 'pedidos';
  const stores = useStoreOptions(true);
  return (
    <div>
      <PageHeader
        title="Compras"
        description="Pedido de compra ao fornecedor e o recebimento pela entrada de nota."
        actions={
          <Button asChild>
            <Link to="/compras/novo">
              <Plus />
              Novo pedido de compra
            </Link>
          </Button>
        }
      />
      <div className="mb-4 flex overflow-x-auto rounded-md border border-input bg-background p-0.5 sm:inline-flex" role="tablist">
        {TABS.map((t) => (
          <button
            key={t.value}
            role="tab"
            aria-selected={tab === t.value}
            onClick={() => setParams(t.value === 'pedidos' ? {} : { aba: t.value })}
            className={cn(
              'h-8 flex-1 rounded px-4 text-sm font-medium whitespace-nowrap',
              tab === t.value ? 'bg-card text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground',
            )}
          >
            {t.label}
          </button>
        ))}
      </div>
      {tab === 'pedidos' && <OrdersTab />}
      {tab === 'sugestao' && <SuggestionsTab stores={stores.data ?? []} />}
      {tab === 'fornecedores' && <SuppliersTab />}
    </div>
  );
}
