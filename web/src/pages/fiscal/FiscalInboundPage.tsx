import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CloudDownload, Download, FileCode2, FileInput, KeyRound, MoreHorizontal, PackageCheck, RefreshCw, Search, Stamp } from 'lucide-react';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Link } from 'react-router';
import { toast } from 'sonner';
import { FiscalNav } from '@/components/fiscal/FiscalNav';
import { EmptyState, PageHeader, Pagination } from '@/components/shared';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Field, Input, Textarea } from '@/components/ui/input';
import { Alert, Badge, Skeleton } from '@/components/ui/misc';
import { Table, TBody, TD, TH, THead, TR } from '@/components/ui/table';
import { api, ApiError, toQuery } from '@/lib/api';
import { formatAccessKey, formatDocument, MANIFESTATIONS } from '@/lib/fiscal';
import { formatDate, formatDateTime, formatMoney } from '@/lib/format';
import { useDebouncedValue, useDocumentTitle } from '@/lib/hooks';
import type { InboundDocument, InboundListMeta, ManifestationCode, Paginated } from '@/lib/types';
import { cn } from '@/lib/utils';

const PAGE_SIZE = 20;

const FILTERS = [
  { value: 'all', label: 'Todas' },
  { value: 'pending', label: 'A manifestar' },
  { value: 'acknowledged', label: 'Com ciência' },
  { value: 'confirmed', label: 'Confirmadas' },
  { value: 'refused', label: 'Recusadas' },
  { value: 'cancelled', label: 'Canceladas' },
];

type InboundList = Paginated<InboundDocument> & { meta: InboundListMeta };

function errorMessage(err: unknown, fallback: string) {
  return err instanceof ApiError ? err.message : fallback;
}

function ManifestationBadge({ doc }: { doc: InboundDocument }) {
  if (!doc.manifestation) return <Badge variant="quote">A manifestar</Badge>;
  const info = MANIFESTATIONS[doc.manifestation];
  if (doc.manifestation_status === 'pendente') return <Badge variant="neutral">{info.short} (processando)</Badge>;
  const variant = doc.manifestation === '210200' || doc.manifestation === '210210' ? 'success' : 'danger';
  return <Badge variant={variant}>{info.short}</Badge>;
}

/** Manifestação do destinatário: ciência e confirmação vão direto; recusa pede justificativa. */
function ManifestDialog({
  doc,
  event,
  onOpenChange,
}: {
  doc: InboundDocument;
  event: ManifestationCode | null;
  onOpenChange: (open: boolean) => void;
}) {
  const queryClient = useQueryClient();
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);

  const mutation = useMutation({
    mutationFn: () =>
      api<{ document: InboundDocument }>(`/fiscal/inbound/${doc.id}/manifest`, { method: 'POST', body: { event, reason } }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['fiscal-inbound'] });
      toast.success(`${MANIFESTATIONS[event!].label} enviada à SEFAZ.`);
      setReason('');
      onOpenChange(false);
    },
    onError: (err) => setError(errorMessage(err, 'Não foi possível manifestar.')),
  });

  if (!event) return null;
  const info = MANIFESTATIONS[event];
  const needsReason = event === '210240';

  function submit(e: FormEvent) {
    e.preventDefault();
    if (needsReason && reason.trim().length < 15) return setError('A justificativa precisa ter pelo menos 15 caracteres.');
    setError(null);
    mutation.mutate();
  }

  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{info.label}</DialogTitle>
          <DialogDescription>
            {doc.issuer_name ?? 'Emitente'} · {doc.amount != null ? formatMoney(doc.amount) : 'valor não informado'}. {info.description}
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="grid gap-4">
          {(event === '210220' || event === '210240') && (
            <Field
              label="Justificativa"
              htmlFor="manifesto-justificativa"
              error={error}
              hint={needsReason ? 'Obrigatória, de 15 a 255 caracteres.' : 'Opcional.'}
            >
              <Textarea
                id="manifesto-justificativa"
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                maxLength={255}
                autoFocus
              />
            </Field>
          )}
          {error && event !== '210220' && event !== '210240' && <Alert variant="danger" title={error} />}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Voltar
            </Button>
            <Button
              type="submit"
              variant={event === '210220' || event === '210240' ? 'destructive' : 'default'}
              loading={mutation.isPending}
            >
              Enviar manifestação
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function ByKeyDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const queryClient = useQueryClient();
  const [key, setKey] = useState('');
  const [error, setError] = useState<string | null>(null);
  const digits = key.replace(/\D/g, '');

  const mutation = useMutation({
    mutationFn: () =>
      api<{ created: number; found: boolean; notice: string | null }>('/fiscal/inbound/by-key', {
        method: 'POST',
        body: { access_key: digits },
      }),
    onSuccess: (result) => {
      void queryClient.invalidateQueries({ queryKey: ['fiscal-inbound'] });
      if (result.found) {
        toast.success('Nota encontrada na SEFAZ e adicionada à lista.');
        setKey('');
        onOpenChange(false);
      } else setError(result.notice ?? 'A SEFAZ não devolveu esta nota para o CNPJ da empresa.');
    },
    onError: (err) => setError(errorMessage(err, 'Não foi possível consultar.')),
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Consultar nota pela chave</DialogTitle>
          <DialogDescription>Para a nota que o fornecedor mandou e ainda não apareceu na lista.</DialogDescription>
        </DialogHeader>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (digits.length !== 44) return setError('A chave de acesso tem 44 dígitos.');
            setError(null);
            mutation.mutate();
          }}
          className="grid gap-4"
        >
          <Field label="Chave de acesso" htmlFor="chave-acesso" error={error} hint={`${digits.length}/44 dígitos`}>
            <Input
              id="chave-acesso"
              value={key}
              onChange={(e) => setKey(e.target.value)}
              inputMode="numeric"
              autoFocus
              className="font-mono text-[13px]"
            />
          </Field>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancelar
            </Button>
            <Button type="submit" loading={mutation.isPending}>
              Consultar na SEFAZ
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Monitor de notas recebidas: as NF-e que os fornecedores emitiram para o CNPJ
 * da empresa, trazidas da SEFAZ pela ACBr API, e a manifestação de cada uma.
 */
export function FiscalInboundPage() {
  useDocumentTitle('Notas recebidas');
  const queryClient = useQueryClient();
  const [status, setStatus] = useState('all');
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState('');
  const [manifest, setManifest] = useState<{ doc: InboundDocument; event: ManifestationCode } | null>(null);
  const [byKeyOpen, setByKeyOpen] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const q = useDebouncedValue(search.trim(), 300);
  const autoSynced = useRef(false);

  const filters = { status, q, page, page_size: PAGE_SIZE };
  const list = useQuery({
    queryKey: ['fiscal-inbound', filters],
    queryFn: () => api<InboundList>(`/fiscal/inbound${toQuery(filters)}`),
    placeholderData: keepPreviousData,
  });

  const sync = useMutation({
    mutationFn: (sefaz: boolean) =>
      api<{ created: number; notice: string | null }>('/fiscal/inbound/sync', { method: 'POST', body: { sefaz } }),
    onSuccess: ({ created, notice: message }, sefaz) => {
      void queryClient.invalidateQueries({ queryKey: ['fiscal-inbound'] });
      setNotice(message);
      if (created) toast.success(created === 1 ? '1 nota nova recebida.' : `${created} notas novas recebidas.`);
      else if (sefaz) toast('Nenhuma nota nova.');
    },
    onError: (err, sefaz) => {
      if (sefaz) toast.error(errorMessage(err, 'Não foi possível buscar as notas.'));
      else setNotice(errorMessage(err, 'Não foi possível buscar as notas.'));
    },
  });

  // Ao abrir, lê o que a distribuição automática da ACBr API já trouxe (sem gastar consulta na SEFAZ).
  const meta = list.data?.meta;
  useEffect(() => {
    if (!meta?.configured || autoSynced.current) return;
    autoSynced.current = true;
    sync.mutate(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [meta?.configured]);

  const data = list.data;

  return (
    <div>
      <PageHeader
        title="Fiscal"
        description="Notas de fornecedores emitidas contra o CNPJ da empresa."
        actions={
          meta?.configured && (
            <>
              <Button variant="outline" onClick={() => setByKeyOpen(true)}>
                <KeyRound />
                Consultar por chave
              </Button>
              <Button onClick={() => sync.mutate(true)} loading={sync.isPending && sync.variables === true}>
                {!(sync.isPending && sync.variables === true) && <CloudDownload />}
                Buscar na SEFAZ agora
              </Button>
            </>
          )
        }
      />
      <FiscalNav />

      {meta && !meta.configured ? (
        <Card>
          <EmptyState
            title="Configure a empresa primeiro"
            description="O monitor consulta as notas emitidas para o CNPJ cadastrado em Configurações → Fiscal."
            action={
              <Button asChild>
                <Link to="/configuracoes?aba=fiscal">Abrir Configurações → Fiscal</Link>
              </Button>
            }
          />
        </Card>
      ) : (
        // grid-cols-1 (minmax(0, 1fr)): sem ele a tabela larga estica a página no celular.
        <div className="grid grid-cols-1 gap-4">
          {meta && (
            <div className="flex flex-wrap items-center gap-x-6 gap-y-2 text-sm">
              <span>
                <strong className="tabular-nums">{meta.pending_count}</strong>{' '}
                <span className="text-muted-foreground">{meta.pending_count === 1 ? 'nota a manifestar' : 'notas a manifestar'}</span>
              </span>
              <span className="text-muted-foreground">
                {meta.synced_at ? `Última busca: ${formatDateTime(meta.synced_at)}` : 'Ainda não buscou notas'}
              </span>
              <span className="text-muted-foreground">
                Consulta automática na SEFAZ: {meta.auto_distribution ? 'ligada' : 'desligada'}
                {meta.auto_acknowledge && ' · ciência automática'}
              </span>
              {meta.environment === 'homologacao' && <Badge variant="quote">Homologação</Badge>}
              <Button variant="ghost" size="sm" onClick={() => sync.mutate(false)} disabled={sync.isPending} aria-label="Atualizar lista">
                <RefreshCw className={sync.isPending && sync.variables === false ? 'animate-spin' : undefined} />
                Atualizar
              </Button>
            </div>
          )}
          {notice && (
            <Alert title={notice} className="py-3">
              <p className="text-[13px] text-muted-foreground">
                A SEFAZ permite uma consulta por hora quando não há notas novas; a consulta automática continua rodando.
              </p>
            </Alert>
          )}

          <Card>
            <div className="flex flex-wrap items-center gap-3 border-b border-border p-4">
              <div className="flex flex-wrap rounded-md border border-input bg-background p-0.5" role="group" aria-label="Situação">
                {FILTERS.map((filter) => (
                  <button
                    key={filter.value}
                    onClick={() => {
                      setStatus(filter.value);
                      setPage(1);
                    }}
                    aria-pressed={status === filter.value}
                    className={cn(
                      'h-8 rounded px-3 text-sm font-medium',
                      status === filter.value ? 'bg-card text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground',
                    )}
                  >
                    {filter.label}
                  </button>
                ))}
              </div>
              <div className="relative w-full sm:min-w-56 sm:flex-1">
                <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
                <Input
                  aria-label="Buscar nota recebida"
                  placeholder="Fornecedor, CNPJ ou chave"
                  value={search}
                  onChange={(e) => {
                    setSearch(e.target.value);
                    setPage(1);
                  }}
                  className="w-full pl-9"
                />
              </div>
            </div>

            {list.isPending ? (
              <div className="grid gap-2 p-4">
                {Array.from({ length: 6 }, (_, i) => (
                  <Skeleton key={i} className="h-12" />
                ))}
              </div>
            ) : !data || data.items.length === 0 ? (
              <EmptyState
                title={q || status !== 'all' ? 'Nenhuma nota encontrada' : 'Nenhuma nota recebida ainda'}
                description={
                  q || status !== 'all'
                    ? 'Mude o filtro ou a busca.'
                    : 'As notas emitidas para o CNPJ da empresa aparecem aqui assim que a SEFAZ as distribui.'
                }
              />
            ) : (
              <>
                <Table>
                  <THead>
                    <TR>
                      <TH className="pl-4">Emissão</TH>
                      <TH>Fornecedor</TH>
                      <TH className="text-right">Valor</TH>
                      <TH>Chave de acesso</TH>
                      <TH>Situação</TH>
                      <TH className="pr-4">
                        <span className="sr-only">Ações</span>
                      </TH>
                    </TR>
                  </THead>
                  <TBody>
                    {data.items.map((doc) => {
                      const date = doc.issued_at ?? doc.authorized_at ?? doc.created_at;
                      return (
                        <TR key={doc.id} className={cn('align-top', doc.cancelled && 'text-muted-foreground')}>
                          <TD className="pl-4 tabular-nums whitespace-nowrap">{formatDate(date)}</TD>
                          <TD>
                            <span className="font-medium">{doc.issuer_name ?? 'Emitente não informado'}</span>
                            {doc.issuer_document && (
                              <span className="block text-[12px] text-muted-foreground tabular-nums">
                                {formatDocument(doc.issuer_document)}
                              </span>
                            )}
                          </TD>
                          <TD className="text-right font-semibold tabular-nums">
                            {doc.amount != null ? formatMoney(doc.amount) : '-'}
                          </TD>
                          <TD className="max-w-56 font-mono text-[11px] leading-snug break-words text-muted-foreground">
                            {formatAccessKey(doc.access_key)}
                          </TD>
                          <TD>
                            <div className="flex flex-wrap gap-1">
                              {doc.cancelled ? <Badge variant="danger">Cancelada pelo emitente</Badge> : <ManifestationBadge doc={doc} />}
                              {doc.summary && <Badge variant="neutral">Resumo</Badge>}
                              {doc.stock_entry_id && (
                                <Link to="/estoque?aba=entradas" title="Já deu entrada no estoque">
                                  <Badge variant="success">
                                    <PackageCheck className="size-3" />
                                    Entrada nº {doc.stock_entry_id}
                                  </Badge>
                                </Link>
                              )}
                            </div>
                            {doc.manifestation_message && doc.manifestation_status !== 'registrado' && (
                              <span className="mt-1 block text-[12px] text-muted-foreground">{doc.manifestation_message}</span>
                            )}
                          </TD>
                          <TD className="pr-4">
                            <div className="flex justify-end gap-1">
                              {!doc.summary && (
                                <Button asChild variant="outline" size="sm">
                                  <a href={`/api/fiscal/inbound/${doc.id}/pdf`} target="_blank" rel="noreferrer">
                                    <Download />
                                    DANFE
                                  </a>
                                </Button>
                              )}
                              {!doc.summary && !doc.cancelled && !doc.stock_entry_id && (
                                <Button asChild size="sm">
                                  <Link to={`/estoque/entrada?nota=${doc.id}`} title="Abre a entrada de estoque com os itens desta nota">
                                    <FileInput />
                                    Dar entrada
                                  </Link>
                                </Button>
                              )}
                              {doc.summary && !doc.manifestation && !doc.cancelled && (
                                <Button size="sm" onClick={() => setManifest({ doc, event: '210210' })}>
                                  <Stamp />
                                  Dar ciência
                                </Button>
                              )}
                              <DropdownMenu>
                                <DropdownMenuTrigger asChild>
                                  <Button variant="ghost" size="icon" className="size-8" aria-label="Mais ações">
                                    <MoreHorizontal />
                                  </Button>
                                </DropdownMenuTrigger>
                                <DropdownMenuContent align="end">
                                  <DropdownMenuLabel className="text-xs text-muted-foreground">Manifestar</DropdownMenuLabel>
                                  {(Object.keys(MANIFESTATIONS) as ManifestationCode[]).map((code) => (
                                    <DropdownMenuItem
                                      key={code}
                                      onSelect={() => setManifest({ doc, event: code })}
                                      disabled={doc.cancelled}
                                    >
                                      <Stamp />
                                      {MANIFESTATIONS[code].label}
                                    </DropdownMenuItem>
                                  ))}
                                  <DropdownMenuSeparator />
                                  <DropdownMenuItem asChild>
                                    <a href={`/api/fiscal/inbound/${doc.id}/xml?download=1`}>
                                      <FileCode2 />
                                      Baixar XML{doc.summary ? ' (resumo)' : ''}
                                    </a>
                                  </DropdownMenuItem>
                                </DropdownMenuContent>
                              </DropdownMenu>
                            </div>
                          </TD>
                        </TR>
                      );
                    })}
                  </TBody>
                </Table>
                <Pagination page={page} pageSize={PAGE_SIZE} total={data.total} onPageChange={setPage} />
              </>
            )}
          </Card>
        </div>
      )}

      {manifest && (
        <ManifestDialog doc={manifest.doc} event={manifest.event} onOpenChange={(open) => !open && setManifest(null)} />
      )}
      <ByKeyDialog open={byKeyOpen} onOpenChange={setByKeyOpen} />
    </div>
  );
}
