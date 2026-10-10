import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, Plus, Trash2 } from 'lucide-react';
import { useEffect, useState, type FormEvent } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { toast } from 'sonner';
import { ProductPicker, type PickedProduct } from '@/components/ProductPicker';
import { SupplierSelect } from '@/components/purchases/SupplierSelect';
import { PageHeader } from '@/components/shared';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Field, Input, NativeSelect, Textarea } from '@/components/ui/input';
import { Alert, Skeleton } from '@/components/ui/misc';
import { useStoreOptions } from '@/pages/StockPage';
import { api, ApiError } from '@/lib/api';
import { useUser } from '@/lib/auth';
import { decimalToInput, formatMoney, moneyToInput, parseDecimal } from '@/lib/format';
import { useDocumentTitle } from '@/lib/hooks';
import { purchaseNumber } from '@/lib/purchases';
import type { ProductStock, PurchaseOrderDetail } from '@/lib/types';

/** Linha do pedido. Com a unidade de compra (sacos), quantidade e custo estão em sacos. */
type Row = { key: number; product: PickedProduct | null; qty: string; cost: string; inPurchaseUnit: boolean };

const emptyRow = (key: number): Row => ({ key, product: null, qty: '', cost: '', inPurchaseUnit: false });

const round = (value: number, places: number) => Math.round(value * 10 ** places) / 10 ** places;

/** Novo pedido de compra ou edição de um que ainda não começou a chegar. */
export function PurchaseOrderEditorPage() {
  const { id } = useParams();
  const editingId = id ? Number(id) : null;
  useDocumentTitle(editingId ? 'Editar pedido de compra' : 'Novo pedido de compra');
  const user = useUser();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const stores = useStoreOptions(true);
  const [storeId, setStoreId] = useState(user.store_id ? String(user.store_id) : '');
  const [supplierId, setSupplierId] = useState<number | null>(null);
  const [expected, setExpected] = useState('');
  const [notes, setNotes] = useState('');
  const [rows, setRows] = useState<Row[]>([emptyRow(1)]);
  const [error, setError] = useState<string | null>(null);

  const existing = useQuery({
    queryKey: ['purchase-orders', 'detail', editingId],
    queryFn: () => api<{ purchase_order: PurchaseOrderDetail }>(`/purchase-orders/${editingId}`).then((r) => r.purchase_order),
    enabled: editingId !== null,
  });

  useEffect(() => {
    const po = existing.data;
    if (!po) return;
    setStoreId(String(po.store_id));
    setSupplierId(po.supplier_id);
    setExpected(po.expected_date ?? '');
    setNotes(po.notes ?? '');
    setRows(
      po.items.map((item, index) => {
        const factor = item.purchase_unit ? item.purchase_factor : null;
        return {
          key: index + 1,
          product: {
            id: item.product_id,
            code: item.code,
            name: item.product_name,
            unit: item.unit,
            purchase_unit: item.purchase_unit,
            purchase_factor: item.purchase_factor,
          },
          qty: decimalToInput(factor ? round(item.quantity / factor, 3) : item.quantity),
          cost: item.unit_cost !== null ? moneyToInput(factor ? item.unit_cost * factor : item.unit_cost) : '',
          inPurchaseUnit: Boolean(factor),
        };
      }),
    );
  }, [existing.data]);

  const currentStore = storeId || (stores.data?.[0] ? String(stores.data[0].id) : '');
  const update = (key: number, patch: Partial<Row>) => setRows((rs) => rs.map((r) => (r.key === key ? { ...r, ...patch } : r)));

  /**
   * Ao escolher o produto, o pedido já vai na unidade de compra dele (sacos), e o custo
   * vem do último custo de compra (convertido para o saco).
   */
  async function pickProduct(key: number, product: PickedProduct | null) {
    const inPurchaseUnit = Boolean(product?.purchase_unit && product.purchase_factor);
    update(key, { product, cost: '', inPurchaseUnit });
    if (!product) return;
    try {
      const data = await api<ProductStock>(`/stock/products/${product.id}`);
      const cost = data.product.cost_price;
      if (cost != null) update(key, { cost: moneyToInput(inPurchaseUnit ? cost * product.purchase_factor! : cost) });
    } catch {
      // Sem custo conhecido o campo fica vazio.
    }
  }

  /** Troca entre a unidade de venda e a de compra, convertendo o que já foi digitado. */
  function switchUnit(row: Row, inPurchaseUnit: boolean) {
    const factor = row.product?.purchase_factor;
    if (!factor || inPurchaseUnit === row.inPurchaseUnit) return;
    const qty = parseDecimal(row.qty);
    const cost = parseDecimal(row.cost);
    update(row.key, {
      inPurchaseUnit,
      qty: qty === null ? row.qty : decimalToInput(round(inPurchaseUnit ? qty / factor : qty * factor, 3)),
      cost: cost === null ? row.cost : moneyToInput(inPurchaseUnit ? cost * factor : cost / factor),
    });
  }

  const total = rows.reduce((sum, r) => sum + (parseDecimal(r.qty) ?? 0) * (parseDecimal(r.cost) ?? 0), 0);

  const save = useMutation({
    mutationFn: (items: { product_id: number; quantity: number; unit_cost: number | null; use_purchase_unit: boolean }[]) => {
      const body = { store_id: Number(currentStore), supplier_id: supplierId, expected_date: expected || null, notes: notes || null, items };
      return editingId
        ? api<{ purchase_order: { id: number } }>(`/purchase-orders/${editingId}`, { method: 'PUT', body })
        : api<{ purchase_order: { id: number } }>('/purchase-orders', { method: 'POST', body });
    },
    onSuccess: ({ purchase_order }) => {
      queryClient.invalidateQueries({ queryKey: ['purchase-orders'] });
      toast.success(editingId ? 'Pedido de compra atualizado.' : 'Pedido de compra criado. Agora mande ao fornecedor.');
      navigate(`/compras/${purchase_order.id}`);
    },
    onError: (err) => setError(err instanceof ApiError ? err.message : 'Não foi possível salvar o pedido.'),
  });

  function submit(event: FormEvent) {
    event.preventDefault();
    if (!currentStore) return setError('Escolha a loja.');
    if (!supplierId) return setError('Escolha o fornecedor.');
    const filled = rows.filter((r) => r.product || r.qty.trim());
    if (!filled.length) return setError('Inclua pelo menos um produto.');
    const items = [];
    for (const row of filled) {
      if (!row.product) return setError('Escolha o produto de cada linha (ou remova a linha).');
      const quantity = parseDecimal(row.qty);
      if (quantity === null || quantity <= 0) return setError(`Informe a quantidade de ${row.product.name}.`);
      const cost = row.cost.trim() ? parseDecimal(row.cost) : null;
      if (row.cost.trim() && (cost === null || cost < 0)) return setError(`Custo inválido para ${row.product.name}.`);
      items.push({ product_id: row.product.id, quantity, unit_cost: cost, use_purchase_unit: row.inPurchaseUnit });
    }
    setError(null);
    save.mutate(items);
  }

  if (editingId && existing.isPending) return <Skeleton className="h-64" />;
  if (existing.data && !['draft', 'sent'].includes(existing.data.status)) {
    return <Alert variant="danger" title="Este pedido de compra já começou a chegar (ou foi encerrado) e não muda mais." />;
  }

  return (
    <div>
      <Link
        to={editingId ? `/compras/${editingId}` : '/compras'}
        className="mb-3 inline-flex items-center gap-1.5 text-sm font-medium text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="size-4" />
        {editingId ? purchaseNumber(editingId) : 'Compras'}
      </Link>
      <PageHeader title={editingId ? `Editar ${purchaseNumber(editingId)}` : 'Novo pedido de compra'} />
      <form onSubmit={submit} className="grid gap-6">
        {error && <Alert variant="danger" title={error} />}
        <Card>
          <CardContent className="grid gap-4 pt-5 sm:grid-cols-2 lg:grid-cols-4">
            <Field label="Fornecedor" htmlFor="compra-fornecedor" className="sm:col-span-2">
              <SupplierSelect id="compra-fornecedor" value={supplierId} onChange={(s) => setSupplierId(s?.id ?? null)} />
            </Field>
            <Field label="Loja que recebe" htmlFor="compra-loja">
              <NativeSelect id="compra-loja" value={currentStore} onChange={(e) => setStoreId(e.target.value)}>
                {(stores.data ?? []).map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </NativeSelect>
            </Field>
            <Field label="Receber até" htmlFor="compra-previsao">
              <Input id="compra-previsao" type="date" value={expected} onChange={(e) => setExpected(e.target.value)} />
            </Field>
            <Field label="Observações para o fornecedor" htmlFor="compra-obs" className="sm:col-span-2 lg:col-span-4">
              <Textarea id="compra-obs" rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={500} />
            </Field>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="grid gap-3 pt-5">
            <ol className="grid gap-3">
              {rows.map((row) => (
                <li key={row.key} className="flex flex-wrap items-end gap-3 rounded-md border border-border p-3">
                  <div className="grid min-w-0 flex-[1_1_16rem] gap-1.5">
                    <span className="text-sm font-medium">Produto</span>
                    <ProductPicker value={row.product} onChange={(p) => pickProduct(row.key, p)} />
                  </div>
                  {row.product?.purchase_unit && row.product.purchase_factor ? (
                    <Field label="Unidade" htmlFor={`compra-unidade-${row.key}`} className="w-40">
                      <NativeSelect
                        id={`compra-unidade-${row.key}`}
                        value={row.inPurchaseUnit ? 'compra' : 'venda'}
                        onChange={(e) => switchUnit(row, e.target.value === 'compra')}
                      >
                        <option value="compra">
                          {row.product.purchase_unit} ({decimalToInput(row.product.purchase_factor)} {row.product.unit})
                        </option>
                        <option value="venda">{row.product.unit}</option>
                      </NativeSelect>
                    </Field>
                  ) : null}
                  <Field
                    label={`Quantidade${row.product ? ` (${row.inPurchaseUnit ? row.product.purchase_unit : row.product.unit})` : ''}`}
                    htmlFor={`compra-qtd-${row.key}`}
                    className="w-32"
                  >
                    <Input
                      id={`compra-qtd-${row.key}`}
                      inputMode="decimal"
                      value={row.qty}
                      onChange={(e) => update(row.key, { qty: e.target.value })}
                      className="text-right tabular-nums"
                    />
                  </Field>
                  <Field
                    label={row.product && row.inPurchaseUnit ? `Custo por ${row.product.purchase_unit}` : 'Custo unitário'}
                    htmlFor={`compra-custo-${row.key}`}
                    className="w-32"
                  >
                    <Input
                      id={`compra-custo-${row.key}`}
                      inputMode="decimal"
                      value={row.cost}
                      placeholder="Opcional"
                      onChange={(e) => update(row.key, { cost: e.target.value })}
                      className="text-right tabular-nums"
                    />
                  </Field>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="size-10"
                    disabled={rows.length === 1}
                    onClick={() => setRows((rs) => rs.filter((r) => r.key !== row.key))}
                    aria-label="Remover linha"
                  >
                    <Trash2 />
                  </Button>
                </li>
              ))}
            </ol>
            <div className="flex flex-wrap items-center gap-3">
              <Button type="button" variant="outline" onClick={() => setRows((rs) => [...rs, emptyRow(Math.max(...rs.map((r) => r.key)) + 1)])}>
                <Plus />
                Outro produto
              </Button>
              {total > 0 && (
                <span className="ml-auto text-sm">
                  Total estimado <strong className="text-base tabular-nums">{formatMoney(total)}</strong>
                </span>
              )}
              <Button type="submit" size="lg" loading={save.isPending} className={total > 0 ? '' : 'ml-auto'}>
                {editingId ? 'Salvar alterações' : 'Criar pedido de compra'}
              </Button>
            </div>
          </CardContent>
        </Card>
      </form>
    </div>
  );
}
