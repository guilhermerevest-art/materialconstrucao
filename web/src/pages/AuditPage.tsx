import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { Download, ShieldCheck, X } from 'lucide-react';
import { useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { toast } from 'sonner';
import { EmptyState, PageHeader } from '@/components/shared';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Field, Input, NativeSelect } from '@/components/ui/input';
import { Alert, Badge, Skeleton } from '@/components/ui/misc';
import { api, toQuery } from '@/lib/api';
import { actionText, AREA_LABEL, changeLines, type AuditArea, type AuditItem } from '@/lib/audit';
import { addDays, formatDateTime, formatDay, todayIso } from '@/lib/format';
import { useDocumentTitle } from '@/lib/hooks';
import type { ManagedUser } from '@/lib/types';

type Page = { items: AuditItem[]; next_before: number | null };

const PRODUCT_ENTITIES = new Set(['products', 'product_price_tiers', 'price_list_items', 'stock_movements']);

/** Dia no fuso do navegador, para agrupar a lista. */
const dayOf = (iso: string) => todayIso(new Date(iso));
const timeOf = (iso: string) => formatDateTime(iso).slice(-5);

function ItemLabel({ item }: { item: AuditItem }) {
  if (!item.label) return null;
  if (item.entity === 'orders' && item.entity_id) {
    return (
      <Link to={`/pedidos/${item.entity_id}`} className="font-semibold text-primary hover:underline">
        {item.label}
      </Link>
    );
  }
  if (PRODUCT_ENTITIES.has(item.entity) && item.entity_id) {
    return (
      <Link to={`?produto=${item.entity_id}`} className="font-semibold text-primary hover:underline" title="Ver o histórico deste produto">
        {item.label}
      </Link>
    );
  }
  return <span className="font-semibold">{item.label}</span>;
}

function Entry({ item }: { item: AuditItem }) {
  const lines = changeLines(item);
  const refused = item.action === 'login_failed';
  return (
    <li className="grid gap-x-4 gap-y-1 px-4 py-3 sm:grid-cols-[3.5rem_1fr] sm:px-5">
      <time dateTime={item.created_at} className="text-sm text-muted-foreground tabular-nums">
        {timeOf(item.created_at)}
      </time>
      <div className="grid min-w-0 gap-1">
        <p className="break-words">
          <span className={refused ? 'font-medium text-destructive' : 'font-medium'}>{actionText(item)}</span>
          {/* Na entrada, o nome já está na linha de baixo. */}
          {item.area !== 'acesso' && item.label && (
            <>
              {' '}
              <ItemLabel item={item} />
            </>
          )}
        </p>
        <p className="text-[13px] text-muted-foreground">
          {item.user_name ?? 'Sistema'}
          {item.store_name && ` · ${item.store_name}`}
          {item.ip && ` · IP ${item.ip.replace(/^::ffff:/, '')}`}
          <Badge className="ml-2 align-middle">{AREA_LABEL[item.area] ?? item.area}</Badge>
        </p>
        {lines.length > 0 && (
          <ul className="grid gap-0.5 text-[13px]">
            {lines.map((line) => (
              <li key={line.label} className="break-words">
                <span className="text-muted-foreground">{line.label}:</span> {line.text}
              </li>
            ))}
          </ul>
        )}
        {item.note && <p className="text-[13px] break-words text-muted-foreground italic">“{item.note}”</p>}
      </div>
    </li>
  );
}

function downloadCsv(items: AuditItem[]) {
  const escape = (value: string) => (/[";\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value);
  const header = ['Data e hora', 'Usuário', 'Área', 'O que', 'Item', 'Loja', 'Alterações', 'Observação', 'IP'];
  const rows = items.map((item) => [
    formatDateTime(item.created_at),
    item.user_name ?? 'Sistema',
    AREA_LABEL[item.area] ?? item.area,
    actionText(item),
    item.label ?? '',
    item.store_name ?? '',
    changeLines(item)
      .map((l) => `${l.label}: ${l.text}`)
      .join(' | '),
    item.note ?? '',
    item.ip?.replace(/^::ffff:/, '') ?? '',
  ]);
  const lines = [header, ...rows].map((row) => row.map(escape).join(';'));
  // Ponto e vírgula e BOM: o Excel em português abre direto, com acentos.
  const blob = new Blob([`﻿${lines.join('\r\n')}`], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `registro-de-alteracoes-${todayIso()}.csv`;
  link.click();
  URL.revokeObjectURL(url);
}

/** Quem mudou o quê e quando. Só o administrador vê; ninguém altera nem apaga. */
export function AuditPage() {
  useDocumentTitle('Registro de alterações');
  const [params, setParams] = useSearchParams();
  const productId = params.get('produto') ?? '';
  const [from, setFrom] = useState(() => addDays(todayIso(), -6));
  const [to, setTo] = useState(todayIso);
  const [area, setArea] = useState<AuditArea | ''>('');
  const [userId, setUserId] = useState('');
  const [search, setSearch] = useState('');
  const [q, setQ] = useState('');
  const [exporting, setExporting] = useState(false);

  // No histórico de um produto, vale o período inteiro.
  const filters = {
    from: productId ? '' : from,
    to: productId ? '' : to,
    area,
    user_id: userId,
    q,
    product_id: productId,
  };
  const users = useQuery({
    queryKey: ['users'],
    queryFn: () => api<{ items: ManagedUser[] }>('/users').then((r) => r.items),
  });
  const query = useInfiniteQuery({
    queryKey: ['audit', filters],
    queryFn: ({ pageParam }) => api<Page>(`/audit${toQuery({ ...filters, before: pageParam, limit: 100 })}`),
    initialPageParam: null as number | null,
    getNextPageParam: (last) => last.next_before,
  });
  const items = query.data?.pages.flatMap((p) => p.items) ?? [];
  const days = items.reduce<{ day: string; items: AuditItem[] }[]>((groups, item) => {
    const day = dayOf(item.created_at);
    const last = groups.at(-1);
    if (last?.day === day) last.items.push(item);
    else groups.push({ day, items: [item] });
    return groups;
  }, []);
  const productName = productId ? items.find((i) => i.entity === 'products')?.label ?? items[0]?.label : null;

  async function exportCsv() {
    setExporting(true);
    try {
      const all = await api<Page>(`/audit${toQuery({ ...filters, limit: 2000 })}`);
      downloadCsv(all.items);
      if (all.next_before) toast.info('Foram exportadas as 2.000 alterações mais recentes. Diminua o período para ver o resto.');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Não foi possível exportar.');
    } finally {
      setExporting(false);
    }
  }

  return (
    <>
      <PageHeader
        title="Registro de alterações"
        description="Quem mudou preço, estoque, pedido, financeiro, nota, usuário ou configuração, e quando. O que fica aqui não pode ser alterado nem apagado."
        actions={
          <Button variant="outline" onClick={exportCsv} loading={exporting} disabled={!items.length}>
            {!exporting && <Download />}
            Exportar CSV
          </Button>
        }
      />
      <Card>
        <form
          className="flex flex-wrap items-end gap-3 border-b border-border p-4"
          onSubmit={(e) => {
            e.preventDefault();
            setQ(search.trim());
          }}
        >
          {productId ? (
            <div className="flex min-h-10 items-center gap-2 rounded-md border border-border bg-muted/50 py-1 pr-1 pl-3 text-sm">
              Histórico de <span className="font-semibold">{productName ?? `produto nº ${productId}`}</span>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="size-8"
                aria-label="Ver todas as alterações"
                onClick={() => {
                  params.delete('produto');
                  setParams(params);
                }}
              >
                <X />
              </Button>
            </div>
          ) : (
            <>
              <Field label="De" htmlFor="audit-de" className="w-[calc(50%-0.375rem)] sm:w-40">
                <Input id="audit-de" type="date" value={from} max={to} onChange={(e) => setFrom(e.target.value)} />
              </Field>
              <Field label="Até" htmlFor="audit-ate" className="w-[calc(50%-0.375rem)] sm:w-40">
                <Input id="audit-ate" type="date" value={to} min={from} onChange={(e) => setTo(e.target.value)} />
              </Field>
            </>
          )}
          <Field label="Área" htmlFor="audit-area" className="w-full sm:w-48">
            <NativeSelect id="audit-area" value={area} onChange={(e) => setArea(e.target.value as AuditArea | '')}>
              <option value="">Todas</option>
              {(Object.keys(AREA_LABEL) as AuditArea[]).map((key) => (
                <option key={key} value={key}>
                  {AREA_LABEL[key]}
                </option>
              ))}
            </NativeSelect>
          </Field>
          <Field label="Usuário" htmlFor="audit-usuario" className="w-full sm:w-48">
            <NativeSelect id="audit-usuario" value={userId} onChange={(e) => setUserId(e.target.value)}>
              <option value="">Todos</option>
              {users.data?.map((u) => (
                <option key={u.id} value={u.id}>
                  {u.name}
                </option>
              ))}
            </NativeSelect>
          </Field>
          <Field label="Buscar" htmlFor="audit-busca" className="w-full sm:w-56">
            <Input
              id="audit-busca"
              type="search"
              value={search}
              placeholder="Produto, pedido, motivo…"
              onChange={(e) => {
                setSearch(e.target.value);
                if (!e.target.value) setQ('');
              }}
            />
          </Field>
        </form>

        {query.isPending ? (
          <Skeleton className="m-4 h-48" />
        ) : query.isError ? (
          <Alert variant="danger" title={query.error.message} className="m-4" />
        ) : !items.length ? (
          <EmptyState
            title={productId ? 'Nada registrado para este produto' : 'Nada registrado no período'}
            description="As alterações passam a ser registradas a partir desta versão do sistema."
          />
        ) : (
          <>
            {days.map((group) => (
              <section key={group.day} aria-label={formatDay(group.day)}>
                <h2 className="sticky top-14 z-10 border-b border-border bg-muted/80 px-4 py-1.5 text-[13px] font-semibold backdrop-blur sm:px-5">
                  {group.day === todayIso() ? 'Hoje' : formatDay(group.day)}
                </h2>
                <ul className="divide-y divide-border">
                  {group.items.map((item) => (
                    <Entry key={item.id} item={item} />
                  ))}
                </ul>
              </section>
            ))}
            {query.hasNextPage && (
              <div className="border-t border-border p-4 text-center">
                <Button variant="outline" onClick={() => query.fetchNextPage()} loading={query.isFetchingNextPage}>
                  Carregar mais
                </Button>
              </div>
            )}
          </>
        )}
      </Card>
      <p className="mt-3 flex items-center gap-2 text-[13px] text-muted-foreground">
        <ShieldCheck className="size-4 shrink-0" />
        Senhas e chaves aparecem só como “informada” ou “alterada”: o valor nunca fica no registro.
      </p>
    </>
  );
}
