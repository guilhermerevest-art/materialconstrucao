import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Package, Pencil, Percent, Plus, Receipt, Search, Tags, Trash2 } from 'lucide-react';
import { useEffect, useState, type FormEvent } from 'react';
import { Link } from 'react-router';
import { toast } from 'sonner';
import { PriceAdjustDialog } from '@/components/PriceAdjustDialog';
import { emptyPricingForm, ProductPricingTab, pricingToBody, pricingToForm, type PricingForm } from '@/components/ProductPricingTab';
import { EmptyState, PageHeader, Pagination } from '@/components/shared';
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
import { Checkbox, Field, Input, NativeSelect, Textarea } from '@/components/ui/input';
import { Alert, Badge, Skeleton } from '@/components/ui/misc';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Table, TBody, TD, TH, THead, TR } from '@/components/ui/table';
import { api, ApiError, toQuery } from '@/lib/api';
import { useUser } from '@/lib/auth';
import {
  IBSCBS_CST,
  isSimples,
  NORMAL_ICMS_CST,
  PIS_COFINS_CST,
  rateToInput,
  rateToJson,
  SIMPLES_CSOSN,
  TAX_ORIGINS,
} from '@/lib/fiscal';
import { decimalToInput, formatMoney, moneyToInput, parseDecimal } from '@/lib/format';
import { useDebouncedValue, useDocumentTitle } from '@/lib/hooks';
import type { FiscalSettings, Paginated, Product, ProductFiscal, ProductPricing, SalesSettings } from '@/lib/types';
import { cn } from '@/lib/utils';

const PAGE_SIZE = 25;
const UNITS = ['UN', 'PC', 'CX', 'SC', 'KG', 'TON', 'M', 'M²', 'M³', 'L', 'LT', 'BR', 'RL', 'PAR', 'JG'];

/** Aba fiscal no estado do formulário: tudo texto, como foi digitado. */
type FiscalForm = { [K in keyof ProductFiscal]: string };

const RATE_FIELDS = ['icms_rate', 'icms_base_reduction', 'pis_rate', 'cofins_rate'] as const;

function fiscalToForm(fiscal: ProductFiscal | undefined): FiscalForm {
  return {
    gtin: fiscal?.gtin ?? '',
    ncm: fiscal?.ncm ?? '',
    cest: fiscal?.cest ?? '',
    cfop: fiscal?.cfop ?? '',
    tax_origin: String(fiscal?.tax_origin ?? 0),
    icms_cst: fiscal?.icms_cst ?? '',
    icms_rate: rateToInput(fiscal?.icms_rate),
    icms_base_reduction: rateToInput(fiscal?.icms_base_reduction),
    pis_cst: fiscal?.pis_cst ?? '',
    pis_rate: rateToInput(fiscal?.pis_rate),
    cofins_cst: fiscal?.cofins_cst ?? '',
    cofins_rate: rateToInput(fiscal?.cofins_rate),
    ibscbs_cst: fiscal?.ibscbs_cst ?? '',
    ibscbs_class: fiscal?.ibscbs_class ?? '',
    tax_benefit_code: fiscal?.tax_benefit_code ?? '',
    fiscal_notes: fiscal?.fiscal_notes ?? '',
  };
}

/** Converte para o JSON da API. Devolve o nome do campo com alíquota inválida. */
function fiscalToBody(form: FiscalForm): { body: Record<string, unknown> } | { invalid: string } {
  const body: Record<string, unknown> = { ...form, tax_origin: Number(form.tax_origin) };
  for (const field of RATE_FIELDS) {
    const value = rateToJson(form[field]);
    if (Number.isNaN(value)) return { invalid: field };
    body[field] = value;
  }
  return { body };
}

const RATE_LABELS: Record<(typeof RATE_FIELDS)[number], string> = {
  icms_rate: 'Alíquota do ICMS',
  icms_base_reduction: 'Redução da base do ICMS',
  pis_rate: 'Alíquota do PIS',
  cofins_rate: 'Alíquota da COFINS',
};

/** Aba "Fiscal": o que a NF-e/NFC-e precisa de cada produto. */
function ProductFiscalFields({ value, onChange }: { value: FiscalForm; onChange: (next: FiscalForm) => void }) {
  // O regime da empresa decide se o ICMS usa CSOSN (Simples) ou CST (regime normal).
  const settings = useQuery({
    queryKey: ['fiscal-settings'],
    queryFn: () => api<{ settings: FiscalSettings }>('/fiscal/settings').then((r) => r.settings),
    staleTime: 60_000,
  });
  const regime = settings.data?.tax_regime ?? null;
  const simples = isSimples(regime);
  const normal = regime === 3;
  const set = (key: keyof FiscalForm) => (event: { target: { value: string } }) =>
    onChange({ ...value, [key]: event.target.value });
  // Alíquota só entra no cálculo nestes códigos; nos outros o campo fica travado.
  const icmsUsesRate = ['101', '900', '00', '20'].includes(value.icms_cst);
  const contributionUsesRate = (cst: string) => Boolean(cst) && !['04', '05', '06', '07', '08', '09'].includes(cst);

  return (
    <div className="grid gap-4">
      {regime === null && !settings.isPending && (
        <Alert
          title="Regime tributário da empresa não informado"
          className="py-3"
        >
          <p className="text-[13px] text-muted-foreground">
            Preencha Configurações → Fiscal para a lista de ICMS mostrar só CSOSN (Simples) ou só CST (regime normal).
          </p>
        </Alert>
      )}
      <div className="grid gap-4 sm:grid-cols-3">
        <Field label="NCM" htmlFor="produto-ncm" hint="8 dígitos (obrigatório na nota)">
          <Input id="produto-ncm" value={value.ncm} onChange={set('ncm')} inputMode="numeric" placeholder="2523.29.10" />
        </Field>
        <Field label="CEST" htmlFor="produto-cest" hint="Mercadoria com ST">
          <Input id="produto-cest" value={value.cest} onChange={set('cest')} inputMode="numeric" placeholder="05.001.00" />
        </Field>
        <Field label="Código de barras (GTIN)" htmlFor="produto-gtin" hint="Vazio = SEM GTIN">
          <Input id="produto-gtin" value={value.gtin} onChange={set('gtin')} inputMode="numeric" />
        </Field>
      </div>
      <div className="grid gap-4 sm:grid-cols-[10rem_1fr]">
        <Field label="CFOP" htmlFor="produto-cfop" hint="Vazio: 5102 (5405 com ST)">
          <Input id="produto-cfop" value={value.cfop} onChange={set('cfop')} inputMode="numeric" placeholder="5102" maxLength={4} />
        </Field>
        <Field label="Origem da mercadoria" htmlFor="produto-origem">
          <NativeSelect id="produto-origem" value={value.tax_origin} onChange={set('tax_origin')}>
            {TAX_ORIGINS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </NativeSelect>
        </Field>
      </div>

      <fieldset className="grid gap-4 rounded-lg border border-border p-4">
        <legend className="px-1 text-sm font-semibold">ICMS</legend>
        <div className="grid gap-4 sm:grid-cols-[1fr_9rem_9rem]">
          <Field label={simples ? 'CSOSN' : normal ? 'CST' : 'Situação tributária'} htmlFor="produto-icms">
            <NativeSelect id="produto-icms" value={value.icms_cst} onChange={set('icms_cst')}>
              <option value="">Selecione</option>
              {!normal && (
                <optgroup label="Simples Nacional (CSOSN)">
                  {SIMPLES_CSOSN.map((o) => (
                    <option key={o.value} value={o.value}>
                      {o.label}
                    </option>
                  ))}
                </optgroup>
              )}
              {!simples && (
                <optgroup label="Regime normal (CST)">
                  {NORMAL_ICMS_CST.map((o) => (
                    <option key={o.value} value={o.value}>
                      {o.label}
                    </option>
                  ))}
                </optgroup>
              )}
            </NativeSelect>
          </Field>
          <Field
            label={value.icms_cst === '101' ? 'Crédito SN (%)' : 'Alíquota (%)'}
            htmlFor="produto-icms-aliquota"
          >
            <Input
              id="produto-icms-aliquota"
              value={value.icms_rate}
              onChange={set('icms_rate')}
              inputMode="decimal"
              placeholder="0,00"
              className="text-right tabular-nums"
              disabled={!icmsUsesRate}
            />
          </Field>
          <Field label="Redução BC (%)" htmlFor="produto-icms-reducao" hint="Só no CST 20">
            <Input
              id="produto-icms-reducao"
              value={value.icms_base_reduction}
              onChange={set('icms_base_reduction')}
              inputMode="decimal"
              placeholder="0,00"
              className="text-right tabular-nums"
              disabled={value.icms_cst !== '20'}
            />
          </Field>
        </div>
      </fieldset>

      <fieldset className="grid gap-4 rounded-lg border border-border p-4">
        <legend className="px-1 text-sm font-semibold">PIS e COFINS</legend>
        {!normal && (
          <p className="-mt-1 text-[13px] text-muted-foreground">
            No Simples Nacional pode deixar em branco: sai CST 49 (outras operações), sem valor.
          </p>
        )}
        <div className="grid gap-4 sm:grid-cols-[1fr_9rem]">
          <Field label="CST do PIS" htmlFor="produto-pis">
            <NativeSelect id="produto-pis" value={value.pis_cst} onChange={set('pis_cst')}>
              <option value="">{simples ? 'Padrão do Simples (49)' : 'Selecione'}</option>
              {PIS_COFINS_CST.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </NativeSelect>
          </Field>
          <Field label="Alíquota (%)" htmlFor="produto-pis-aliquota">
            <Input
              id="produto-pis-aliquota"
              value={value.pis_rate}
              onChange={set('pis_rate')}
              inputMode="decimal"
              placeholder="0,00"
              className="text-right tabular-nums"
              disabled={!contributionUsesRate(value.pis_cst)}
            />
          </Field>
          <Field label="CST da COFINS" htmlFor="produto-cofins">
            <NativeSelect id="produto-cofins" value={value.cofins_cst} onChange={set('cofins_cst')}>
              <option value="">{simples ? 'Padrão do Simples (49)' : 'Selecione'}</option>
              {PIS_COFINS_CST.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </NativeSelect>
          </Field>
          <Field label="Alíquota (%)" htmlFor="produto-cofins-aliquota">
            <Input
              id="produto-cofins-aliquota"
              value={value.cofins_rate}
              onChange={set('cofins_rate')}
              inputMode="decimal"
              placeholder="0,00"
              className="text-right tabular-nums"
              disabled={!contributionUsesRate(value.cofins_cst)}
            />
          </Field>
        </div>
      </fieldset>

      {!simples && (
        <fieldset className="grid gap-4 rounded-lg border border-border p-4">
          <legend className="px-1 text-sm font-semibold">IBS e CBS (reforma tributária)</legend>
          <p className="-mt-1 text-[13px] text-muted-foreground">
            Só regime normal. Com os dois campos preenchidos, a nota destaca IBS e CBS com as alíquotas de Configurações → Fiscal.
          </p>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="CST do IBS/CBS" htmlFor="produto-ibscbs">
              <NativeSelect id="produto-ibscbs" value={value.ibscbs_cst} onChange={set('ibscbs_cst')}>
                <option value="">Não destacar</option>
                {IBSCBS_CST.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </NativeSelect>
            </Field>
            <Field label="Classificação tributária (cClassTrib)" htmlFor="produto-cclasstrib" hint="6 dígitos, ex.: 000001">
              <Input
                id="produto-cclasstrib"
                value={value.ibscbs_class}
                onChange={set('ibscbs_class')}
                inputMode="numeric"
                maxLength={6}
              />
            </Field>
          </div>
        </fieldset>
      )}

      <div className="grid gap-4 sm:grid-cols-[12rem_1fr]">
        <Field label="Benefício fiscal (cBenef)" htmlFor="produto-cbenef" hint="Se a UF exigir">
          <Input id="produto-cbenef" value={value.tax_benefit_code} onChange={set('tax_benefit_code')} maxLength={10} />
        </Field>
        <Field label="Informações adicionais do produto" htmlFor="produto-infadprod" hint="Sai na nota, junto do item">
          <Textarea
            id="produto-infadprod"
            value={value.fiscal_notes}
            onChange={set('fiscal_notes')}
            maxLength={500}
            className="min-h-10"
          />
        </Field>
      </div>
    </div>
  );
}

function ProductFormDialog({
  open,
  onOpenChange,
  product,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  product: Product | null;
}) {
  const queryClient = useQueryClient();
  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const [unit, setUnit] = useState('UN');
  const [price, setPrice] = useState('');
  const [active, setActive] = useState(true);
  const [purchaseUnit, setPurchaseUnit] = useState('');
  const [purchaseFactor, setPurchaseFactor] = useState('');
  const [fiscal, setFiscal] = useState<FiscalForm>(() => fiscalToForm(undefined));
  const [pricingForm, setPricingForm] = useState<PricingForm>(emptyPricingForm);
  const [tab, setTab] = useState('geral');
  const pricing = useQuery({
    queryKey: ['product-pricing', product?.id],
    queryFn: () => api<{ pricing: ProductPricing }>(`/products/${product!.id}/pricing`).then((r) => r.pricing),
    enabled: open && Boolean(product),
  });
  // Produto novo ainda não tem custo nem histórico, mas mostra a margem padrão.
  const salesSettings = useQuery({
    queryKey: ['sales-settings'],
    queryFn: () => api<{ settings: SalesSettings }>('/sales-settings').then((r) => r.settings),
    enabled: open && !product,
  });
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setCode(product?.code ?? '');
    setName(product?.name ?? '');
    setUnit(product?.unit ?? 'UN');
    setPrice(product ? decimalToInput(product.price) : '');
    setActive(product?.active ?? true);
    setPurchaseUnit(product?.purchase_unit ?? '');
    setPurchaseFactor(product?.purchase_factor ? decimalToInput(product.purchase_factor) : '');
    setFiscal(fiscalToForm(product?.fiscal));
    setPricingForm(emptyPricingForm);
    setTab('geral');
    setError(null);
  }, [open, product]);

  useEffect(() => {
    if (open && pricing.data) setPricingForm(pricingToForm(pricing.data));
  }, [open, pricing.data]);

  const save = useMutation({
    mutationFn: async ({ body, pricingBody }: { body: object; pricingBody: object }) => {
      const result = product
        ? await api<{ product: Product }>(`/products/${product.id}`, { method: 'PUT', body })
        : await api<{ product: Product }>('/products', { method: 'POST', body });
      await api(`/products/${result.product.id}/pricing`, { method: 'PUT', body: pricingBody });
      return result;
    },
    onSuccess: ({ product: saved }) => {
      queryClient.invalidateQueries({ queryKey: ['products'] });
      queryClient.invalidateQueries({ queryKey: ['product-pricing', saved.id] });
      toast.success(product ? 'Produto atualizado.' : `${saved.name} cadastrado.`);
      onOpenChange(false);
    },
    onError: (err) => setError(err instanceof ApiError ? err.message : 'Não foi possível salvar.'),
  });

  function submit(event: FormEvent) {
    event.preventDefault();
    // Sem "required" nos campos: na aba escondida o navegador bloquearia o envio sem dizer por quê.
    if (name.trim().length < 2) {
      setTab('geral');
      return setError('Informe o nome do produto.');
    }
    const parsedPrice = parseDecimal(price);
    if (parsedPrice === null) {
      setTab('geral');
      return setError('Preço inválido. Exemplo: 38,90');
    }
    const factor = purchaseUnit.trim() ? parseDecimal(purchaseFactor) : null;
    if (purchaseUnit.trim() && (factor === null || factor <= 0)) {
      setTab('geral');
      return setError(`Informe quantos ${unit || 'UN'} vêm em cada ${purchaseUnit.trim().toUpperCase()}. Exemplo: 50`);
    }
    if (purchaseUnit.trim().toUpperCase() === unit.trim().toUpperCase()) {
      setTab('geral');
      return setError('A unidade de compra é a mesma da venda. Deixe em branco se não muda.');
    }
    const fiscalBody = fiscalToBody(fiscal);
    if ('invalid' in fiscalBody) {
      setTab('fiscal');
      return setError(`${RATE_LABELS[fiscalBody.invalid as keyof typeof RATE_LABELS]} inválida. Exemplo: 18 ou 1,65`);
    }
    const pricingBody = pricingToBody(pricingForm);
    if ('invalid' in pricingBody) {
      setTab('preco');
      return setError(pricingBody.invalid);
    }
    setError(null);
    save.mutate({
      body: {
        code,
        name,
        unit,
        price: Math.round(parsedPrice * 100) / 100,
        active,
        purchase: purchaseUnit.trim() ? { unit: purchaseUnit.trim(), factor } : null,
        fiscal: fiscalBody.body,
      },
      pricingBody: pricingBody.body,
    });
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>{product ? 'Editar produto' : 'Novo produto'}</DialogTitle>
          <DialogDescription>
            O preço vale para todas as lojas. Pedidos já lançados mantêm o preço da época.
            {product && (
              <>
                {' '}
                <Link to={`/registro-de-alteracoes?produto=${product.id}`} className="font-medium text-primary hover:underline">
                  Histórico de alterações
                </Link>
              </>
            )}
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="grid gap-4">
          {error && <Alert variant="danger" title={error} />}
          <Tabs value={tab} onValueChange={setTab}>
            <TabsList>
              <TabsTrigger value="geral">
                <Package />
                Dados gerais
              </TabsTrigger>
              <TabsTrigger value="fiscal">
                <Receipt />
                Fiscal
                {!fiscal.ncm && <span className="size-1.5 rounded-full bg-primary" aria-label="(sem NCM)" />}
              </TabsTrigger>
              <TabsTrigger value="preco">
                <Tags />
                Preço
              </TabsTrigger>
            </TabsList>

            <TabsContent value="geral" forceMount className="grid gap-4 data-[state=inactive]:hidden">
              <div className="grid gap-4 sm:grid-cols-[10rem_1fr]">
                <Field label="Código" htmlFor="produto-codigo" hint="Opcional">
                  <Input id="produto-codigo" value={code} onChange={(e) => setCode(e.target.value)} autoComplete="off" />
                </Field>
                <Field label="Nome" htmlFor="produto-nome">
                  <Input id="produto-nome" value={name} onChange={(e) => setName(e.target.value)} autoFocus />
                </Field>
              </div>
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label="Unidade" htmlFor="produto-unidade" hint="UN, SC, M², M³, KG...">
                  <Input
                    id="produto-unidade"
                    list="unidades"
                    value={unit}
                    onChange={(e) => setUnit(e.target.value.toUpperCase())}
                    maxLength={10}
                  />
                  <datalist id="unidades">
                    {UNITS.map((u) => (
                      <option key={u} value={u} />
                    ))}
                  </datalist>
                </Field>
                <Field label="Preço (R$)" htmlFor="produto-preco">
                  <Input
                    id="produto-preco"
                    value={price}
                    onChange={(e) => setPrice(e.target.value)}
                    inputMode="decimal"
                    placeholder="0,00"
                    className="text-right tabular-nums"
                  />
                </Field>
              </div>
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label="Unidade de compra" htmlFor="produto-unidade-compra" hint="Só se compra numa unidade e vende em outra. Ex.: SC">
                  <Input
                    id="produto-unidade-compra"
                    list="unidades"
                    value={purchaseUnit}
                    onChange={(e) => setPurchaseUnit(e.target.value.toUpperCase())}
                    maxLength={10}
                    placeholder="Igual à venda"
                  />
                </Field>
                {purchaseUnit.trim() && (
                  <Field
                    label={`${unit || 'UN'} em cada ${purchaseUnit.trim()}`}
                    htmlFor="produto-fator-compra"
                    hint={`A nota e o pedido de compra em ${purchaseUnit.trim()} viram ${unit || 'UN'} no estoque.`}
                  >
                    <Input
                      id="produto-fator-compra"
                      inputMode="decimal"
                      value={purchaseFactor}
                      onChange={(e) => setPurchaseFactor(e.target.value)}
                      placeholder="50"
                      className="text-right tabular-nums"
                    />
                  </Field>
                )}
              </div>
              <label className="flex items-center gap-2 text-sm">
                <Checkbox checked={active} onChange={(e) => setActive(e.target.checked)} />
                Ativo (aparece na busca do pedido)
              </label>
            </TabsContent>

            <TabsContent value="fiscal" forceMount className="data-[state=inactive]:hidden">
              {open && <ProductFiscalFields value={fiscal} onChange={setFiscal} />}
            </TabsContent>

            <TabsContent value="preco" forceMount className="data-[state=inactive]:hidden">
              <ProductPricingTab
                value={pricingForm}
                onChange={setPricingForm}
                pricing={
                  pricing.data ??
                  (salesSettings.data
                    ? { id: 0, price: 0, cost_price: null, markup_percent: null, default_markup_percent: salesSettings.data.default_markup_percent, tiers: [], history: [] }
                    : undefined)
                }
                unit={unit || 'UN'}
                onUseSuggested={(value) => {
                  setPrice(moneyToInput(value));
                  setTab('geral');
                  toast.success('Preço sugerido no campo Preço. Salve para gravar.');
                }}
              />
            </TabsContent>
          </Tabs>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancelar
            </Button>
            <Button type="submit" loading={save.isPending}>
              {product ? 'Salvar produto' : 'Cadastrar produto'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function ProductsPage() {
  useDocumentTitle('Produtos');
  const user = useUser();
  const isAdmin = user.role === 'admin';
  const queryClient = useQueryClient();
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState<'active' | 'inactive' | 'all'>('active');
  const [page, setPage] = useState(1);
  const [editing, setEditing] = useState<{ open: boolean; product: Product | null }>({ open: false, product: null });
  const [deleting, setDeleting] = useState<Product | null>(null);
  const [adjusting, setAdjusting] = useState(false);
  const q = useDebouncedValue(search.trim(), 300);

  const products = useQuery({
    queryKey: ['products', 'list', q, status, page],
    queryFn: () => api<Paginated<Product>>(`/products${toQuery({ q, status, page, page_size: PAGE_SIZE })}`),
    placeholderData: keepPreviousData,
  });

  const remove = useMutation({
    mutationFn: (product: Product) => api<void>(`/products/${product.id}`, { method: 'DELETE' }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['products'] });
      toast.success('Produto excluído.');
      setDeleting(null);
    },
    onError: (err) => {
      toast.error(err instanceof ApiError ? err.message : 'Não foi possível excluir.');
      setDeleting(null);
    },
  });

  const data = products.data;

  return (
    <div>
      <PageHeader
        title="Produtos"
        description={isAdmin ? 'Catálogo único da rede.' : 'Consulta de preços do catálogo.'}
        actions={
          isAdmin && (
            <>
              <Button variant="outline" onClick={() => setAdjusting(true)}>
                <Percent />
                Reajustar preços
              </Button>
              <Button onClick={() => setEditing({ open: true, product: null })}>
                <Plus />
                Novo produto
              </Button>
            </>
          )
        }
      />

      <Card>
        <div className="flex flex-wrap gap-3 border-b border-border p-4">
          <div className="relative max-w-md min-w-56 flex-1">
            <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              aria-label="Buscar produto"
              placeholder="Buscar por nome ou código"
              value={search}
              onChange={(e) => {
                setSearch(e.target.value);
                setPage(1);
              }}
              className="pl-9"
            />
          </div>
          {isAdmin && (
            <NativeSelect
              aria-label="Situação"
              value={status}
              onChange={(e) => {
                setStatus(e.target.value as typeof status);
                setPage(1);
              }}
              className="w-44"
            >
              <option value="active">Ativos</option>
              <option value="inactive">Inativos</option>
              <option value="all">Todos</option>
            </NativeSelect>
          )}
        </div>

        {products.isPending ? (
          <div className="grid gap-2 p-4">
            {Array.from({ length: 8 }, (_, i) => (
              <Skeleton key={i} className="h-10" />
            ))}
          </div>
        ) : !data || data.items.length === 0 ? (
          <EmptyState
            title={q ? 'Nenhum produto encontrado' : 'Nenhum produto cadastrado'}
            description={q ? 'Tente outro nome ou código.' : isAdmin ? 'Cadastre os produtos para lançar pedidos.' : 'Peça ao administrador para cadastrar o catálogo.'}
            action={
              isAdmin && !q ? (
                <Button onClick={() => setEditing({ open: true, product: null })}>
                  <Plus />
                  Novo produto
                </Button>
              ) : undefined
            }
          />
        ) : (
          <>
            <Table>
              <THead>
                <TR>
                  <TH className="pl-4">Código</TH>
                  <TH>Produto</TH>
                  <TH className="text-center">Unidade</TH>
                  <TH className="text-right">Preço</TH>
                  {isAdmin && <TH>NCM</TH>}
                  {isAdmin && <TH>Situação</TH>}
                  {isAdmin && (
                    <TH className="pr-4">
                      <span className="sr-only">Ações</span>
                    </TH>
                  )}
                </TR>
              </THead>
              <TBody>
                {data.items.map((product) => (
                  <TR key={product.id} className={cn(!product.active && 'text-muted-foreground')}>
                    <TD className="pl-4 tabular-nums">{product.code ?? '-'}</TD>
                    <TD className="font-medium">{product.name}</TD>
                    <TD className="text-center">{product.unit}</TD>
                    <TD className="text-right font-semibold tabular-nums">{formatMoney(product.price)}</TD>
                    {isAdmin && (
                      <TD className="tabular-nums">
                        {product.fiscal.ncm ? (
                          product.fiscal.ncm.replace(/^(\d{4})(\d{2})(\d{2})$/, '$1.$2.$3')
                        ) : (
                          <Badge variant="quote" title="Complete a aba Fiscal para emitir nota com este produto">
                            Sem NCM
                          </Badge>
                        )}
                      </TD>
                    )}
                    {isAdmin && (
                      <TD>
                        <Badge variant={product.active ? 'success' : 'neutral'}>{product.active ? 'Ativo' : 'Inativo'}</Badge>
                      </TD>
                    )}
                    {isAdmin && (
                      <TD className="pr-4">
                        <div className="flex justify-end gap-1">
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => setEditing({ open: true, product })}
                            aria-label={`Editar ${product.name}`}
                          >
                            <Pencil />
                            Editar
                          </Button>
                          <Button
                            variant="destructive-ghost"
                            size="icon"
                            className="size-8"
                            onClick={() => setDeleting(product)}
                            aria-label={`Excluir ${product.name}`}
                          >
                            <Trash2 />
                          </Button>
                        </div>
                      </TD>
                    )}
                  </TR>
                ))}
              </TBody>
            </Table>
            <Pagination page={page} pageSize={PAGE_SIZE} total={data.total} onPageChange={setPage} />
          </>
        )}
      </Card>

      {isAdmin && (
        <>
          <ProductFormDialog
            open={editing.open}
            onOpenChange={(open) => setEditing((current) => ({ ...current, open }))}
            product={editing.product}
          />
          <ConfirmDialog
            open={deleting !== null}
            onOpenChange={(open) => !open && setDeleting(null)}
            title={`Excluir ${deleting?.name}?`}
            description="Produtos que já aparecem em pedidos não podem ser excluídos; nesse caso, desative-os."
            confirmLabel="Excluir produto"
            destructive
            loading={remove.isPending}
            onConfirm={() => deleting && remove.mutate(deleting)}
          />
        </>
      )}
      {adjusting && <PriceAdjustDialog search={q} onClose={() => setAdjusting(false)} />}
    </div>
  );
}
