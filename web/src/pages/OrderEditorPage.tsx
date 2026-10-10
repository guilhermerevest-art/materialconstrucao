import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, Plus } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Link, useBlocker, useNavigate, useParams, useSearchParams } from 'react-router';
import { toast } from 'sonner';
import { ClientSitesDialog, siteDeliveryAddress, useClientSites } from '@/components/ClientSitesDialog';
import { CartTable, type CartItem } from '@/components/pdv/CartTable';
import { FiadoPdvHint } from '@/components/fiado/FiadoPdvHint';
import { ClientPicker, type ClientPickerHandle } from '@/components/pdv/ClientPicker';
import { DiscountApprovalDialog, type DiscountApprovalRequest } from '@/components/pdv/DiscountApprovalDialog';
import { ProductSearch, type ProductSearchHandle } from '@/components/pdv/ProductSearch';
import { DiscountBreakdown, EmptyState, PageHeader, PriceTag } from '@/components/shared';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { ConfirmDialog } from '@/components/ui/dialog';
import { Field, Input, NativeSelect, Textarea } from '@/components/ui/input';
import { Kbd, Spinner } from '@/components/ui/misc';
import { api, ApiError } from '@/lib/api';
import { useUser } from '@/lib/auth';
import {
  centsToMoney,
  decimalToInput,
  discountCents,
  formatMoney,
  formatOrderNumber,
  formatPercent,
  formatQuantity,
  lineTotalCents,
  moneyToInput,
  parseDecimal,
} from '@/lib/format';
import { useDebouncedValue, useDocumentTitle, useHotkeys } from '@/lib/hooks';
import type { Client, DiscountType, Order, OrderStatus, PaymentMethod, PricePreview, Product, Store } from '@/lib/types';
import { cn } from '@/lib/utils';

const DISCOUNT_TYPES: { value: DiscountType; label: string }[] = [
  { value: 'percent', label: '%' },
  { value: 'amount', label: 'R$' },
];

const STATUS_OPTIONS: { value: OrderStatus; label: string; hint: string }[] = [
  { value: 'quote', label: 'Orçamento', hint: 'Proposta de preço' },
  { value: 'order', label: 'Pedido', hint: 'Venda confirmada' },
];

/** Ignora atalhos enquanto um diálogo estiver aberto. */
const dialogOpen = () => Boolean(document.querySelector('[role="dialog"], [role="alertdialog"]'));

/** PDV: lançamento e edição de orçamento/pedido. */
export function OrderEditorPage() {
  const params = useParams();
  const editingId = params.id ? Number(params.id) : null;
  const user = useUser();
  const isAdmin = user.role === 'admin';
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const clientPicker = useRef<ClientPickerHandle>(null);
  const productSearch = useRef<ProductSearchHandle>(null);

  const [client, setClient] = useState<Client | null>(null);
  const [items, setItems] = useState<CartItem[]>([]);
  const [status, setStatus] = useState<OrderStatus>('quote');
  const [notes, setNotes] = useState('');
  const [paymentMethodId, setPaymentMethodId] = useState<number | null>(null);
  const [deliveryAddress, setDeliveryAddress] = useState('');
  const [clientSiteId, setClientSiteId] = useState<number | null>(null);
  const [sitesOpen, setSitesOpen] = useState(false);
  const [discountType, setDiscountType] = useState<DiscountType>('percent');
  const [discountText, setDiscountText] = useState('');
  const [storeId, setStoreId] = useState<number | null>(user.store_id);
  const [errors, setErrors] = useState<{ client?: string; items?: string; store?: string }>({});
  const [creditText, setCreditText] = useState('');
  const [searchParams] = useSearchParams();
  const [approval, setApproval] = useState<DiscountApprovalRequest | null>(null);
  const [approvalError, setApprovalError] = useState<string | null>(null);
  const dirty = useRef(false);
  const leaving = useRef(false);

  useDocumentTitle(editingId ? `Editar ${formatOrderNumber(editingId)}` : 'Novo pedido');

  const existing = useQuery({
    queryKey: ['order', editingId],
    queryFn: () => api<{ order: Order }>(`/orders/${editingId}`).then((r) => r.order),
    enabled: editingId !== null,
  });

  const stores = useQuery({
    queryKey: ['stores'],
    queryFn: () => api<{ items: Store[] }>('/stores').then((r) => r.items),
    enabled: isAdmin,
  });

  const paymentMethods = useQuery({
    queryKey: ['payment-methods'],
    queryFn: () => api<{ items: PaymentMethod[] }>('/payment-methods').then((r) => r.items),
  });
  // Desativadas saem da lista, menos a que o orçamento já tinha.
  const paymentOptions = paymentMethods.data?.filter((m) => m.active || m.id === existing.data?.payment_method_id) ?? [];

  // Preenche o formulário uma única vez ao abrir um orçamento para edição.
  const loaded = useRef(false);
  useEffect(() => {
    const order = existing.data;
    if (!order || loaded.current) return;
    loaded.current = true;
    setClient({ id: order.client_id, name: order.client_name, whatsapp: order.client_whatsapp, created_at: order.created_at });
    setItems(
      order.items.map((i) => ({
        product_id: i.product_id,
        code: i.product_code,
        name: i.product_name,
        unit: i.unit,
        unit_price: i.unit_price,
        quantity: i.quantity,
      })),
    );
    setStatus(order.status);
    setNotes(order.notes ?? '');
    setPaymentMethodId(order.payment_method_id);
    setDeliveryAddress(order.delivery_address ?? '');
    setClientSiteId(order.client_site_id);
    setCreditText(order.credit_used ? moneyToInput(order.credit_used) : '');
    setDiscountType(order.discount_type ?? 'percent');
    setDiscountText(order.discount_value ? decimalToInput(order.discount_value) : '');
    setStoreId(order.store_id);
  }, [existing.data]);

  // Pedido novo vindo de uma troca (?cliente=ID): já abre com o cliente escolhido.
  const presetClientId = editingId === null ? Number(searchParams.get('cliente')) || null : null;
  const presetClient = useQuery({
    queryKey: ['client', presetClientId],
    queryFn: () => api<{ client: Client }>(`/clients/${presetClientId}`).then((r) => r.client),
    enabled: presetClientId !== null,
  });
  useEffect(() => {
    if (presetClient.data && !client) setClient(presetClient.data);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [presetClient.data]);

  // Crédito do cliente (vale-troca de uma devolução) para usar neste pedido.
  const credits = useQuery({
    queryKey: ['client-credits', client?.id],
    queryFn: () => api<{ balance: number }>(`/clients/${client!.id}/credits`).then((r) => r.balance),
    enabled: Boolean(client),
  });
  const creditAvailable = (credits.data ?? 0) + (editingId && existing.data?.client_id === client?.id ? (existing.data?.credit_used ?? 0) : 0);

  const sites = useClientSites(client?.id);
  // Obras encerradas saem da lista, menos a que o orçamento já tinha.
  const siteOptions = sites.data?.filter((site) => site.active || site.id === clientSiteId) ?? [];

  // Admin sem loja padrão começa na primeira loja da lista.
  useEffect(() => {
    if (isAdmin && storeId === null && stores.data?.[0]) setStoreId(stores.data[0].id);
  }, [isAdmin, storeId, stores.data]);

  // Foco inicial: cliente num lançamento novo.
  useEffect(() => {
    if (editingId === null) clientPicker.current?.focus();
  }, [editingId]);

  // Preço que cada item vai ter ao salvar (tabela do cliente, faixa, preço do orçamento): o
  // servidor calcula, a tela só mostra. Espera a digitação da quantidade parar.
  const previewKey = useDebouncedValue(
    JSON.stringify({ client: client?.id ?? null, items: items.map((i) => [i.product_id, i.quantity]) }),
    250,
  );
  const preview = useQuery({
    queryKey: ['price-preview', editingId, previewKey],
    queryFn: () => {
      const key = JSON.parse(previewKey) as { client: number | null; items: [number, number][] };
      return api<PricePreview>('/orders/price-preview', {
        method: 'POST',
        body: {
          client_id: key.client,
          order_id: editingId,
          items: key.items.map(([product_id, quantity]) => ({ product_id, quantity })),
        },
      });
    },
    enabled: items.length > 0,
    placeholderData: keepPreviousData,
  });
  const priceList = preview.data?.price_list ?? null;
  const previewById = new Map(preview.data?.items.map((p) => [p.product_id, p]) ?? []);
  const pricedItems: CartItem[] = items.map((item) => {
    const p = previewById.get(item.product_id);
    if (!p) return item;
    return {
      ...item,
      unit_price: p.unit_price,
      price_note: p.kept_previous
        ? 'Preço do orçamento'
        : p.source === 'list'
          ? `Tabela ${priceList?.name ?? ''}`.trim()
          : p.source === 'tier'
            ? 'Preço por quantidade'
            : null,
      tier_hint: p.next_tier
        ? `A partir de ${formatQuantity(p.next_tier.min_quantity)} ${item.unit}: ${formatMoney(p.next_tier.price)}`
        : null,
    };
  });
  const subtotalCents = pricedItems.reduce((sum, item) => sum + lineTotalCents(item.unit_price, item.quantity), 0);
  // Campo vazio = sem desconto. O servidor recalcula; aqui é só a prévia.
  const discountValue = discountText.trim() ? parseDecimal(discountText) : null;
  const discountError =
    discountText.trim() && (discountValue === null || discountValue <= 0)
      ? 'Digite um número maior que zero.'
      : discountType === 'percent' && discountValue !== null && discountValue > 100
        ? 'O desconto não pode passar de 100%.'
        : discountType === 'amount' && discountValue !== null && Math.round(discountValue * 100) > subtotalCents
          ? `O desconto não pode passar de ${centsToMoney(subtotalCents)}.`
          : null;
  const appliedDiscountCents = discountValue && !discountError ? discountCents(subtotalCents, discountType, discountValue) : 0;
  const totalCents = subtotalCents - appliedDiscountCents;
  const creditValue = creditText.trim() ? parseDecimal(creditText) : 0;
  const creditError =
    creditValue === null || creditValue < 0
      ? 'Valor inválido.'
      : Math.round(creditValue * 100) > totalCents
        ? 'Passa do total do pedido.'
        : creditValue > creditAvailable + 0.005
          ? `O cliente tem ${formatMoney(creditAvailable)} de crédito.`
          : null;
  const creditCents = creditError || !creditValue ? 0 : Math.round(creditValue * 100);

  const save = useMutation({
    mutationFn: (discountApproval?: { username: string; password: string }) => {
      const body = {
        client_id: client!.id,
        status,
        notes,
        payment_method_id: paymentMethodId,
        delivery_address: deliveryAddress,
        client_site_id: clientSiteId,
        discount_type: discountValue ? discountType : null,
        discount_value: discountValue,
        store_id: isAdmin ? storeId : undefined,
        items: items.map((i) => ({ product_id: i.product_id, quantity: i.quantity })),
        discount_approval: discountApproval,
        credit_used: creditCents / 100,
      };
      return editingId
        ? api<{ order: Order }>(`/orders/${editingId}`, { method: 'PUT', body })
        : api<{ order: Order }>('/orders', { method: 'POST', body });
    },
    onSuccess: ({ order }) => {
      leaving.current = true;
      setApproval(null);
      queryClient.setQueryData(['order', order.id], order);
      queryClient.invalidateQueries({ queryKey: ['orders'] });
      // Venda no fiado ou no crediário mexe na conta do cliente.
      queryClient.invalidateQueries({ queryKey: ['fiado'] });
      queryClient.invalidateQueries({ queryKey: ['client-credit'] });
      queryClient.invalidateQueries({ queryKey: ['dashboard'] });
      // A tela de detalhe confirma o salvamento e oferece o envio por WhatsApp.
      navigate(`/pedidos/${order.id}`, { state: { justSaved: true } });
    },
    onError: (err) => {
      // Desconto acima do limite: quem pode liberar digita a senha e o pedido sai na hora.
      if (err instanceof ApiError && err.code === 'DISCOUNT_APPROVAL_REQUIRED') {
        setApprovalError(null);
        setApproval({ limit: Number(err.body?.limit ?? 0), requested: Number(err.body?.requested ?? 0) });
        return;
      }
      if (err instanceof ApiError && err.code === 'DISCOUNT_APPROVAL_INVALID') {
        setApprovalError(err.message);
        return;
      }
      toast.error(err instanceof ApiError ? err.message : 'Não foi possível salvar.');
    },
  });

  // Aviso ao sair com o carrinho preenchido e não salvo.
  const blocker = useBlocker(
    ({ currentLocation, nextLocation }) =>
      dirty.current && !leaving.current && currentLocation.pathname !== nextLocation.pathname,
  );
  useEffect(() => {
    const listener = (event: BeforeUnloadEvent) => {
      if (dirty.current && !leaving.current) event.preventDefault();
    };
    window.addEventListener('beforeunload', listener);
    return () => window.removeEventListener('beforeunload', listener);
  }, []);

  function changed() {
    dirty.current = true;
  }

  function selectClient(next: Client) {
    // A obra é do cliente: trocar de cliente tira a obra (o endereço digitado fica).
    if (next.id !== client?.id) setClientSiteId(null);
    setClient(next);
    setErrors((e) => ({ ...e, client: undefined }));
    changed();
    setTimeout(() => productSearch.current?.focus(), 30);
  }

  function addProduct(product: Product, quantity: number) {
    setItems((current) => {
      const existingItem = current.find((i) => i.product_id === product.id);
      if (existingItem) {
        toast.info(`${product.name}: quantidade somada ao item que já estava no carrinho.`);
        return current.map((i) =>
          i.product_id === product.id ? { ...i, quantity: Math.round((i.quantity + quantity) * 1000) / 1000 } : i,
        );
      }
      return [
        ...current,
        {
          product_id: product.id,
          code: product.code,
          name: product.name,
          unit: product.unit,
          unit_price: product.client_price ?? product.price,
          quantity,
        },
      ];
    });
    setErrors((e) => ({ ...e, items: undefined }));
    changed();
  }

  function submit() {
    if (save.isPending) return;
    const pendingProduct = productSearch.current?.pendingProduct();
    if (pendingProduct) {
      toast.warning(`${pendingProduct.name} ainda não entrou no carrinho. Tecle Enter para adicionar ou Esc para cancelar.`);
      return;
    }
    const next: typeof errors = {};
    if (!client) next.client = 'Selecione o cliente.';
    if (items.length === 0) next.items = 'Adicione pelo menos um produto.';
    if (isAdmin && !storeId) next.store = 'Selecione a loja.';
    setErrors(next);
    if (next.client) return clientPicker.current?.focus();
    if (next.items) return productSearch.current?.focus();
    if (next.store) return;
    if (discountError) {
      toast.error(`Desconto: ${discountError}`);
      return document.getElementById('desconto')?.focus();
    }
    if (creditError && creditText.trim()) {
      toast.error(`Crédito do cliente: ${creditError}`);
      return document.getElementById('credito-usado')?.focus();
    }
    save.mutate(undefined);
  }

  useHotkeys({
    F2: () => !dialogOpen() && productSearch.current?.focus(),
    F4: () => !dialogOpen() && clientPicker.current?.focus(),
    F9: () => !dialogOpen() && submit(),
    'Ctrl+Enter': () => !dialogOpen() && submit(),
  });

  if (editingId !== null && existing.isPending) return <Spinner className="py-10" />;
  if (editingId !== null && (existing.isError || !existing.data)) {
    return (
      <EmptyState
        title="Orçamento não encontrado"
        description="Ele pode ter sido excluído ou pertencer a outra loja."
        action={
          <Button asChild variant="outline">
            <Link to="/pedidos">Voltar para pedidos</Link>
          </Button>
        }
      />
    );
  }
  if (existing.data?.status === 'order') {
    return (
      <EmptyState
        title="Pedido já confirmado"
        description="Pedidos confirmados não podem ser editados."
        action={
          <Button asChild variant="outline">
            <Link to={`/pedidos/${editingId}`}>Ver pedido</Link>
          </Button>
        }
      />
    );
  }

  const storeName = isAdmin ? stores.data?.find((s) => s.id === storeId)?.name : user.store_name;
  const saveLabel = `Salvar ${status === 'quote' ? 'orçamento' : 'pedido'}`;

  return (
    <div>
      <PageHeader
        title={editingId ? `Editar orçamento nº ${formatOrderNumber(editingId)}` : 'Novo pedido'}
        description={storeName ? `Lançando na ${storeName}` : undefined}
        actions={
          <div className="hidden items-center gap-4 text-[13px] text-muted-foreground xl:flex">
            <span className="flex items-center gap-1.5">
              <Kbd>F4</Kbd> cliente
            </span>
            <span className="flex items-center gap-1.5">
              <Kbd>F2</Kbd> produto
            </span>
            <span className="flex items-center gap-1.5">
              <Kbd>F9</Kbd> salvar
            </span>
          </div>
        }
      />

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,1fr)_340px] lg:items-start">
        <div className="grid min-w-0 gap-6">
          <Card>
            <CardHeader>
              <CardTitle>Cliente</CardTitle>
            </CardHeader>
            <CardContent>
              <ClientPicker ref={clientPicker} value={client} onChange={selectClient} invalid={Boolean(errors.client)} />
              {errors.client && <p className="mt-2 text-[13px] text-destructive">{errors.client}</p>}
              {client && priceList && (
                <p className="mt-2 text-[13px] font-medium text-success">Tabela de preço: {priceList.name}</p>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Produtos</CardTitle>
              {items.length > 0 && (
                <span className="text-sm text-muted-foreground">
                  {items.length} {items.length === 1 ? 'item' : 'itens'}
                </span>
              )}
            </CardHeader>
            <CardContent>
              <ProductSearch
                ref={productSearch}
                onAdd={addProduct}
                invalid={Boolean(errors.items)}
                storeId={storeId}
                clientId={client?.id ?? null}
              />
              {errors.items && <p className="mt-2 text-[13px] text-destructive">{errors.items}</p>}
            </CardContent>
            <CartTable
              items={pricedItems}
              onQuantityChange={(productId, quantity) => {
                setItems((current) => current.map((i) => (i.product_id === productId ? { ...i, quantity } : i)));
                changed();
              }}
              onRemove={(productId) => {
                setItems((current) => current.filter((i) => i.product_id !== productId));
                changed();
              }}
            />
          </Card>
        </div>

        <aside className="grid gap-4 lg:sticky lg:top-20">
          <Card>
            <CardContent className="grid gap-5 pt-5">
              <fieldset>
                <legend className="mb-2 text-sm font-medium">Tipo de documento</legend>
                <div className="grid grid-cols-2 gap-2">
                  {STATUS_OPTIONS.map((option) => (
                    <label
                      key={option.value}
                      className={cn(
                        'flex cursor-pointer flex-col rounded-md border px-3 py-2.5 has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-ring',
                        status === option.value
                          ? 'border-primary bg-primary-soft shadow-[inset_0_0_0_1px_var(--color-primary)]'
                          : 'border-input hover:bg-muted',
                      )}
                    >
                      <input
                        type="radio"
                        name="status"
                        value={option.value}
                        checked={status === option.value}
                        onChange={() => {
                          setStatus(option.value);
                          changed();
                        }}
                        className="sr-only"
                      />
                      <span className="text-sm font-semibold">{option.label}</span>
                      <span className="text-xs text-muted-foreground">{option.hint}</span>
                    </label>
                  ))}
                </div>
              </fieldset>

              {isAdmin && (
                <Field label="Loja" htmlFor="loja" error={errors.store}>
                  <NativeSelect
                    id="loja"
                    value={storeId ?? ''}
                    onChange={(e) => {
                      setStoreId(e.target.value ? Number(e.target.value) : null);
                      changed();
                    }}
                  >
                    {!storeId && <option value="">Selecione</option>}
                    {stores.data?.map((store) => (
                      <option key={store.id} value={store.id}>
                        {store.name}
                      </option>
                    ))}
                  </NativeSelect>
                </Field>
              )}

              <Field label="Forma de pagamento" htmlFor="forma-pagamento">
                <NativeSelect
                  id="forma-pagamento"
                  value={paymentMethodId ?? ''}
                  onChange={(e) => {
                    setPaymentMethodId(e.target.value ? Number(e.target.value) : null);
                    changed();
                  }}
                >
                  <option value="">Não informada</option>
                  {paymentOptions.map((method) => (
                    <option key={method.id} value={method.id}>
                      {method.name}
                    </option>
                  ))}
                </NativeSelect>
                {client && user.fiado_enabled && paymentOptions.find((m) => m.id === paymentMethodId)?.kind === 'fiado' && (
                  <FiadoPdvHint clientId={client.id} totalCents={totalCents - creditCents} />
                )}
              </Field>

              <Field
                label="Desconto"
                htmlFor="desconto"
                error={discountError}
                hint={
                  user.max_discount_percent != null
                    ? `Seu limite: ${formatPercent(user.max_discount_percent)}. Acima disso, alguém libera com a senha.`
                    : undefined
                }
              >
                <div className="flex gap-2">
                  <div className="flex shrink-0 rounded-md border border-input p-0.5" role="radiogroup" aria-label="Tipo de desconto">
                    {DISCOUNT_TYPES.map((option) => (
                      <button
                        key={option.value}
                        type="button"
                        role="radio"
                        aria-checked={discountType === option.value}
                        onClick={() => {
                          setDiscountType(option.value);
                          changed();
                        }}
                        className={cn(
                          'min-w-10 rounded px-2.5 text-sm font-semibold',
                          discountType === option.value ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:bg-muted',
                        )}
                      >
                        {option.label}
                      </button>
                    ))}
                  </div>
                  <Input
                    id="desconto"
                    inputMode="decimal"
                    autoComplete="off"
                    value={discountText}
                    onChange={(e) => {
                      setDiscountText(e.target.value);
                      changed();
                    }}
                    placeholder={discountType === 'percent' ? 'Ex.: 5' : 'Ex.: 20,00'}
                    aria-invalid={Boolean(discountError)}
                  />
                </div>
              </Field>

              {client && (
                <Field label="Obra" htmlFor="obra" hint="Escolher a obra preenche o endereço de entrega.">
                  <div className="flex gap-2">
                    <NativeSelect
                      id="obra"
                      className="flex-1"
                      value={clientSiteId ?? ''}
                      onChange={(e) => {
                        const site = siteOptions.find((s) => s.id === Number(e.target.value));
                        setClientSiteId(site ? site.id : null);
                        if (site) setDeliveryAddress(siteDeliveryAddress(site));
                        changed();
                      }}
                    >
                      <option value="">{siteOptions.length ? 'Nenhuma (digitar o endereço)' : 'Nenhuma obra cadastrada'}</option>
                      {siteOptions.map((site) => (
                        <option key={site.id} value={site.id}>
                          {site.name}
                        </option>
                      ))}
                    </NativeSelect>
                    <Button type="button" variant="outline" size="icon" className="size-10" onClick={() => setSitesOpen(true)} aria-label="Nova obra">
                      <Plus />
                    </Button>
                  </div>
                </Field>
              )}

              <Field label="Endereço de entrega" htmlFor="entrega" hint="Deixe em branco se o cliente retira na loja.">
                <Textarea
                  id="entrega"
                  value={deliveryAddress}
                  maxLength={300}
                  rows={3}
                  onChange={(e) => {
                    setDeliveryAddress(e.target.value);
                    changed();
                  }}
                  placeholder="Rua, número, bairro, cidade, referência"
                />
              </Field>

              <Field label="Observações" htmlFor="observacoes" hint="Sai no PDF enviado ao cliente.">
                <Textarea
                  id="observacoes"
                  value={notes}
                  maxLength={1000}
                  onChange={(e) => {
                    setNotes(e.target.value);
                    changed();
                  }}
                  placeholder="Entrega, prazo, condições..."
                />
              </Field>
            </CardContent>
          </Card>

          <DiscountBreakdown
            subtotalCents={subtotalCents}
            discountCents={appliedDiscountCents}
            discountLabel={discountType === 'percent' && discountValue ? `Desconto (${formatPercent(discountValue)})` : 'Desconto'}
          />
          <PriceTag
            cents={totalCents}
            caption={items.length > 0 ? `${items.length} ${items.length === 1 ? 'item' : 'itens'}` : undefined}
          />
          {client && creditAvailable > 0 && (
            <div className="grid gap-2 rounded-lg border border-success/40 bg-card px-5 py-3 text-sm">
              <p>
                {client.name} tem <strong className="text-success tabular-nums">{formatMoney(creditAvailable)}</strong> de crédito (troca).
              </p>
              <Field label="Usar neste pedido" htmlFor="credito-usado" error={creditText.trim() ? creditError : null}>
                <div className="flex gap-2">
                  <Input
                    id="credito-usado"
                    inputMode="decimal"
                    value={creditText}
                    onChange={(e) => {
                      setCreditText(e.target.value);
                      changed();
                    }}
                    placeholder="0,00"
                    className="text-right tabular-nums"
                  />
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => {
                      setCreditText(moneyToInput(Math.min(creditAvailable, totalCents / 100)));
                      changed();
                    }}
                  >
                    Usar tudo
                  </Button>
                </div>
              </Field>
              {creditCents > 0 && (
                <p className="flex justify-between font-semibold">
                  <span>A pagar</span>
                  <span className="tabular-nums">{centsToMoney(totalCents - creditCents)}</span>
                </p>
              )}
            </div>
          )}

          <Button size="lg" className="w-full" onClick={submit} loading={save.isPending}>
            {saveLabel}
            <Kbd className="ml-1 hidden border-white/30 bg-white/15 text-white shadow-none sm:inline-flex">F9</Kbd>
          </Button>
          <Button asChild variant="ghost" className="w-full">
            <Link to={editingId ? `/pedidos/${editingId}` : '/pedidos'}>
              <ArrowLeft />
              Voltar sem salvar
            </Link>
          </Button>
        </aside>
      </div>

      {client && (
        <ClientSitesDialog
          client={client}
          open={sitesOpen}
          onOpenChange={setSitesOpen}
          startNew
          onCreated={(site) => {
            setClientSiteId(site.id);
            setDeliveryAddress(siteDeliveryAddress(site));
            changed();
            setSitesOpen(false);
          }}
        />
      )}
      <DiscountApprovalDialog
        request={approval}
        error={approvalError}
        loading={save.isPending}
        onConfirm={(credentials) => save.mutate(credentials)}
        onCancel={() => {
          setApproval(null);
          document.getElementById('desconto')?.focus();
        }}
      />
      <ConfirmDialog
        open={blocker.state === 'blocked'}
        onOpenChange={(open) => !open && blocker.state === 'blocked' && blocker.reset()}
        title="Sair sem salvar?"
        description="O cliente e os produtos deste lançamento serão descartados."
        confirmLabel="Descartar e sair"
        cancelLabel="Continuar lançando"
        destructive
        onConfirm={() => blocker.state === 'blocked' && blocker.proceed()}
      />
    </div>
  );
}
