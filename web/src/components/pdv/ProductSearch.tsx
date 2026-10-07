import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { Loader2, Plus, Search, X } from 'lucide-react';
import { useEffect, useImperativeHandle, useLayoutEffect, useRef, useState, type KeyboardEvent, type Ref } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Kbd } from '@/components/ui/misc';
import { api, toQuery } from '@/lib/api';
import { formatMoney, parseDecimal } from '@/lib/format';
import { useDebouncedValue } from '@/lib/hooks';
import type { Paginated, Product } from '@/lib/types';
import { cn } from '@/lib/utils';

export type ProductSearchHandle = {
  focus: () => void;
  /** Produto escolhido aguardando a quantidade (ainda fora do carrinho). */
  pendingProduct: () => Product | null;
};

/**
 * Busca de produto (nome ou código) e quantidade antes de ir para o carrinho.
 * Fluxo de teclado: digita, Enter escolhe, digita a quantidade, Enter adiciona.
 * Leitor de código de barras funciona igual: o código exato é escolhido direto.
 */
export function ProductSearch({
  ref,
  onAdd,
  invalid,
}: {
  ref?: Ref<ProductSearchHandle>;
  onAdd: (product: Product, quantity: number) => void;
  invalid?: boolean;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const qtyRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const [pending, setPending] = useState<Product | null>(null);
  const [qtyText, setQtyText] = useState('1');
  const [qtyError, setQtyError] = useState(false);
  const term = useDebouncedValue(query.trim(), 150);

  // Busca e quantidade trocam de lugar na tela; o foco vai para o campo novo
  // depois que ele existe no DOM.
  const focusAfterRender = useRef<'search' | 'quantity' | null>(null);
  useLayoutEffect(() => {
    const target = focusAfterRender.current;
    if (!target) return;
    focusAfterRender.current = null;
    const element = target === 'quantity' ? qtyRef.current : inputRef.current;
    element?.focus();
    element?.select();
  }, [pending]);

  function showSearch() {
    if (pending) {
      focusAfterRender.current = 'search';
      setPending(null);
    } else {
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  }

  useImperativeHandle(ref, () => ({ focus: showSearch, pendingProduct: () => pending }));

  const { data, isFetching } = useQuery({
    queryKey: ['products', 'search', term],
    queryFn: () => api<Paginated<Product>>(`/products${toQuery({ q: term, page_size: 8 })}`),
    enabled: term.length > 0,
    placeholderData: keepPreviousData,
  });
  const results = term ? (data?.items ?? []) : [];
  const resultsReady = term === query.trim() && !isFetching;
  const listOpen = open && !pending && query.trim().length > 0;

  function pick(product: Product) {
    focusAfterRender.current = 'quantity';
    setPending(product);
    setOpen(false);
    setQtyText('1');
    setQtyError(false);
  }

  function chooseFromResults() {
    const text = query.trim().toLowerCase();
    const exact = results.find((p) => p.code?.toLowerCase() === text);
    const choice = exact ?? results[Math.min(active, results.length - 1)];
    if (choice) pick(choice);
  }

  const enterPending = useRef(false);
  useEffect(() => {
    if (enterPending.current && resultsReady) {
      enterPending.current = false;
      chooseFromResults();
    }
  });

  function cancelPending() {
    showSearch();
  }

  function confirmQuantity() {
    const quantity = parseDecimal(qtyText);
    if (!pending || quantity === null || quantity <= 0 || quantity > 999_999) {
      setQtyError(true);
      qtyRef.current?.select();
      return;
    }
    onAdd(pending, Math.round(quantity * 1000) / 1000);
    setQuery('');
    setActive(0);
    showSearch();
  }

  function onSearchKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setOpen(true);
      setActive((i) => Math.min(i + 1, Math.max(results.length - 1, 0)));
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      setActive((i) => Math.max(i - 1, 0));
    } else if (event.key === 'Enter') {
      event.preventDefault();
      if (!query.trim()) return;
      if (resultsReady) chooseFromResults();
      else enterPending.current = true;
    } else if (event.key === 'Escape') {
      setOpen(false);
    }
  }

  if (pending) {
    return (
      <div className="flex flex-wrap items-center gap-3 rounded-md border border-primary bg-primary-soft/60 p-2 pl-3">
        <div className="min-w-0 flex-1 basis-56">
          <p className="truncate font-semibold">{pending.name}</p>
          <p className="text-[13px] text-muted-foreground tabular-nums">
            {pending.code && <span className="mr-2">{pending.code}</span>}
            {formatMoney(pending.price)} / {pending.unit}
          </p>
        </div>
        <label className="flex items-center gap-2 text-sm font-medium">
          Qtd.
          <Input
            ref={qtyRef}
            aria-label="Quantidade"
            value={qtyText}
            onChange={(e) => {
              setQtyText(e.target.value);
              setQtyError(false);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                confirmQuantity();
              } else if (e.key === 'Escape') {
                e.preventDefault();
                cancelPending();
              }
            }}
            inputMode="decimal"
            autoComplete="off"
            aria-invalid={qtyError || undefined}
            className="h-11 w-28 text-right text-base font-semibold tabular-nums"
          />
          <span className="w-8 text-muted-foreground">{pending.unit}</span>
        </label>
        <Button size="lg" onClick={confirmQuantity} className="h-11">
          <Plus />
          Adicionar
        </Button>
        <Button variant="ghost" size="icon" onClick={cancelPending} aria-label="Cancelar produto">
          <X />
        </Button>
        {qtyError && (
          <p className="w-full text-[13px] text-destructive">Informe uma quantidade maior que zero. Use vírgula para decimais.</p>
        )}
      </div>
    );
  }

  return (
    <div className="relative">
      <Search className="pointer-events-none absolute top-1/2 left-3.5 size-5 -translate-y-1/2 text-muted-foreground" />
      <Input
        ref={inputRef}
        role="combobox"
        aria-label="Buscar produto"
        aria-expanded={listOpen}
        aria-controls="produtos-resultados"
        aria-activedescendant={listOpen && results.length ? `produto-opcao-${active}` : undefined}
        aria-invalid={invalid || undefined}
        autoComplete="off"
        className="h-12 pl-11 text-base sm:pr-16"
        placeholder="Buscar por nome ou código"
        value={query}
        onChange={(e) => {
          setQuery(e.target.value);
          setOpen(true);
          setActive(0);
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => setTimeout(() => setOpen(false), 120)}
        onKeyDown={onSearchKeyDown}
      />
      <span className="pointer-events-none absolute top-1/2 right-3 flex -translate-y-1/2 items-center gap-2">
        {isFetching && <Loader2 className="size-4 animate-spin text-muted-foreground" aria-hidden />}
        <Kbd className="hidden sm:inline-flex">F2</Kbd>
      </span>

      {listOpen && (
        <ul
          id="produtos-resultados"
          role="listbox"
          className="absolute top-full right-0 left-0 z-30 mt-1 max-h-96 overflow-y-auto rounded-md border border-border bg-card p-1 shadow-lg"
        >
          {resultsReady && results.length === 0 && (
            <li className="px-3 py-2.5 text-sm text-muted-foreground">Nenhum produto ativo com esse nome ou código.</li>
          )}
          {results.map((product, index) => (
            <li
              key={product.id}
              id={`produto-opcao-${index}`}
              role="option"
              aria-selected={index === active}
              onMouseDown={(e) => e.preventDefault()}
              onMouseEnter={() => setActive(index)}
              onClick={() => pick(product)}
              className={cn(
                'grid cursor-pointer grid-cols-[5.5rem_minmax(0,1fr)_3rem_auto] items-center gap-3 rounded-sm px-3 py-2 text-sm',
                index === active && 'bg-muted',
              )}
            >
              <span className="truncate text-muted-foreground tabular-nums">{product.code ?? '-'}</span>
              <span className="truncate font-medium">{product.name}</span>
              <span className="text-center text-muted-foreground">{product.unit}</span>
              <span className="text-right font-semibold tabular-nums">{formatMoney(product.price)}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
