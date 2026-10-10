import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { Search, X } from 'lucide-react';
import { useId, useState, type KeyboardEvent } from 'react';
import { api, toQuery } from '@/lib/api';
import { useDebouncedValue } from '@/lib/hooks';
import type { Paginated, Product } from '@/lib/types';
import { cn } from '@/lib/utils';
import { Input } from './ui/input';

export type PickedProduct = Pick<Product, 'id' | 'code' | 'name' | 'unit'>;

/** Escolha de um produto do catálogo pelo nome ou código, com teclado ou mouse. */
export function ProductPicker({
  value,
  onChange,
  placeholder = 'Buscar produto',
  invalid,
  className,
  ariaLabel = 'Produto',
}: {
  value: PickedProduct | null;
  onChange: (product: PickedProduct | null) => void;
  placeholder?: string;
  invalid?: boolean;
  className?: string;
  ariaLabel?: string;
}) {
  const listId = useId();
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const term = useDebouncedValue(query.trim(), 200);
  const { data } = useQuery({
    queryKey: ['products', 'picker', term],
    queryFn: () => api<Paginated<Product>>(`/products${toQuery({ q: term, page_size: 8 })}`),
    enabled: term.length > 0,
    placeholderData: keepPreviousData,
  });
  const results = term ? (data?.items ?? []) : [];

  function pick(product: PickedProduct) {
    onChange(product);
    setQuery('');
    setOpen(false);
  }

  function onKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setActive((i) => Math.min(i + 1, results.length - 1));
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      setActive((i) => Math.max(i - 1, 0));
    } else if (event.key === 'Enter' && results[active]) {
      event.preventDefault();
      pick(results[active]);
    } else if (event.key === 'Escape') {
      setOpen(false);
    }
  }

  if (value) {
    return (
      <div
        className={cn(
          'flex h-10 min-w-0 items-center gap-2 rounded-md border border-input bg-card px-3 text-sm',
          className,
        )}
      >
        <span className="shrink-0 text-muted-foreground tabular-nums">{value.code ?? '-'}</span>
        <span className="min-w-0 flex-1 truncate font-medium" title={value.name}>
          {value.name}
        </span>
        <button
          type="button"
          className="rounded p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground"
          onClick={() => onChange(null)}
          aria-label={`Trocar ${value.name}`}
        >
          <X className="size-4" />
        </button>
      </div>
    );
  }

  return (
    <div className={cn('relative min-w-0', className)}>
      <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
      <Input
        role="combobox"
        aria-label={ariaLabel}
        aria-expanded={open && results.length > 0}
        aria-controls={listId}
        aria-invalid={invalid || undefined}
        className="pl-9"
        placeholder={placeholder}
        value={query}
        onChange={(e) => {
          setQuery(e.target.value);
          setOpen(true);
          setActive(0);
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => setTimeout(() => setOpen(false), 120)}
        onKeyDown={onKeyDown}
      />
      {open && results.length > 0 && (
        <ul
          id={listId}
          role="listbox"
          className="absolute top-full right-0 left-0 z-40 mt-1 max-h-72 overflow-y-auto rounded-md border border-border bg-card p-1 shadow-lg"
        >
          {results.map((product, index) => (
            <li
              key={product.id}
              role="option"
              aria-selected={index === active}
              onMouseDown={(e) => e.preventDefault()}
              onMouseEnter={() => setActive(index)}
              onClick={() => pick(product)}
              className={cn(
                'grid cursor-pointer grid-cols-[4.5rem_minmax(0,1fr)_2.5rem] items-center gap-2 rounded-sm px-2 py-1.5 text-sm',
                index === active && 'bg-muted',
              )}
            >
              <span className="truncate text-muted-foreground tabular-nums">{product.code ?? '-'}</span>
              <span className="truncate">{product.name}</span>
              <span className="text-center text-muted-foreground">{product.unit}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
