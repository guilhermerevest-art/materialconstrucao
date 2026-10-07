import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Pencil, Plus, Search, Trash2 } from 'lucide-react';
import { useEffect, useState, type FormEvent } from 'react';
import { toast } from 'sonner';
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
import { Checkbox, Field, Input, NativeSelect } from '@/components/ui/input';
import { Alert, Badge, Skeleton } from '@/components/ui/misc';
import { Table, TBody, TD, TH, THead, TR } from '@/components/ui/table';
import { api, ApiError, toQuery } from '@/lib/api';
import { useUser } from '@/lib/auth';
import { decimalToInput, formatMoney, parseDecimal } from '@/lib/format';
import { useDebouncedValue, useDocumentTitle } from '@/lib/hooks';
import type { Paginated, Product } from '@/lib/types';
import { cn } from '@/lib/utils';

const PAGE_SIZE = 25;
const UNITS = ['UN', 'PC', 'CX', 'SC', 'KG', 'TON', 'M', 'M²', 'M³', 'L', 'LT', 'BR', 'RL', 'PAR', 'JG'];

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
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setCode(product?.code ?? '');
    setName(product?.name ?? '');
    setUnit(product?.unit ?? 'UN');
    setPrice(product ? decimalToInput(product.price) : '');
    setActive(product?.active ?? true);
    setError(null);
  }, [open, product]);

  const save = useMutation({
    mutationFn: (body: object) =>
      product
        ? api<{ product: Product }>(`/products/${product.id}`, { method: 'PUT', body })
        : api<{ product: Product }>('/products', { method: 'POST', body }),
    onSuccess: ({ product: saved }) => {
      queryClient.invalidateQueries({ queryKey: ['products'] });
      toast.success(product ? 'Produto atualizado.' : `${saved.name} cadastrado.`);
      onOpenChange(false);
    },
    onError: (err) => setError(err instanceof ApiError ? err.message : 'Não foi possível salvar.'),
  });

  function submit(event: FormEvent) {
    event.preventDefault();
    const parsedPrice = parseDecimal(price);
    if (parsedPrice === null) return setError('Preço inválido. Exemplo: 38,90');
    setError(null);
    save.mutate({ code, name, unit, price: Math.round(parsedPrice * 100) / 100, active });
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{product ? 'Editar produto' : 'Novo produto'}</DialogTitle>
          <DialogDescription>O preço vale para todas as lojas. Pedidos já lançados mantêm o preço da época.</DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="grid gap-4">
          {error && <Alert variant="danger" title={error} />}
          <div className="grid gap-4 sm:grid-cols-[10rem_1fr]">
            <Field label="Código" htmlFor="produto-codigo" hint="Opcional">
              <Input id="produto-codigo" value={code} onChange={(e) => setCode(e.target.value)} autoComplete="off" />
            </Field>
            <Field label="Nome" htmlFor="produto-nome">
              <Input id="produto-nome" value={name} onChange={(e) => setName(e.target.value)} required autoFocus />
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
                required
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
                required
              />
            </Field>
          </div>
          <label className="flex items-center gap-2 text-sm">
            <Checkbox checked={active} onChange={(e) => setActive(e.target.checked)} />
            Ativo (aparece na busca do pedido)
          </label>
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
            <Button onClick={() => setEditing({ open: true, product: null })}>
              <Plus />
              Novo produto
            </Button>
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
    </div>
  );
}
