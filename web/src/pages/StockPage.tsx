import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeftRight, FileInput, History, Plus, Search, Trash2 } from 'lucide-react';
import { useEffect, useState, type FormEvent } from 'react';
import { Link, useSearchParams } from 'react-router';
import { toast } from 'sonner';
import { ProductPicker, type PickedProduct } from '@/components/ProductPicker';
import { EmptyState, PageHeader, Pagination } from '@/components/shared';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Checkbox, Field, Input, Label, NativeSelect } from '@/components/ui/input';
import { Alert, Badge, Skeleton } from '@/components/ui/misc';
import { Table, TBody, TD, TH, THead, TR } from '@/components/ui/table';
import { api, ApiError, toQuery } from '@/lib/api';
import { useUser } from '@/lib/auth';
import { decimalToInput, formatDate, formatDateTime, formatMoney, formatOrderNumber, formatQuantity, parseDecimal } from '@/lib/format';
import { useDebouncedValue, useDocumentTitle } from '@/lib/hooks';
import type { Paginated, ProductStock, StockEntry, StockItem, StockList, StockMovementKind, Store } from '@/lib/types';
import { cn } from '@/lib/utils';

const PAGE_SIZE = 30;

const KIND_LABEL: Record<StockMovementKind, string> = {
  entry: 'Entrada',
  sale: 'Venda',
  sale_cancel: 'Cancelamento',
  adjustment: 'Ajuste',
  transfer_out: 'Transferência enviada',
  transfer_in: 'Transferência recebida',
};

const errorMessage = (err: unknown, fallback: string) => (err instanceof ApiError ? err.message : fallback);

/** Lojas para escolher. /stores é do administrador: o vendedor fica na própria loja (e vê as outras no extrato). */
export function useStoreOptions(enabled: boolean) {
  return useQuery({
    queryKey: ['stores'],
    queryFn: () => api<{ items: Store[] }>('/stores').then((r) => r.items),
    enabled,
  });
}

function QuantityText({ value, unit, className }: { value: number; unit?: string; className?: string }) {
  return (
    <span className={cn('tabular-nums', value < 0 && 'font-semibold text-destructive', className)}>
      {formatQuantity(value)}
      {unit && <span className="ml-1 text-xs font-normal text-muted-foreground">{unit}</span>}
    </span>
  );
}

/** Saldo do produto nas lojas, extrato e, para o admin, contagem, acerto e mínimo. */
function ProductStockDialog({
  productId,
  storeId,
  onClose,
}: {
  productId: number;
  storeId: number;
  onClose: () => void;
}) {
  const user = useUser();
  const isAdmin = user.role === 'admin';
  const queryClient = useQueryClient();
  const [mode, setMode] = useState<'count' | 'delta'>('count');
  const [qtyText, setQtyText] = useState('');
  const [note, setNote] = useState('');
  const [minText, setMinText] = useState('');
  const [error, setError] = useState<string | null>(null);

  const query = useQuery({
    queryKey: ['stock', 'product', productId, storeId],
    queryFn: () => api<ProductStock>(`/stock/products/${productId}${toQuery({ store_id: storeId })}`),
  });
  const data = query.data;
  const here = data?.balances.find((b) => b.store_id === storeId);

  useEffect(() => {
    if (here) setMinText(here.min_quantity != null ? decimalToInput(here.min_quantity) : '');
  }, [here?.min_quantity]); // eslint-disable-line react-hooks/exhaustive-deps

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ['stock'] });
    queryClient.invalidateQueries({ queryKey: ['products'] });
  };

  const adjust = useMutation({
    mutationFn: (quantity: number) =>
      api('/stock/adjustments', {
        method: 'POST',
        body: { store_id: storeId, note: note || null, items: [{ product_id: productId, mode, quantity }] },
      }),
    onSuccess: () => {
      invalidate();
      setQtyText('');
      setNote('');
      toast.success('Estoque ajustado.');
    },
    onError: (err) => setError(errorMessage(err, 'Não foi possível ajustar.')),
  });

  const saveMin = useMutation({
    mutationFn: (minQuantity: number | null) =>
      api(`/stock/products/${productId}/min`, { method: 'PUT', body: { store_id: storeId, min_quantity: minQuantity } }),
    onSuccess: () => {
      invalidate();
      toast.success('Estoque mínimo salvo.');
    },
    onError: (err) => setError(errorMessage(err, 'Não foi possível salvar o mínimo.')),
  });

  const tracking = useMutation({
    mutationFn: (track: boolean) => api(`/stock/products/${productId}/tracking`, { method: 'PUT', body: { track_stock: track } }),
    onSuccess: () => invalidate(),
    onError: (err) => setError(errorMessage(err, 'Não foi possível alterar.')),
  });

  function submitAdjust(event: FormEvent) {
    event.preventDefault();
    const text = qtyText.trim();
    const negative = mode === 'delta' && text.startsWith('-');
    const value = parseDecimal(negative ? text.slice(1) : text);
    if (value === null) return setError(mode === 'count' ? 'Digite a quantidade contada.' : 'Digite quanto somar (ou -quanto tirar).');
    setError(null);
    adjust.mutate(negative ? -value : value);
  }

  function submitMin(event: FormEvent) {
    event.preventDefault();
    if (!minText.trim()) return saveMin.mutate(null);
    const value = parseDecimal(minText);
    if (value === null) return setError('Digite o estoque mínimo.');
    setError(null);
    saveMin.mutate(value);
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>{data?.product.name ?? 'Estoque do produto'}</DialogTitle>
          <DialogDescription>
            {data?.product.code ? `Código ${data.product.code} · ` : ''}
            {data?.product.cost_price != null ? `Último custo ${formatMoney(data.product.cost_price)} · ` : ''}
            Preço {data ? formatMoney(data.product.price) : '-'}
          </DialogDescription>
        </DialogHeader>
        {!data ? (
          <Skeleton className="h-48" />
        ) : (
          <div className="grid max-h-[70dvh] gap-5 overflow-y-auto pr-1">
            {error && <Alert variant="danger" title={error} />}
            {!data.product.track_stock && (
              <Alert variant="info" title="Este produto não controla estoque (frete, serviço...). A venda não baixa nada." />
            )}
            <div className="flex flex-wrap gap-2">
              {data.balances.map((b) => (
                <div
                  key={b.store_id}
                  className={cn('rounded-md border px-3 py-2', b.store_id === storeId ? 'border-primary bg-primary-soft' : 'border-border')}
                >
                  <p className="text-[13px] text-muted-foreground">{b.store_name}</p>
                  <QuantityText value={b.quantity} unit={data.product.unit} className="text-lg font-semibold" />
                </div>
              ))}
            </div>

            {isAdmin && data.product.track_stock && (
              <div className="grid gap-3 rounded-md border border-border p-3">
                <form onSubmit={submitAdjust} className="flex flex-wrap items-end gap-2">
                  <div className="grid gap-1.5">
                    <Label htmlFor="ajuste-modo">Ajuste</Label>
                    <NativeSelect id="ajuste-modo" value={mode} onChange={(e) => setMode(e.target.value as 'count' | 'delta')} className="w-44">
                      <option value="count">Contei, o saldo é</option>
                      <option value="delta">Somar / tirar</option>
                    </NativeSelect>
                  </div>
                  <div className="grid gap-1.5">
                    <Label htmlFor="ajuste-qtd">Quantidade</Label>
                    <Input
                      id="ajuste-qtd"
                      inputMode="decimal"
                      value={qtyText}
                      onChange={(e) => setQtyText(e.target.value)}
                      className="w-28"
                      placeholder={mode === 'count' ? '0' : '-2 ou 5'}
                    />
                  </div>
                  <div className="grid min-w-40 flex-1 gap-1.5">
                    <Label htmlFor="ajuste-motivo">Motivo</Label>
                    <Input id="ajuste-motivo" value={note} onChange={(e) => setNote(e.target.value)} maxLength={200} placeholder="Ex.: quebra, inventário" />
                  </div>
                  <Button type="submit" variant="steel" loading={adjust.isPending}>
                    Ajustar
                  </Button>
                </form>
                <form onSubmit={submitMin} className="flex flex-wrap items-end gap-2">
                  <div className="grid gap-1.5">
                    <Label htmlFor="ajuste-minimo">Estoque mínimo nesta loja</Label>
                    <Input
                      id="ajuste-minimo"
                      inputMode="decimal"
                      value={minText}
                      onChange={(e) => setMinText(e.target.value)}
                      className="w-44"
                      placeholder="Sem mínimo"
                    />
                  </div>
                  <Button type="submit" variant="outline" loading={saveMin.isPending}>
                    Salvar mínimo
                  </Button>
                </form>
              </div>
            )}
            {isAdmin && (
              <label className="flex items-center gap-2 text-sm">
                <Checkbox
                  checked={!data.product.track_stock}
                  onChange={(e) => tracking.mutate(!e.target.checked)}
                  disabled={tracking.isPending}
                />
                Não controlar o estoque deste produto (frete, serviço, mão de obra)
              </label>
            )}

            <div>
              <h3 className="mb-2 text-sm font-semibold">Extrato nesta loja</h3>
              {!data.movements.length ? (
                <p className="text-sm text-muted-foreground">Nenhum movimento ainda.</p>
              ) : (
                <ul className="divide-y divide-border rounded-md border border-border text-sm">
                  {data.movements.map((m) => (
                    <li key={m.id} className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-3 gap-y-0.5 px-3 py-2">
                      <span className="font-medium">
                        {KIND_LABEL[m.kind]}
                        {m.order_id && (
                          <Link to={`/pedidos/${m.order_id}`} className="ml-1.5 font-normal text-primary hover:underline">
                            pedido {formatOrderNumber(m.order_id)}
                          </Link>
                        )}
                        {m.other_store_name && <span className="font-normal text-muted-foreground"> · {m.other_store_name}</span>}
                      </span>
                      <span className={cn('text-right font-semibold tabular-nums', m.quantity > 0 ? 'text-success' : 'text-destructive')}>
                        {m.quantity > 0 ? '+' : ''}
                        {formatQuantity(m.quantity)}
                      </span>
                      <span className="text-[13px] text-muted-foreground">
                        {formatDateTime(m.created_at)} · {m.user_name}
                        {m.note ? ` · ${m.note}` : ''}
                      </span>
                      <span className="text-right text-[13px] text-muted-foreground tabular-nums">saldo {formatQuantity(m.balance_after)}</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

type TransferRow = { key: number; product: PickedProduct | null; qty: string };

function TransferDialog({ stores, fromStoreId, onClose }: { stores: Store[]; fromStoreId: number; onClose: () => void }) {
  const queryClient = useQueryClient();
  const [from, setFrom] = useState(String(fromStoreId));
  const [to, setTo] = useState(String(stores.find((s) => s.id !== fromStoreId)?.id ?? ''));
  const [note, setNote] = useState('');
  const [rows, setRows] = useState<TransferRow[]>([{ key: 1, product: null, qty: '' }]);
  const [error, setError] = useState<string | null>(null);

  const transfer = useMutation({
    mutationFn: (items: { product_id: number; quantity: number }[]) =>
      api('/stock/transfers', {
        method: 'POST',
        body: { from_store_id: Number(from), to_store_id: Number(to), note: note || null, items },
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['stock'] });
      toast.success('Transferência registrada.');
      onClose();
    },
    onError: (err) => setError(errorMessage(err, 'Não foi possível transferir.')),
  });

  function submit(event: FormEvent) {
    event.preventDefault();
    const filled = rows.filter((r) => r.product || r.qty.trim());
    if (!filled.length) return setError('Escolha pelo menos um produto.');
    const items = [];
    for (const row of filled) {
      const quantity = parseDecimal(row.qty);
      if (!row.product) return setError('Escolha o produto de cada linha.');
      if (!quantity) return setError(`Informe a quantidade de ${row.product.name}.`);
      items.push({ product_id: row.product.id, quantity });
    }
    setError(null);
    transfer.mutate(items);
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Transferir entre lojas</DialogTitle>
          <DialogDescription>Sai do estoque de uma loja e entra no da outra, no mesmo momento.</DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="grid gap-4">
          {error && <Alert variant="danger" title={error} />}
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Sai de" htmlFor="transf-de">
              <NativeSelect id="transf-de" value={from} onChange={(e) => setFrom(e.target.value)}>
                {stores.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </NativeSelect>
            </Field>
            <Field label="Entra em" htmlFor="transf-para">
              <NativeSelect id="transf-para" value={to} onChange={(e) => setTo(e.target.value)}>
                {stores
                  .filter((s) => String(s.id) !== from)
                  .map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                    </option>
                  ))}
              </NativeSelect>
            </Field>
          </div>
          <div className="grid gap-2">
            {rows.map((row) => (
              <div key={row.key} className="flex items-center gap-2">
                <ProductPicker
                  className="flex-1"
                  value={row.product}
                  onChange={(product) => setRows((rs) => rs.map((r) => (r.key === row.key ? { ...r, product } : r)))}
                />
                <Input
                  aria-label="Quantidade"
                  inputMode="decimal"
                  className="w-24"
                  placeholder="Qtd."
                  value={row.qty}
                  onChange={(e) => setRows((rs) => rs.map((r) => (r.key === row.key ? { ...r, qty: e.target.value } : r)))}
                />
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="size-9"
                  disabled={rows.length === 1}
                  onClick={() => setRows((rs) => rs.filter((r) => r.key !== row.key))}
                  aria-label="Remover linha"
                >
                  <Trash2 />
                </Button>
              </div>
            ))}
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="justify-self-start"
              onClick={() => setRows((rs) => [...rs, { key: Math.max(...rs.map((r) => r.key)) + 1, product: null, qty: '' }])}
            >
              <Plus />
              Outro produto
            </Button>
          </div>
          <Field label="Observação (opcional)" htmlFor="transf-obs">
            <Input id="transf-obs" value={note} onChange={(e) => setNote(e.target.value)} maxLength={200} />
          </Field>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              Cancelar
            </Button>
            <Button type="submit" loading={transfer.isPending}>
              Transferir
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function EntriesTab({ storeId }: { storeId: number | null }) {
  const [page, setPage] = useState(1);
  const entries = useQuery({
    queryKey: ['stock', 'entries', storeId, page],
    queryFn: () => api<Paginated<StockEntry>>(`/stock/entries${toQuery({ store_id: storeId, page, page_size: PAGE_SIZE })}`),
    placeholderData: keepPreviousData,
  });
  if (entries.isPending) return <Skeleton className="m-4 h-40" />;
  if (!entries.data?.items.length) {
    return <EmptyState title="Nenhuma entrada ainda" description="As notas de compra lançadas aparecem aqui." />;
  }
  return (
    <>
      <Table>
        <THead>
          <TR>
            <TH className="pl-4">Nº</TH>
            <TH>Data</TH>
            <TH>Fornecedor</TH>
            <TH>Nota</TH>
            <TH>Loja</TH>
            <TH className="text-right">Itens</TH>
            <TH className="pr-4 text-right">Valor</TH>
          </TR>
        </THead>
        <TBody>
          {entries.data.items.map((e) => (
            <TR key={e.id}>
              <TD className="pl-4 font-semibold tabular-nums">{e.id}</TD>
              <TD className="whitespace-nowrap text-muted-foreground tabular-nums">{formatDateTime(e.created_at)}</TD>
              <TD className="font-medium">{e.supplier_name ?? 'Lançamento manual'}</TD>
              <TD className="text-muted-foreground tabular-nums">
                {e.invoice_number ? `${e.invoice_number}${e.invoice_series ? `/${e.invoice_series}` : ''}` : '—'}
                {e.issued_at && <span className="block text-xs">emitida {formatDate(e.issued_at)}</span>}
              </TD>
              <TD className="text-muted-foreground">{e.store_name}</TD>
              <TD className="text-right tabular-nums">{e.items_count}</TD>
              <TD className="pr-4 text-right font-semibold tabular-nums">{formatMoney(e.total_amount)}</TD>
            </TR>
          ))}
        </TBody>
      </Table>
      <Pagination page={page} pageSize={PAGE_SIZE} total={entries.data.total} onPageChange={setPage} />
    </>
  );
}

export function StockPage() {
  useDocumentTitle('Estoque');
  const user = useUser();
  const isAdmin = user.role === 'admin';
  const [params, setParams] = useSearchParams();
  const tab = params.get('aba') === 'entradas' ? 'entradas' : 'saldos';
  const [storeId, setStoreId] = useState<number | null>(user.store_id);
  const [filter, setFilter] = useState<'all' | 'below_min' | 'negative'>('all');
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const [detail, setDetail] = useState<number | null>(null);
  const [transferOpen, setTransferOpen] = useState(false);
  const q = useDebouncedValue(search.trim(), 300);
  const stores = useStoreOptions(isAdmin);

  const list = useQuery({
    queryKey: ['stock', 'list', storeId, filter, q, page],
    queryFn: () => api<StockList>(`/stock${toQuery({ store_id: storeId, filter, q, page, page_size: PAGE_SIZE })}`),
    placeholderData: keepPreviousData,
  });
  // Sem loja escolhida, o servidor decide (a primeira); a tela passa a mostrar qual.
  const currentStore = storeId ?? list.data?.store_id ?? null;
  const storeOptions = stores.data ?? (user.store_id ? [{ id: user.store_id, name: user.store_name ?? 'Minha loja' } as Store] : []);

  const filters = [
    { value: 'all' as const, label: 'Todos' },
    { value: 'below_min' as const, label: `Abaixo do mínimo${list.data?.summary.below_min ? ` (${list.data.summary.below_min})` : ''}` },
    { value: 'negative' as const, label: `Negativos${list.data?.summary.negative ? ` (${list.data.summary.negative})` : ''}` },
  ];

  return (
    <div>
      <PageHeader
        title="Estoque"
        description="Saldo de cada loja. A venda baixa quando o pedido é confirmado; o cancelamento devolve."
        actions={
          isAdmin && (
            <>
              <Button variant="outline" onClick={() => setTransferOpen(true)} disabled={(stores.data?.length ?? 0) < 2}>
                <ArrowLeftRight />
                Transferir
              </Button>
              <Button asChild>
                <Link to={`/estoque/entrada${toQuery({ loja: currentStore })}`}>
                  <FileInput />
                  Entrada de nota
                </Link>
              </Button>
            </>
          )
        }
      />

      <div className="mb-4 flex rounded-md border border-input bg-background p-0.5 sm:inline-flex" role="tablist">
        {(['saldos', 'entradas'] as const).map((value) => (
          <button
            key={value}
            role="tab"
            aria-selected={tab === value}
            onClick={() => setParams(value === 'saldos' ? {} : { aba: value })}
            className={cn(
              'h-8 flex-1 rounded px-4 text-sm font-medium whitespace-nowrap',
              tab === value ? 'bg-card text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground',
            )}
          >
            {value === 'saldos' ? 'Saldos' : 'Entradas de nota'}
          </button>
        ))}
      </div>

      <Card>
        <div className="flex flex-wrap items-end gap-3 border-b border-border p-4">
          {storeOptions.length > 1 && (
            <NativeSelect
              aria-label="Loja"
              value={currentStore ?? ''}
              onChange={(e) => {
                setStoreId(Number(e.target.value));
                setPage(1);
              }}
              className="w-full sm:w-48"
            >
              {storeOptions.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </NativeSelect>
          )}
          {tab === 'saldos' && (
            <>
              <div className="relative w-full sm:min-w-56 sm:flex-1">
                <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
                <Input
                  aria-label="Buscar produto"
                  placeholder="Produto ou código"
                  value={search}
                  onChange={(e) => {
                    setSearch(e.target.value);
                    setPage(1);
                  }}
                  className="w-full pl-9"
                />
              </div>
              <div className="flex flex-wrap gap-1" role="group" aria-label="Filtro">
                {filters.map((f) => (
                  <Button
                    key={f.value}
                    size="sm"
                    variant={filter === f.value ? 'steel' : 'outline'}
                    aria-pressed={filter === f.value}
                    onClick={() => {
                      setFilter(f.value);
                      setPage(1);
                    }}
                  >
                    {f.label}
                  </Button>
                ))}
              </div>
            </>
          )}
        </div>

        {tab === 'entradas' ? (
          <EntriesTab storeId={storeId} />
        ) : list.isPending ? (
          <div className="grid gap-2 p-4">
            {Array.from({ length: 6 }, (_, i) => (
              <Skeleton key={i} className="h-10" />
            ))}
          </div>
        ) : !list.data?.items.length ? (
          <EmptyState
            title={filter === 'all' ? 'Nenhum produto encontrado' : 'Nada por aqui'}
            description={filter === 'below_min' ? 'Nenhum produto abaixo do mínimo nesta loja.' : undefined}
          />
        ) : (
          <>
            <Table>
              <THead>
                <TR>
                  <TH className="pl-4">Código</TH>
                  <TH>Produto</TH>
                  <TH className="text-right">Saldo</TH>
                  <TH className="text-right" title="Vendido e ainda não entregue: continua na prateleira">
                    A entregar
                  </TH>
                  <TH className="text-right">Mínimo</TH>
                  <TH className="text-right">Último custo</TH>
                  <TH className="pr-4">
                    <span className="sr-only">Ações</span>
                  </TH>
                </TR>
              </THead>
              <TBody className={cn(list.isPlaceholderData && 'opacity-60')}>
                {list.data.items.map((item) => {
                  const below = item.min_quantity != null && item.quantity < item.min_quantity;
                  return (
                    <TR key={item.id} className="cursor-pointer hover:bg-muted/50" onClick={() => setDetail(item.id)}>
                      <TD className="pl-4 text-muted-foreground tabular-nums">{item.code ?? '-'}</TD>
                      <TD className="font-medium">
                        {item.name}
                        {!item.track_stock && <Badge className="ml-2">Não controla</Badge>}
                        {item.track_stock && below && (
                          <Badge variant="warning" className="ml-2">
                            Comprar
                          </Badge>
                        )}
                      </TD>
                      <TD className="text-right">
                        {item.track_stock ? <QuantityText value={item.quantity} unit={item.unit} /> : <span className="text-muted-foreground">—</span>}
                      </TD>
                      <TD className="text-right text-muted-foreground tabular-nums">
                        {item.to_deliver ? formatQuantity(item.to_deliver) : '—'}
                      </TD>
                      <TD className="text-right text-muted-foreground tabular-nums">
                        {item.min_quantity != null ? formatQuantity(item.min_quantity) : '—'}
                      </TD>
                      <TD className="text-right text-muted-foreground tabular-nums">
                        {item.cost_price != null ? formatMoney(item.cost_price) : '—'}
                      </TD>
                      <TD className="pr-4">
                        <div className="flex justify-end">
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={(e) => {
                              e.stopPropagation();
                              setDetail(item.id);
                            }}
                          >
                            <History />
                            {isAdmin ? 'Extrato e ajuste' : 'Extrato'}
                          </Button>
                        </div>
                      </TD>
                    </TR>
                  );
                })}
              </TBody>
            </Table>
            <Pagination page={page} pageSize={PAGE_SIZE} total={list.data.total} onPageChange={setPage} />
          </>
        )}
      </Card>

      {detail !== null && currentStore !== null && (
        <ProductStockDialog productId={detail} storeId={currentStore} onClose={() => setDetail(null)} />
      )}
      {transferOpen && currentStore !== null && stores.data && (
        <TransferDialog stores={stores.data} fromStoreId={currentStore} onClose={() => setTransferOpen(false)} />
      )}
    </div>
  );
}
