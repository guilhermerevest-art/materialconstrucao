import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, FileUp, Plus, Trash2 } from 'lucide-react';
import { useRef, useState, type ChangeEvent } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { toast } from 'sonner';
import { ProductPicker, type PickedProduct } from '@/components/ProductPicker';
import { PageHeader } from '@/components/shared';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Checkbox, Field, Input, NativeSelect } from '@/components/ui/input';
import { Alert, Badge } from '@/components/ui/misc';
import { api, ApiError } from '@/lib/api';
import { useUser } from '@/lib/auth';
import { decimalToInput, formatDate, formatMoney, formatQuantity, parseDecimal } from '@/lib/format';
import { useDocumentTitle } from '@/lib/hooks';
import { parseNfeXml, type NfeInvoice, type NfeItem } from '@/lib/nfeXml';
import type { Store } from '@/lib/types';
import { cn } from '@/lib/utils';

type Row = {
  key: number;
  /** Item da nota (nulo no lançamento manual). */
  xml: NfeItem | null;
  product: PickedProduct | null;
  /** Unidades da loja por unidade da nota (caixa com 10 = 10). */
  factor: string;
  /** Lançamento manual: quantidade e custo na unidade da loja. */
  qty: string;
  cost: string;
  ignore: boolean;
  source: 'supplier' | 'code' | 'name' | null;
};

type Match = { product_id: number; factor: number; source: Row['source']; product: PickedProduct } | null;

const SOURCE_LABEL = { supplier: 'já usado deste fornecedor', code: 'mesmo código', name: 'mesmo nome' } as const;

const round = (value: number, places: number) => Math.round(value * 10 ** places) / 10 ** places;

function formatDocument(digits: string | null) {
  if (!digits) return '';
  if (digits.length === 14) return digits.replace(/^(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})$/, '$1.$2.$3/$4-$5');
  if (digits.length === 11) return digits.replace(/^(\d{3})(\d{3})(\d{3})(\d{2})$/, '$1.$2.$3-$4');
  return digits;
}

/** Quantidade e custo na unidade da loja. */
function rowValues(row: Row) {
  if (row.xml) {
    const factor = parseDecimal(row.factor) ?? 0;
    const quantity = round(row.xml.quantity * factor, 3);
    return { quantity, unitCost: quantity > 0 ? round(row.xml.total / quantity, 4) : null };
  }
  const quantity = parseDecimal(row.qty) ?? 0;
  return { quantity, unitCost: row.cost.trim() ? parseDecimal(row.cost) : null };
}

export function StockEntryPage() {
  useDocumentTitle('Entrada de nota');
  const user = useUser();
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

  const stores = useQuery({
    queryKey: ['stores'],
    queryFn: () => api<{ items: Store[] }>('/stores').then((r) => r.items),
  });
  const currentStore = storeId || (stores.data?.[0] ? String(stores.data[0].id) : '');

  const update = (key: number, patch: Partial<Row>) => setRows((rs) => rs.map((r) => (r.key === key ? { ...r, ...patch } : r)));

  async function readFile(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    setError(null);
    setReading(true);
    try {
      const parsed = parseNfeXml(await file.text());
      const { matches } = await api<{ matches: Match[] }>('/stock/entries/match', {
        method: 'POST',
        body: {
          supplier_document: parsed.supplierDocument,
          items: parsed.items.map((i) => ({ code: i.code, ean: i.ean, name: i.name })),
        },
      });
      setInvoice(parsed);
      setManual(false);
      setSupplierName(parsed.supplierName ?? '');
      setInvoiceNumber(parsed.number ?? '');
      setRows(
        parsed.items.map((item, index) => {
          const match = matches[index] ?? null;
          return {
            key: index + 1,
            xml: item,
            product: match?.product ?? null,
            factor: decimalToInput(match?.factor ?? 1),
            qty: '',
            cost: '',
            ignore: false,
            source: match?.source ?? null,
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
    setInvoiceNumber('');
    setRows([{ key: 1, xml: null, product: null, factor: '1', qty: '', cost: '', ignore: false, source: null }]);
  }

  const save = useMutation({
    mutationFn: (items: { product_id: number; quantity: number; unit_cost: number | null; supplier_code: string | null; factor: number }[]) => {
      const issued = invoice?.issuedAt ?? null;
      return api<{ entry: { id: number } }>('/stock/entries', {
        method: 'POST',
        body: {
          store_id: Number(currentStore),
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
      toast.success(`Entrada nº ${entry.id} lançada no estoque.`);
      navigate('/estoque?aba=entradas');
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
      items.push({
        product_id: row.product.id,
        quantity,
        unit_cost: unitCost,
        supplier_code: row.xml?.code || null,
        factor: row.xml ? (parseDecimal(row.factor) ?? 1) : 1,
      });
    }
    setError(null);
    save.mutate(items);
  }

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
                  <Input id="entrada-fornecedor" value={supplierName} onChange={(e) => setSupplierName(e.target.value)} maxLength={120} />
                </Field>
                <Field label="Número da nota" htmlFor="entrada-numero">
                  <Input id="entrada-numero" value={invoiceNumber} onChange={(e) => setInvoiceNumber(e.target.value)} maxLength={20} />
                </Field>
                <Field label="Observação" htmlFor="entrada-obs">
                  <Input id="entrada-obs" value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={300} />
                </Field>
              </div>
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
                            onChange={(product) => update(row.key, { product, source: null })}
                            invalid={!row.ignore && !row.product}
                          />
                        </div>
                        {row.xml ? (
                          <>
                            <Field label={`${row.product?.unit ?? 'Un.'} por ${row.xml.unit || 'un.'}`} htmlFor={`fator-${row.key}`} className="w-32">
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
                            <Field label="Quantidade" htmlFor={`qtd-${row.key}`} className="w-28">
                              <Input id={`qtd-${row.key}`} inputMode="decimal" value={row.qty} onChange={(e) => update(row.key, { qty: e.target.value })} />
                            </Field>
                            <Field label="Custo unitário" htmlFor={`custo-${row.key}`} className="w-32">
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
                          </>
                        )}
                      </div>
                    </li>
                  );
                })}
              </ol>

              <div className="flex flex-wrap items-center gap-2">
                {manual && (
                  <Button
                    variant="outline"
                    onClick={() =>
                      setRows((rs) => [
                        ...rs,
                        { key: Math.max(...rs.map((r) => r.key)) + 1, xml: null, product: null, factor: '1', qty: '', cost: '', ignore: false, source: null },
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
