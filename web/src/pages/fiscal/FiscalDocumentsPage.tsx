import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { Search } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { FiscalDocumentActions, FiscalStatusBadge } from '@/components/fiscal/FiscalDocumentActions';
import { FiscalNav } from '@/components/fiscal/FiscalNav';
import { EmptyState, PageHeader, Pagination } from '@/components/shared';
import { Card } from '@/components/ui/card';
import { Input, Label, NativeSelect } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/misc';
import { Table, TBody, TD, TH, THead, TR } from '@/components/ui/table';
import { api, toQuery } from '@/lib/api';
import { useUser } from '@/lib/auth';
import { formatDocument, modelLabel, STATUS_LABELS } from '@/lib/fiscal';
import { formatDateTime, formatMoney, formatOrderNumber } from '@/lib/format';
import { useDebouncedValue, useDocumentTitle } from '@/lib/hooks';
import type { FiscalDocument, FiscalDocumentStatus, Paginated, Store } from '@/lib/types';

const PAGE_SIZE = 20;

/** Notas emitidas: NF-e e NFC-e dos pedidos, com a situação na SEFAZ. */
export function FiscalDocumentsPage() {
  useDocumentTitle('Notas fiscais emitidas');
  const user = useUser();
  const isAdmin = user.role === 'admin';
  const [params, setParams] = useSearchParams();

  const status = params.get('situacao') ?? '';
  const model = params.get('modelo') ?? '';
  const from = params.get('de') ?? '';
  const to = params.get('ate') ?? '';
  const storeId = params.get('loja') ?? '';
  const page = Math.max(1, Number(params.get('pagina') ?? 1) || 1);
  const [search, setSearch] = useState(params.get('q') ?? '');
  const q = useDebouncedValue(search.trim(), 300);

  function update(changes: Record<string, string | null>) {
    setParams(
      (current) => {
        const next = new URLSearchParams(current);
        for (const [key, value] of Object.entries(changes)) {
          if (value) next.set(key, value);
          else next.delete(key);
        }
        if (!('pagina' in changes)) next.delete('pagina');
        return next;
      },
      { replace: true },
    );
  }

  useEffect(() => {
    if ((params.get('q') ?? '') !== q) update({ q });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q]);

  const stores = useQuery({
    queryKey: ['stores'],
    queryFn: () => api<{ items: Store[] }>('/stores').then((r) => r.items),
    enabled: isAdmin,
  });

  const filters = { status, model, from, to, q, store_id: storeId, page, page_size: PAGE_SIZE };
  const documents = useQuery({
    queryKey: ['fiscal-documents', 'list', filters],
    queryFn: () => api<Paginated<FiscalDocument>>(`/fiscal/documents${toQuery(filters)}`),
    placeholderData: keepPreviousData,
  });
  const data = documents.data;
  const hasFilters = Boolean(status || model || from || to || q || storeId);

  return (
    <div>
      <PageHeader
        title="Fiscal"
        description={isAdmin ? 'Notas fiscais de todas as lojas da rede.' : `Notas fiscais da ${user.store_name}.`}
      />
      <FiscalNav />

      <Card>
        <div className="flex flex-wrap items-end gap-3 border-b border-border p-4">
          <div className="relative w-full sm:min-w-56 sm:flex-1">
            <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              aria-label="Buscar nota"
              placeholder="Cliente, nº da nota, nº do pedido ou chave"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="w-full pl-9"
            />
          </div>
          <NativeSelect aria-label="Modelo" value={model} onChange={(e) => update({ modelo: e.target.value })} className="w-full sm:w-36">
            <option value="">NF-e e NFC-e</option>
            <option value="55">NF-e</option>
            <option value="65">NFC-e</option>
          </NativeSelect>
          <NativeSelect
            aria-label="Situação"
            value={status}
            onChange={(e) => update({ situacao: e.target.value })}
            className="w-full sm:w-48"
          >
            <option value="">Todas as situações</option>
            {(Object.keys(STATUS_LABELS) as FiscalDocumentStatus[]).map((value) => (
              <option key={value} value={value}>
                {STATUS_LABELS[value].text}
              </option>
            ))}
          </NativeSelect>
          <div className="grid gap-1">
            <Label htmlFor="nota-de" className="text-xs text-muted-foreground">
              De
            </Label>
            <Input id="nota-de" type="date" value={from} onChange={(e) => update({ de: e.target.value })} className="w-full sm:w-40" />
          </div>
          <div className="grid gap-1">
            <Label htmlFor="nota-ate" className="text-xs text-muted-foreground">
              Até
            </Label>
            <Input id="nota-ate" type="date" value={to} onChange={(e) => update({ ate: e.target.value })} className="w-full sm:w-40" />
          </div>
          {isAdmin && (
            <NativeSelect aria-label="Loja" value={storeId} onChange={(e) => update({ loja: e.target.value })} className="w-full sm:w-44">
              <option value="">Todas as lojas</option>
              {stores.data?.map((store) => (
                <option key={store.id} value={store.id}>
                  {store.name}
                </option>
              ))}
            </NativeSelect>
          )}
        </div>

        {documents.isPending ? (
          <div className="grid gap-2 p-4">
            {Array.from({ length: 6 }, (_, i) => (
              <Skeleton key={i} className="h-12" />
            ))}
          </div>
        ) : !data || data.items.length === 0 ? (
          <EmptyState
            title={hasFilters ? 'Nenhuma nota encontrada' : 'Nenhuma nota emitida ainda'}
            description={
              hasFilters
                ? 'Mude os filtros para ver outras notas.'
                : 'Abra um pedido confirmado e use "Emitir NFC-e" ou "Emitir NF-e" no quadro Nota fiscal.'
            }
          />
        ) : (
          <>
            <Table>
              <THead>
                <TR>
                  <TH className="pl-4">Nota</TH>
                  <TH>Pedido</TH>
                  <TH>Cliente</TH>
                  {isAdmin && <TH>Loja</TH>}
                  <TH className="text-right">Valor</TH>
                  <TH>Situação</TH>
                  <TH>Emitida em</TH>
                  <TH className="pr-4">
                    <span className="sr-only">Ações</span>
                  </TH>
                </TR>
              </THead>
              <TBody>
                {data.items.map((doc) => (
                  <TR key={doc.id} className="align-top">
                    <TD className="pl-4">
                      <span className="font-semibold whitespace-nowrap">
                        {modelLabel(doc.model)} {doc.number}
                      </span>
                      <span className="block text-[12px] text-muted-foreground">
                        Série {doc.series}
                        {doc.environment === 'homologacao' && ' · homologação'}
                      </span>
                    </TD>
                    <TD className="tabular-nums">
                      <Link to={`/pedidos/${doc.order_id}`} className="font-medium text-primary hover:underline">
                        {formatOrderNumber(doc.order_id)}
                      </Link>
                    </TD>
                    <TD>
                      <span className="font-medium">{doc.recipient_name ?? doc.client_name}</span>
                      {doc.recipient_document ? (
                        <span className="block text-[12px] text-muted-foreground tabular-nums">
                          {formatDocument(doc.recipient_document)}
                        </span>
                      ) : (
                        doc.model === 65 && <span className="block text-[12px] text-muted-foreground">Consumidor sem CPF</span>
                      )}
                    </TD>
                    {isAdmin && <TD className="text-muted-foreground">{doc.store_name}</TD>}
                    <TD className="text-right font-semibold tabular-nums">{formatMoney(doc.total_amount)}</TD>
                    <TD className="max-w-64">
                      <FiscalStatusBadge status={doc.status} />
                      {doc.status_message && doc.status !== 'autorizado' && (
                        <span className="mt-1 block text-[12px] leading-snug text-muted-foreground">{doc.status_message}</span>
                      )}
                    </TD>
                    <TD className="text-muted-foreground tabular-nums whitespace-nowrap">
                      {formatDateTime(doc.issued_at ?? doc.created_at)}
                      <span className="block text-[12px]">{doc.user_name}</span>
                    </TD>
                    <TD className="pr-4">
                      <FiscalDocumentActions document={doc} />
                    </TD>
                  </TR>
                ))}
              </TBody>
            </Table>
            <Pagination page={page} pageSize={PAGE_SIZE} total={data.total} onPageChange={(next) => update({ pagina: String(next) })} />
          </>
        )}
      </Card>
    </div>
  );
}
