import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, FileUp, Plus, Trash2 } from 'lucide-react';
import { useEffect, useRef, useState, type ChangeEvent } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { toast } from 'sonner';
import { ProductPicker, type PickedProduct } from '@/components/ProductPicker';
import { SupplierSelect } from '@/components/purchases/SupplierSelect';
import { PageHeader } from '@/components/shared';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Checkbox, Field, Input, NativeSelect } from '@/components/ui/input';
import { Alert, Badge } from '@/components/ui/misc';
import { api, ApiError, toQuery } from '@/lib/api';
import { useUser } from '@/lib/auth';
import { formatDocument } from '@/lib/fiscal';
import { addDays, decimalToInput, formatDate, formatMoney, formatPercent, formatQuantity, moneyToInput, parseDecimal, todayIso } from '@/lib/format';
import { useDocumentTitle } from '@/lib/hooks';
import { parseNfeXml, type NfeInvoice, type NfeItem } from '@/lib/nfeXml';
import { purchaseNumber } from '@/lib/purchases';
import type { Paginated, PurchaseOrder, PurchaseOrderDetail, SalesSettings, Store } from '@/lib/types';
import { cn } from '@/lib/utils';

type Row = {
  key: number;
  /** Item da nota (nulo no lançamento manual). */
  xml: NfeItem | null;
  product: PickedProduct | null;
  /** Unidades da loja por unidade da nota (caixa com 10 = 10). */
  factor: string;
  /** Lançamento manual: quantidade e custo na unidade escolhida (a de venda ou a de compra). */
  qty: string;
  cost: string;
  /** Lançamento manual na unidade de compra do produto (ex.: sacos de 50 KG). */
  inPurchaseUnit: boolean;
  ignore: boolean;
  source: 'supplier' | 'code' | 'name' | null;
  /** Margem sobre o custo do produto (a dele ou a padrão), para sugerir o preço de venda. */
  markup: number | null;
  /** Atualizar o preço de venda nesta entrada, e para quanto. */
  updatePrice: boolean;
  newPrice: string;
};

type MatchedProduct = PickedProduct & { price: number; cost_price: number | null; markup_percent: number | null };
type Match = { product_id: number; factor: number; source: Row['source']; product: MatchedProduct } | null;

const NEW_ROW = {
  factor: '1',
  qty: '',
  cost: '',
  inPurchaseUnit: false,
  ignore: false,
  source: null,
  markup: null,
  updatePrice: false,
  newPrice: '',
} as const;

/** Parcela a pagar da nota (duplicata do XML ou digitada). */
type PayableRow = { key: number; number: string; due: string; amount: string };

/**
 * Quantas unidades da loja vêm em cada unidade da nota: nota na unidade de compra do
 * produto (SC) usa o fator dele (50); na mesma unidade da venda, 1.
 */
function defaultFactor(xml: NfeItem, product: PickedProduct) {
  const unit = xml.unit.toUpperCase();
  if (product.purchase_unit && product.purchase_factor && unit === product.purchase_unit) return product.purchase_factor;
  return 1;
}

/** Preço sugerido pela margem sobre o custo desta nota. */
function suggestedPrice(unitCost: number | null, markup: number | null) {
  return unitCost !== null && markup !== null ? Math.round(unitCost * (1 + markup / 100) * 100) / 100 : null;
}

const SOURCE_LABEL = { supplier: 'já usado deste fornecedor', code: 'mesmo código', name: 'mesmo nome' } as const;

const round = (value: number, places: number) => Math.round(value * 10 ** places) / 10 ** places;

/** Quantidade e custo na unidade da loja. */
function rowValues(row: Row) {
  if (row.xml) {
    const factor = parseDecimal(row.factor) ?? 0;
    const quantity = round(row.xml.quantity * factor, 3);
    return { quantity, unitCost: quantity > 0 ? round(row.xml.total / quantity, 4) : null };
  }
  // Em sacos: 10 SC de 50 KG entram 500 KG, e o custo do saco vira o custo do KG.
  const factor = row.inPurchaseUnit && row.product?.purchase_factor ? row.product.purchase_factor : 1;
  const quantity = round((parseDecimal(row.qty) ?? 0) * factor, 3);
  const cost = row.cost.trim() ? parseDecimal(row.cost) : null;
  return { quantity, unitCost: cost === null ? null : round(cost / factor, 4) };
}

/** Preço de venda: o atual, a margem com o custo desta nota e o sugerido pela margem do produto. */
function PriceSuggestion({
  row,
  unitCost,
  onChange,
}: {
  row: Row;
  unitCost: number | null;
  onChange: (changes: Partial<Row>) => void;
}) {
  const price = row.product!.price!;
  const suggested = suggestedPrice(unitCost, row.markup);
  const margin = unitCost && unitCost > 0 ? ((price / unitCost - 1) * 100) : null;
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-t border-border pt-2 text-[13px]">
      <span className="text-muted-foreground">
        Venda hoje <strong className="text-foreground tabular-nums">{formatMoney(price)}</strong>
        {margin !== null && (
          <span className={cn('ml-1 tabular-nums', margin < 0 && 'font-semibold text-destructive')}>
            ({margin < 0 ? 'abaixo do custo' : `margem ${formatPercent(Math.round(margin * 10) / 10)}`})
          </span>
        )}
        {suggested !== null && suggested !== price && (
          <>
            {' '}
            · sugerido <strong className="text-foreground tabular-nums">{formatMoney(suggested)}</strong>
            <span className="ml-1">(+{formatPercent(row.markup!)})</span>
          </>
        )}
      </span>
      <label className="flex items-center gap-2">
        <Checkbox
          checked={row.updatePrice}
          onChange={(e) =>
            onChange({ updatePrice: e.target.checked, newPrice: row.newPrice || moneyToInput(suggested ?? price) })
          }
        />
        Atualizar preço de venda
      </label>
      {row.updatePrice && (
        <Input
          aria-label={`Novo preço de ${row.product!.name}`}
          inputMode="decimal"
          value={row.newPrice}
          onChange={(e) => onChange({ newPrice: e.target.value })}
          className="h-8 w-28 text-right tabular-nums"
        />
      )}
    </div>
  );
}

export function StockEntryPage() {
  useDocumentTitle('Entrada de nota');
  const user = useUser();
  // Margem padrão da loja: sugere o preço de venda dos produtos sem margem própria.
  const salesSettings = useQuery({
    queryKey: ['sales-settings'],
    queryFn: () => api<{ settings: SalesSettings }>('/sales-settings').then((r) => r.settings),
  });
  const defaultMarkup = salesSettings.data?.default_markup_percent ?? null;
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [params] = useSearchParams();
  const fileRef = useRef<HTMLInputElement>(null);
  const [storeId, setStoreId] = useState<string>(params.get('loja') ?? (user.store_id ? String(user.store_id) : ''));
  const [invoice, setInvoice] = useState<NfeInvoice | null>(null);
  const [manual, setManual] = useState(false);
  const [rows, setRows] = useState<Row[]>([]);
  const [supplierName, setSupplierName] = useState('');
  const [invoiceNumber, setInvoiceNumber] = useState('');
  const [notes, setNotes] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [reading, setReading] = useState(false);
  // Lançamento manual: fornecedor do cadastro. Na nota, ele vem pelo CNPJ.
  const [supplierId, setSupplierId] = useState<number | null>(null);
  const [purchaseOrderId, setPurchaseOrderId] = useState<string>(params.get('pedido') ?? '');
  const [launchPayables, setLaunchPayables] = useState(false);
  const [payables, setPayables] = useState<PayableRow[]>([]);
  const financeOn = Boolean(user.finance_enabled);

  const stores = useQuery({
    queryKey: ['stores'],
    queryFn: () => api<{ items: Store[] }>('/stores').then((r) => r.items),
  });
  const currentStore = storeId || (stores.data?.[0] ? String(stores.data[0].id) : '');

  // Pedidos de compra esperando mercadoria nesta loja: a nota pode ser o recebimento de um deles.
  const openOrders = useQuery({
    queryKey: ['purchase-orders', 'open', currentStore],
    queryFn: () =>
      api<Paginated<PurchaseOrder>>(`/purchase-orders${toQuery({ status: 'open', store_id: currentStore, page_size: 100 })}`).then((r) => r.items),
    enabled: Boolean(currentStore),
  });

  // Veio do pedido de compra ("Receber"): o lançamento começa com o que falta chegar.
  const fromOrder = params.get('pedido');
  const orderQuery = useQuery({
    queryKey: ['purchase-orders', 'detail', Number(fromOrder)],
    queryFn: () => api<{ purchase_order: PurchaseOrderDetail }>(`/purchase-orders/${fromOrder}`).then((r) => r.purchase_order),
    enabled: Boolean(fromOrder),
  });
  const prefilled = useRef(false);
  useEffect(() => {
    const po = orderQuery.data;
    if (!po || prefilled.current) return;
    prefilled.current = true;
    setStoreId(String(po.store_id));
    setPurchaseOrderId(String(po.id));
    setInvoice(null);
    setManual(true);
    setSupplierId(po.supplier_id);
    setSupplierName(po.supplier_name);
    const pending = po.items.filter((i) => i.quantity - i.received_quantity > 0.0005);
    setRows(
      pending.map((item, index) => {
        const factor = item.purchase_unit ? item.purchase_factor : null;
        const missing = round(item.quantity - item.received_quantity, 3);
        return {
          ...NEW_ROW,
          key: index + 1,
          xml: null,
          product: {
            id: item.product_id,
            code: item.code,
            name: item.product_name,
            unit: item.unit,
            purchase_unit: item.purchase_unit,
            purchase_factor: item.purchase_factor,
          },
          qty: decimalToInput(factor ? round(missing / factor, 3) : missing),
          cost: item.unit_cost !== null ? moneyToInput(factor ? item.unit_cost * factor : item.unit_cost) : '',
          inPurchaseUnit: Boolean(factor),
          markup: defaultMarkup,
        };
      }),
    );
  }, [orderQuery.data, defaultMarkup]);

  const update = (key: number, patch: Partial<Row>) => setRows((rs) => rs.map((r) => (r.key === key ? { ...r, ...patch } : r)));

  async function readFile(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    await loadXml(() => file.text());
  }

  // Veio do monitor de notas recebidas: o XML vem da ACBr API, sem precisar baixar e importar.
  const fromInbound = params.get('nota');
  const inboundLoaded = useRef(false);
  useEffect(() => {
    if (!fromInbound || inboundLoaded.current) return;
    inboundLoaded.current = true;
    void loadXml(async () => {
      const res = await fetch(`/api/fiscal/inbound/${encodeURIComponent(fromInbound)}/xml`, { credentials: 'same-origin' });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        throw new Error(body?.error ?? 'Não foi possível baixar o XML da nota.');
      }
      return res.text();
    });
    // loadXml usa o estado do momento; roda uma vez ao abrir.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fromInbound]);

  async function loadXml(read: () => Promise<string>) {
    setError(null);
    setReading(true);
    try {
      const parsed = parseNfeXml(await read());
      const { matches } = await api<{ matches: Match[] }>('/stock/entries/match', {
        method: 'POST',
        body: {
          supplier_document: parsed.supplierDocument,
          items: parsed.items.map((i) => ({ code: i.code, ean: i.ean, name: i.name, unit: i.unit })),
        },
      });
      setInvoice(parsed);
      setManual(false);
      setSupplierId(null);
      setSupplierName(parsed.supplierName ?? '');
      setInvoiceNumber(parsed.number ?? '');
      // Duplicatas da nota viram contas a pagar (com o financeiro ligado).
      setPayables(
        parsed.duplicates.map((d, index) => ({
          key: index + 1,
          number: d.number ? `${parsed.number ?? ''}${parsed.number ? '-' : ''}${d.number}` : '',
          due: d.dueDate,
          amount: moneyToInput(d.amount),
        })),
      );
      setLaunchPayables(financeOn && parsed.duplicates.length > 0);
      setRows(
        parsed.items.map((item, index) => {
          const match = matches[index] ?? null;
          return {
            key: index + 1,
            xml: item,
            ...NEW_ROW,
            product: match?.product ?? null,
            factor: decimalToInput(match?.factor ?? 1),
            source: match?.source ?? null,
            markup: match?.product.markup_percent ?? defaultMarkup,
          };
        }),
      );
    } catch (err) {
      setError(err instanceof ApiError || err instanceof Error ? err.message : 'Não foi possível ler o arquivo.');
    } finally {
      setReading(false);
    }
  }

  function startManual() {
    setInvoice(null);
    setManual(true);
    setError(null);
    setSupplierName('');
    setSupplierId(null);
    setInvoiceNumber('');
    setPayables([]);
    setLaunchPayables(false);
    setRows([{ ...NEW_ROW, key: 1, xml: null, product: null, markup: defaultMarkup }]);
  }

  // Um único pedido de compra aberto do fornecedor da nota: a nota é o recebimento dele.
  // Num efeito, porque a lista de pedidos pode chegar depois da leitura do XML.
  const autoLinked = useRef<string | null>(null);
  useEffect(() => {
    const key = invoice?.accessKey ?? invoice?.number ?? null;
    if (!invoice?.supplierDocument || !openOrders.data || !key || autoLinked.current === key) return;
    autoLinked.current = key;
    const candidates = openOrders.data.filter((po) => po.supplier_document === invoice.supplierDocument);
    if (candidates.length === 1) setPurchaseOrderId((current) => current || String(candidates[0]!.id));
  }, [invoice, openOrders.data]);

  /** Total da entrada (o da nota, ou a soma dos itens no lançamento manual). */
  const entryTotal =
    invoice?.total ??
    round(
      rows.filter((r) => !r.ignore).reduce((sum, r) => {
        const { quantity, unitCost } = rowValues(r);
        return sum + quantity * (unitCost ?? 0);
      }, 0),
      2,
    );

  function togglePayables(checked: boolean) {
    setLaunchPayables(checked);
    // Sem duplicata na nota: uma parcela com o total, para daqui a 30 dias.
    if (checked && !payables.length) {
      setPayables([{ key: 1, number: invoiceNumber, due: addDays(todayIso(), 30), amount: entryTotal ? moneyToInput(entryTotal) : '' }]);
    }
  }

  const updatePayable = (key: number, patch: Partial<PayableRow>) =>
    setPayables((ps) => ps.map((p) => (p.key === key ? { ...p, ...patch } : p)));

  const save = useMutation({
    mutationFn: (
      items: { product_id: number; quantity: number; unit_cost: number | null; supplier_code: string | null; factor: number; new_price: number | null }[],
    ) => {
      const issued = invoice?.issuedAt ?? null;
      return api<{ entry: { id: number } }>('/stock/entries', {
        method: 'POST',
        body: {
          store_id: Number(currentStore),
          supplier_id: manual ? supplierId : null,
          purchase_order_id: purchaseOrderId ? Number(purchaseOrderId) : null,
          payables: launchPayables
            ? payables.map((p) => ({ due_date: p.due, amount: parseDecimal(p.amount), document_number: p.number || null }))
            : [],
          supplier_name: supplierName || null,
          supplier_document: invoice?.supplierDocument ?? null,
          invoice_number: invoiceNumber || null,
          invoice_series: invoice?.series ?? null,
          access_key: invoice?.accessKey ?? null,
          // NF-e antiga traz só a data; vira meia-noite no fuso de Brasília.
          issued_at: issued ? (issued.includes('T') ? issued : `${issued}T00:00:00-03:00`) : null,
          total_amount: invoice?.total ?? null,
          notes: notes || null,
          items,
        },
      });
    },
    onSuccess: ({ entry }) => {
      queryClient.invalidateQueries({ queryKey: ['stock'] });
      queryClient.invalidateQueries({ queryKey: ['products'] });
      queryClient.invalidateQueries({ queryKey: ['purchase-orders'] });
      queryClient.invalidateQueries({ queryKey: ['payables'] });
      queryClient.invalidateQueries({ queryKey: ['suppliers'] });
      const launched = launchPayables ? payables.length : 0;
      toast.success(
        `Entrada nº ${entry.id} lançada no estoque${launched ? ` e ${launched} ${launched === 1 ? 'conta' : 'contas'} a pagar` : ''}.`,
      );
      navigate(purchaseOrderId ? `/compras/${purchaseOrderId}` : '/estoque?aba=entradas');
    },
    onError: (err) => setError(err instanceof ApiError ? err.message : 'Não foi possível lançar a entrada.'),
  });

  function submit() {
    if (!currentStore) return setError('Escolha a loja.');
    const active = rows.filter((r) => !r.ignore);
    if (!active.length) return setError('Nenhum item para dar entrada.');
    const items = [];
    for (const row of active) {
      const label = row.xml ? `"${row.xml.name}"` : 'cada linha';
      if (!row.product) return setError(`Escolha o produto da loja para ${label}, ou marque "Ignorar".`);
      const { quantity, unitCost } = rowValues(row);
      if (!(quantity > 0)) return setError(`Informe a quantidade de ${row.product.name}.`);
      const newPrice = row.updatePrice ? parseDecimal(row.newPrice) : null;
      if (row.updatePrice && (newPrice === null || newPrice < 0)) return setError(`Preço de venda inválido para ${row.product.name}.`);
      items.push({
        new_price: newPrice,
        product_id: row.product.id,
        quantity,
        unit_cost: unitCost,
        supplier_code: row.xml?.code || null,
        factor: row.xml ? (parseDecimal(row.factor) ?? 1) : 1,
      });
    }
    if (launchPayables) {
      if (!payables.length) return setError('Informe pelo menos um vencimento, ou desmarque as contas a pagar.');
      for (const p of payables) {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(p.due)) return setError('Informe o vencimento de cada parcela.');
        const amount = parseDecimal(p.amount);
        if (amount === null || amount <= 0) return setError('Informe o valor de cada parcela.');
      }
    }
    setError(null);
    save.mutate(items);
  }

  const payablesTotal = round(payables.reduce((sum, p) => sum + (parseDecimal(p.amount) ?? 0), 0), 2);
  const started = invoice !== null || manual;
  const pending = rows.filter((r) => !r.ignore && !r.product).length;

  return (
    <div>
      <Link to="/estoque" className="mb-3 inline-flex items-center gap-1.5 text-sm font-medium text-muted-foreground hover:text-foreground">
        <ArrowLeft className="size-4" />
        Estoque
      </Link>
      <PageHeader
        title="Entrada de nota"
        description="Importe o XML da NF-e de compra ou lance os itens à mão. O estoque da loja soma na hora."
      />

      <div className="grid grid-cols-1 gap-6">
        <Card>
          <CardContent className="flex flex-wrap items-end gap-3 pt-5">
            <Field label="Loja que recebe" htmlFor="entrada-loja" className="w-full sm:w-56">
              <NativeSelect id="entrada-loja" value={currentStore} onChange={(e) => setStoreId(e.target.value)}>
                {(stores.data ?? []).map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </NativeSelect>
            </Field>
            <input ref={fileRef} type="file" accept=".xml,text/xml,application/xml" className="hidden" onChange={readFile} />
            <Button onClick={() => fileRef.current?.click()} loading={reading}>
              <FileUp />
              Importar XML da nota
            </Button>
            <Button variant="outline" onClick={startManual}>
              Lançar à mão
            </Button>
          </CardContent>
        </Card>

        {error && <Alert variant="danger" title={error} />}

        {started && (
          <Card>
            <CardHeader>
              <CardTitle>{invoice ? 'Nota de compra' : 'Lançamento manual'}</CardTitle>
              {invoice?.accessKey && <span className="text-[13px] break-all text-muted-foreground tabular-nums">Chave {invoice.accessKey}</span>}
            </CardHeader>
            <CardContent className="grid gap-4">
              <div className="grid gap-4 sm:grid-cols-3">
                <Field label="Fornecedor" htmlFor="entrada-fornecedor">
                  {manual ? (
                    <SupplierSelect
                      id="entrada-fornecedor"
                      value={supplierId}
                      emptyLabel="Sem fornecedor"
                      onChange={(supplier) => {
                        setSupplierId(supplier?.id ?? null);
                        setSupplierName(supplier?.name ?? '');
                      }}
                    />
                  ) : (
                    <Input id="entrada-fornecedor" value={supplierName} onChange={(e) => setSupplierName(e.target.value)} maxLength={120} />
                  )}
                </Field>
                <Field label="Número da nota" htmlFor="entrada-numero">
                  <Input id="entrada-numero" value={invoiceNumber} onChange={(e) => setInvoiceNumber(e.target.value)} maxLength={20} />
                </Field>
                <Field label="Observação" htmlFor="entrada-obs">
                  <Input id="entrada-obs" value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={300} />
                </Field>
              </div>
              {((openOrders.data?.length ?? 0) > 0 || purchaseOrderId) && (
                <Field
                  label="Pedido de compra"
                  htmlFor="entrada-pedido"
                  hint={purchaseOrderId ? 'O que chegar é baixado do pedido; o que faltar continua esperado.' : 'Se esta nota é a entrega de um pedido de compra, escolha qual.'}
                  className="sm:max-w-md"
                >
                  <NativeSelect id="entrada-pedido" value={purchaseOrderId} onChange={(e) => setPurchaseOrderId(e.target.value)}>
                    <option value="">Nenhum</option>
                    {(openOrders.data ?? []).map((po) => (
                      <option key={po.id} value={po.id}>
                        {purchaseNumber(po.id)} · {po.supplier_name} · {formatDate(po.created_at)}
                      </option>
                    ))}
                    {purchaseOrderId && !openOrders.data?.some((po) => String(po.id) === purchaseOrderId) && (
                      <option value={purchaseOrderId}>{purchaseNumber(Number(purchaseOrderId))}</option>
                    )}
                  </NativeSelect>
                </Field>
              )}
              {invoice && (
                <p className="text-sm text-muted-foreground">
                  {formatDocument(invoice.supplierDocument)}
                  {invoice.issuedAt && ` · emitida em ${formatDate(invoice.issuedAt)}`}
                  {invoice.total !== null && ` · total da nota ${formatMoney(invoice.total)}`} · {invoice.items.length}{' '}
                  {invoice.items.length === 1 ? 'item' : 'itens'}
                  {pending > 0 && (
                    <Badge variant="warning" className="ml-2">
                      {pending} sem produto
                    </Badge>
                  )}
                </p>
              )}

              <ol className="grid gap-3">
                {rows.map((row) => {
                  const { quantity, unitCost } = rowValues(row);
                  return (
                    <li key={row.key} className={cn('grid gap-3 rounded-md border border-border p-3', row.ignore && 'opacity-55')}>
                      {row.xml && (
                        <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 text-sm">
                          <span>
                            <span className="text-muted-foreground tabular-nums">{row.xml.code}</span>{' '}
                            <span className="font-medium">{row.xml.name}</span>
                          </span>
                          <span className="text-muted-foreground tabular-nums">
                            {formatQuantity(row.xml.quantity)} {row.xml.unit} × {formatMoney(row.xml.unitPrice)} ={' '}
                            <strong className="text-foreground">{formatMoney(row.xml.total)}</strong>
                          </span>
                        </div>
                      )}
                      <div className="flex flex-wrap items-end gap-3">
                        <div className="grid min-w-0 flex-[1_1_15rem] gap-1.5">
                          <span className="text-sm font-medium">
                            Produto da loja
                            {row.source && <span className="ml-2 text-[12px] font-normal text-success">({SOURCE_LABEL[row.source]})</span>}
                          </span>
                          <ProductPicker
                            value={row.product}
                            onChange={(product) =>
                              update(row.key, {
                                product,
                                source: null,
                                markup: defaultMarkup,
                                updatePrice: false,
                                newPrice: '',
                                // Nota em SC para produto que vende em KG: o fator vem do cadastro (50).
                                ...(row.xml && product ? { factor: decimalToInput(defaultFactor(row.xml, product)) } : {}),
                                inPurchaseUnit: !row.xml && Boolean(product?.purchase_unit && product.purchase_factor),
                              })
                            }
                            invalid={!row.ignore && !row.product}
                          />
                        </div>
                        {row.xml ? (
                          <>
                            <Field
                              label={`${row.product?.unit ?? 'Un.'} em cada ${row.xml.unit || 'un.'}`}
                              htmlFor={`fator-${row.key}`}
                              className="w-36"
                            >
                              <Input
                                id={`fator-${row.key}`}
                                inputMode="decimal"
                                value={row.factor}
                                onChange={(e) => update(row.key, { factor: e.target.value })}
                              />
                            </Field>
                            <div className="grid gap-0.5 text-right text-sm">
                              <span className="text-muted-foreground">Entra</span>
                              <span className="font-semibold tabular-nums">
                                {formatQuantity(quantity)} {row.product?.unit ?? ''}
                              </span>
                              {unitCost !== null && <span className="text-[12px] text-muted-foreground tabular-nums">{formatMoney(unitCost)} cada</span>}
                            </div>
                            <label className="flex items-center gap-2 self-center text-sm">
                              <Checkbox checked={row.ignore} onChange={(e) => update(row.key, { ignore: e.target.checked })} />
                              Ignorar
                            </label>
                          </>
                        ) : (
                          <>
                            {row.product?.purchase_unit && row.product.purchase_factor && (
                              <Field label="Unidade" htmlFor={`unidade-${row.key}`} className="w-40">
                                <NativeSelect
                                  id={`unidade-${row.key}`}
                                  value={row.inPurchaseUnit ? 'compra' : 'venda'}
                                  onChange={(e) => update(row.key, { inPurchaseUnit: e.target.value === 'compra', qty: '', cost: '' })}
                                >
                                  <option value="compra">
                                    {row.product.purchase_unit} ({decimalToInput(row.product.purchase_factor)} {row.product.unit})
                                  </option>
                                  <option value="venda">{row.product.unit}</option>
                                </NativeSelect>
                              </Field>
                            )}
                            <Field
                              label={`Quantidade${row.product ? ` (${row.inPurchaseUnit ? row.product.purchase_unit : row.product.unit})` : ''}`}
                              htmlFor={`qtd-${row.key}`}
                              className="w-28"
                            >
                              <Input id={`qtd-${row.key}`} inputMode="decimal" value={row.qty} onChange={(e) => update(row.key, { qty: e.target.value })} />
                            </Field>
                            <Field
                              label={row.product && row.inPurchaseUnit ? `Custo por ${row.product.purchase_unit}` : 'Custo unitário'}
                              htmlFor={`custo-${row.key}`}
                              className="w-32"
                            >
                              <Input
                                id={`custo-${row.key}`}
                                inputMode="decimal"
                                value={row.cost}
                                placeholder="Opcional"
                                onChange={(e) => update(row.key, { cost: e.target.value })}
                              />
                            </Field>
                            <Button
                              variant="ghost"
                              size="icon"
                              className="size-10"
                              disabled={rows.length === 1}
                              onClick={() => setRows((rs) => rs.filter((r) => r.key !== row.key))}
                              aria-label="Remover linha"
                            >
                              <Trash2 />
                            </Button>
                            {row.inPurchaseUnit && quantity > 0 && (
                              <div className="grid gap-0.5 self-center text-right text-sm">
                                <span className="text-muted-foreground">Entra</span>
                                <span className="font-semibold tabular-nums">
                                  {formatQuantity(quantity)} {row.product?.unit}
                                </span>
                                {unitCost !== null && <span className="text-[12px] text-muted-foreground tabular-nums">{formatMoney(unitCost)} cada</span>}
                              </div>
                            )}
                          </>
                        )}
                      </div>
                      {row.product && !row.ignore && row.product.price !== undefined && (
                        <PriceSuggestion
                          row={row}
                          unitCost={unitCost}
                          onChange={(changes) => update(row.key, changes)}
                        />
                      )}
                    </li>
                  );
                })}
              </ol>

              {financeOn && (
                <div className="grid gap-3 rounded-md border border-border p-3">
                  <label className="flex items-center gap-2 text-sm font-medium">
                    <Checkbox checked={launchPayables} onChange={(e) => togglePayables(e.target.checked)} />
                    Lançar em contas a pagar
                    {invoice && invoice.duplicates.length > 0 && (
                      <span className="font-normal text-muted-foreground">
                        ({invoice.duplicates.length} {invoice.duplicates.length === 1 ? 'duplicata' : 'duplicatas'} na nota)
                      </span>
                    )}
                  </label>
                  {launchPayables && (
                    <>
                      <ul className="grid gap-2">
                        {payables.map((p, index) => (
                          <li key={p.key} className="flex flex-wrap items-end gap-2">
                            <Field label={index === 0 ? 'Nº' : ''} htmlFor={`dup-num-${p.key}`} className="w-32">
                              <Input
                                id={`dup-num-${p.key}`}
                                aria-label={`Número da parcela ${index + 1}`}
                                value={p.number}
                                onChange={(e) => updatePayable(p.key, { number: e.target.value })}
                                maxLength={30}
                              />
                            </Field>
                            <Field label={index === 0 ? 'Vencimento' : ''} htmlFor={`dup-venc-${p.key}`} className="w-40">
                              <Input
                                id={`dup-venc-${p.key}`}
                                aria-label={`Vencimento da parcela ${index + 1}`}
                                type="date"
                                value={p.due}
                                onChange={(e) => updatePayable(p.key, { due: e.target.value })}
                              />
                            </Field>
                            <Field label={index === 0 ? 'Valor' : ''} htmlFor={`dup-valor-${p.key}`} className="w-32">
                              <Input
                                id={`dup-valor-${p.key}`}
                                aria-label={`Valor da parcela ${index + 1}`}
                                inputMode="decimal"
                                value={p.amount}
                                onChange={(e) => updatePayable(p.key, { amount: e.target.value })}
                                className="text-right tabular-nums"
                              />
                            </Field>
                            <Button
                              variant="ghost"
                              size="icon"
                              className="size-10"
                              disabled={payables.length === 1}
                              onClick={() => setPayables((ps) => ps.filter((x) => x.key !== p.key))}
                              aria-label={`Remover parcela ${index + 1}`}
                            >
                              <Trash2 />
                            </Button>
                          </li>
                        ))}
                      </ul>
                      <div className="flex flex-wrap items-center gap-3 text-sm">
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => {
                            const last = payables[payables.length - 1];
                            setPayables((ps) => [
                              ...ps,
                              { key: Math.max(0, ...ps.map((x) => x.key)) + 1, number: '', due: last ? addDays(last.due, 30) : addDays(todayIso(), 30), amount: '' },
                            ]);
                          }}
                        >
                          <Plus />
                          Parcela
                        </Button>
                        <span className={cn('ml-auto tabular-nums', entryTotal > 0 && Math.abs(payablesTotal - entryTotal) > 0.009 && 'font-medium text-warning')}>
                          Parcelas {formatMoney(payablesTotal)}
                          {entryTotal > 0 && Math.abs(payablesTotal - entryTotal) > 0.009 && ` · a nota soma ${formatMoney(entryTotal)}`}
                        </span>
                      </div>
                    </>
                  )}
                </div>
              )}

              <div className="flex flex-wrap items-center gap-2">
                {manual && (
                  <Button
                    variant="outline"
                    onClick={() =>
                      setRows((rs) => [
                        ...rs,
                        { ...NEW_ROW, key: Math.max(...rs.map((r) => r.key)) + 1, xml: null, product: null, markup: defaultMarkup },
                      ])
                    }
                  >
                    <Plus />
                    Outro produto
                  </Button>
                )}
                <Button className="ml-auto" size="lg" onClick={submit} loading={save.isPending}>
                  Dar entrada no estoque
                </Button>
              </div>
            </CardContent>
          </Card>
        )}
      </div>
    </div>
  );
}
