import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { Loader2, Search, UserPlus } from 'lucide-react';
import { useEffect, useImperativeHandle, useLayoutEffect, useRef, useState, type KeyboardEvent, type Ref } from 'react';
import { ClientFormDialog } from '@/components/ClientFormDialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Kbd } from '@/components/ui/misc';
import { api, toQuery } from '@/lib/api';
import { formatWhatsapp, initials } from '@/lib/format';
import { useDebouncedValue } from '@/lib/hooks';
import type { Client, Paginated } from '@/lib/types';
import { cn } from '@/lib/utils';

export type ClientPickerHandle = { focus: () => void };

type Option = { kind: 'client'; client: Client } | { kind: 'new' };

/** Busca de cliente por nome ou WhatsApp, com cadastro rápido. Teclado: setas, Enter e Esc. */
export function ClientPicker({
  ref,
  value,
  onChange,
  invalid,
}: {
  ref?: Ref<ClientPickerHandle>;
  value: Client | null;
  onChange: (client: Client) => void;
  invalid?: boolean;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [searching, setSearching] = useState(!value);
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const [dialog, setDialog] = useState<{ open: boolean; name?: string; whatsapp?: string }>({ open: false });
  const term = useDebouncedValue(query.trim(), 200);

  const showSearch = searching || !value;

  // O campo de busca só existe depois de sair do cartão do cliente escolhido.
  const focusAfterRender = useRef(false);
  useLayoutEffect(() => {
    if (focusAfterRender.current && showSearch) {
      focusAfterRender.current = false;
      inputRef.current?.focus();
    }
  }, [showSearch]);

  function startSearch() {
    if (showSearch) {
      inputRef.current?.focus();
    } else {
      focusAfterRender.current = true;
      setSearching(true);
    }
  }

  useImperativeHandle(ref, () => ({ focus: startSearch }));

  const { data, isFetching } = useQuery({
    queryKey: ['clients', 'search', term],
    queryFn: () => api<Paginated<Client>>(`/clients${toQuery({ q: term, page_size: 8 })}`),
    enabled: term.length > 0,
    placeholderData: keepPreviousData,
  });

  const results = term ? (data?.items ?? []) : [];
  const options: Option[] = [...results.map((client) => ({ kind: 'client' as const, client })), { kind: 'new' }];
  const listOpen = open && query.trim().length > 0;
  const resultsReady = term === query.trim() && !isFetching;

  // Enter antes de a busca terminar: escolhe assim que os resultados chegarem.
  const enterPending = useRef(false);
  useEffect(() => {
    if (enterPending.current && resultsReady) {
      enterPending.current = false;
      select(options[Math.min(active, options.length - 1)]!);
    }
  });

  function select(option: Option) {
    if (option.kind === 'new') {
      const text = query.trim();
      const looksLikePhone = /^[\d\s()+-]+$/.test(text) && text.replace(/\D/g, '').length >= 8;
      setDialog({ open: true, name: looksLikePhone ? '' : text, whatsapp: looksLikePhone ? text : '' });
      setOpen(false);
      return;
    }
    onChange(option.client);
    setQuery('');
    setOpen(false);
    setSearching(false);
  }

  function onKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setOpen(true);
      setActive((i) => Math.min(i + 1, options.length - 1));
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      setActive((i) => Math.max(i - 1, 0));
    } else if (event.key === 'Enter') {
      event.preventDefault();
      if (!query.trim()) return;
      if (resultsReady) select(options[Math.min(active, options.length - 1)]!);
      else enterPending.current = true;
    } else if (event.key === 'Escape') {
      if (listOpen) setOpen(false);
      else if (value) setSearching(false);
    }
  }

  return (
    <div>
      {!showSearch && value ? (
        <div className="flex items-center gap-3 rounded-md border border-border bg-background/60 px-3 py-2.5">
          <span className="grid size-10 shrink-0 place-items-center rounded-full bg-steel text-sm font-semibold text-white">
            {initials(value.name)}
          </span>
          <div className="min-w-0 flex-1">
            <p className="truncate font-semibold">{value.name}</p>
            <p className="text-sm text-muted-foreground tabular-nums">{formatWhatsapp(value.whatsapp)}</p>
          </div>
          <Button variant="outline" size="sm" onClick={startSearch}>
            Trocar
          </Button>
        </div>
      ) : (
        <div className="relative">
          <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            ref={inputRef}
            role="combobox"
            aria-label="Buscar cliente"
            aria-expanded={listOpen}
            aria-controls="clientes-resultados"
            aria-activedescendant={listOpen ? `cliente-opcao-${active}` : undefined}
            aria-invalid={invalid || undefined}
            autoComplete="off"
            className="h-11 pl-9 text-[15px] sm:pr-14"
            placeholder="Buscar por nome ou WhatsApp"
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
          <span className="pointer-events-none absolute top-1/2 right-3 flex -translate-y-1/2 items-center gap-2">
            {isFetching && <Loader2 className="size-4 animate-spin text-muted-foreground" aria-hidden />}
            <Kbd className="hidden sm:inline-flex">F4</Kbd>
          </span>

          {listOpen && (
            <ul
              id="clientes-resultados"
              role="listbox"
              className="absolute top-full right-0 left-0 z-30 mt-1 max-h-80 overflow-y-auto rounded-md border border-border bg-card p-1 shadow-lg"
            >
              {resultsReady && results.length === 0 && (
                <li className="px-3 py-2 text-sm text-muted-foreground">Nenhum cliente encontrado.</li>
              )}
              {options.map((option, index) => (
                <li
                  key={option.kind === 'client' ? option.client.id : 'novo'}
                  id={`cliente-opcao-${index}`}
                  role="option"
                  aria-selected={index === active}
                  onMouseDown={(e) => e.preventDefault()}
                  onMouseEnter={() => setActive(index)}
                  onClick={() => select(option)}
                  className={cn(
                    'flex cursor-pointer items-center justify-between gap-3 rounded-sm px-3 py-2 text-sm',
                    index === active && 'bg-muted',
                    option.kind === 'new' && 'mt-1 border-t border-border font-semibold text-primary',
                  )}
                >
                  {option.kind === 'client' ? (
                    <>
                      <span className="truncate font-medium">{option.client.name}</span>
                      <span className="shrink-0 text-muted-foreground tabular-nums">
                        {formatWhatsapp(option.client.whatsapp)}
                      </span>
                    </>
                  ) : (
                    <span className="flex items-center gap-2">
                      <UserPlus className="size-4" />
                      Cadastrar novo cliente
                    </span>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {showSearch && (
        <div className="mt-2 flex items-center justify-between text-[13px] text-muted-foreground">
          <span>Não achou? Cadastre na hora com nome e WhatsApp.</span>
          <Button variant="link" size="sm" onClick={() => setDialog({ open: true })}>
            Novo cliente
          </Button>
        </div>
      )}

      <ClientFormDialog
        open={dialog.open}
        onOpenChange={(open) => setDialog((d) => ({ ...d, open }))}
        initialValues={{ name: dialog.name, whatsapp: dialog.whatsapp }}
        onSaved={(client) => {
          onChange(client);
          setQuery('');
          setSearching(false);
        }}
      />
    </div>
  );
}
