import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Link, useBlocker, useNavigate, useParams } from 'react-router';
import { toast } from 'sonner';
import { CartTable, type CartItem } from '@/components/pdv/CartTable';
import { ClientPicker, type ClientPickerHandle } from '@/components/pdv/ClientPicker';
import { ProductSearch, type ProductSearchHandle } from '@/components/pdv/ProductSearch';
import { EmptyState, PageHeader, PriceTag } from '@/components/shared';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { ConfirmDialog } from '@/components/ui/dialog';
import { Field, NativeSelect, Textarea } from '@/components/ui/input';
import { Kbd, Spinner } from '@/components/ui/misc';
import { api, ApiError } from '@/lib/api';
import { useUser } from '@/lib/auth';
import { formatOrderNumber, lineTotalCents } from '@/lib/format';
import { useDocumentTitle, useHotkeys } from '@/lib/hooks';
import type { Client, Order, OrderStatus, Product, Store } from '@/lib/types';
import { cn } from '@/lib/utils';

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
  const [storeId, setStoreId] = useState<number | null>(user.store_id);
  const [errors, setErrors] = useState<{ client?: string; items?: string; store?: string }>({});
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
    setStoreId(order.store_id);
  }, [existing.data]);

  // Admin sem loja padrão começa na primeira loja da lista.
  useEffect(() => {
    if (isAdmin && storeId === null && stores.data?.[0]) setStoreId(stores.data[0].id);
  }, [isAdmin, storeId, stores.data]);

  // Foco inicial: cliente num lançamento novo.
  useEffect(() => {
    if (editingId === null) clientPicker.current?.focus();
  }, [editingId]);

  const totalCents = items.reduce((sum, item) => sum + lineTotalCents(item.unit_price, item.quantity), 0);

  const save = useMutation({
    mutationFn: () => {
      const body = {
        client_id: client!.id,
        status,
        notes,
        store_id: isAdmin ? storeId : undefined,
        items: items.map((i) => ({ product_id: i.product_id, quantity: i.quantity })),
      };
      return editingId
        ? api<{ order: Order }>(`/orders/${editingId}`, { method: 'PUT', body })
        : api<{ order: Order }>('/orders', { method: 'POST', body });
    },
    onSuccess: ({ order }) => {
      leaving.current = true;
      queryClient.setQueryData(['order', order.id], order);
      queryClient.invalidateQueries({ queryKey: ['orders'] });
      queryClient.invalidateQueries({ queryKey: ['dashboard'] });
      // A tela de detalhe confirma o salvamento e oferece o envio por WhatsApp.
      navigate(`/pedidos/${order.id}`, { state: { justSaved: true } });
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : 'Não foi possível salvar.'),
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
          unit_price: product.price,
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
    save.mutate();
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
              <ProductSearch ref={productSearch} onAdd={addProduct} invalid={Boolean(errors.items)} />
              {errors.items && <p className="mt-2 text-[13px] text-destructive">{errors.items}</p>}
            </CardContent>
            <CartTable
              items={items}
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

              <Field label="Observações" htmlFor="observacoes" hint="Sai no PDF enviado ao cliente.">
                <Textarea
                  id="observacoes"
                  value={notes}
                  maxLength={1000}
                  onChange={(e) => {
                    setNotes(e.target.value);
                    changed();
                  }}
                  placeholder="Entrega, prazo, forma de pagamento..."
                />
              </Field>
            </CardContent>
          </Card>

          <PriceTag
            cents={totalCents}
            caption={items.length > 0 ? `${items.length} ${items.length === 1 ? 'item' : 'itens'}` : undefined}
          />

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
