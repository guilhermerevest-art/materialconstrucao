import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { Download } from 'lucide-react';
import type { ReactNode } from 'react';
import { useSearchParams } from 'react-router';
import { EmptyState, PageHeader } from '@/components/shared';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input, Label, NativeSelect } from '@/components/ui/input';
import { Alert, Skeleton } from '@/components/ui/misc';
import { Table, TBody, TD, TH, THead, TR } from '@/components/ui/table';
import { api, toQuery } from '@/lib/api';
import { useUser } from '@/lib/auth';
import { formatDate, formatMoney, formatQuantity, formatWhatsapp } from '@/lib/format';
import { useDocumentTitle } from '@/lib/hooks';
import type { Report, ReportRow, ReportType, Store } from '@/lib/types';
import { cn } from '@/lib/utils';

type Column = {
  label: string;
  /** Valor na tela. */
  render: (row: ReportRow) => ReactNode;
  /** Valor no CSV (sem formatação de moeda, para abrir como número na planilha). */
  csv: (row: ReportRow) => string | number;
  numeric?: boolean;
};

const decimal = (value: number | undefined) => String(value ?? 0).replace('.', ',');

/** "2026-10-09" sem passar por Date (que leria como UTC e voltaria um dia). */
const formatDay = (day: string) => day.split('-').reverse().join('/');
const weekday = new Intl.DateTimeFormat('pt-BR', { weekday: 'short' });
const dayOfWeek = (day: string) => weekday.format(new Date(`${day}T12:00:00`)).replace('.', '');

const countColumn = (label: string): Column => ({
  label,
  render: (row) => row.count,
  csv: (row) => row.count,
  numeric: true,
});
const totalColumn: Column = {
  label: 'Total',
  render: (row) => <span className="font-semibold">{formatMoney(row.total_amount)}</span>,
  csv: (row) => decimal(row.total_amount),
  numeric: true,
};
const averageColumn: Column = {
  label: 'Ticket médio',
  render: (row) => formatMoney(row.average_amount ?? 0),
  csv: (row) => decimal(row.average_amount),
  numeric: true,
};
const discountColumn: Column = {
  label: 'Descontos',
  render: (row) => formatMoney(row.discount_amount ?? 0),
  csv: (row) => decimal(row.discount_amount),
  numeric: true,
};
const nameColumn = (label: string): Column => ({
  label,
  render: (row) => <span className="font-medium">{row.name}</span>,
  csv: (row) => row.name ?? '',
});

const REPORTS: { type: ReportType; label: string; description: string; adminOnly?: boolean; columns: Column[] }[] = [
  {
    type: 'dias',
    label: 'Por dia',
    description: 'Movimento de cada dia do período.',
    columns: [
      {
        label: 'Dia',
        render: (row) => (
          <span className="font-medium">
            {formatDay(row.day!)} <span className="font-normal text-muted-foreground">{dayOfWeek(row.day!)}</span>
          </span>
        ),
        csv: (row) => formatDay(row.day!),
      },
      countColumn('Quantidade'),
      discountColumn,
      averageColumn,
      totalColumn,
    ],
  },
  {
    type: 'lojas',
    label: 'Por loja',
    description: 'Comparativo entre as lojas da rede (cadastro de lojas).',
    adminOnly: true,
    columns: [nameColumn('Loja'), countColumn('Quantidade'), discountColumn, averageColumn, totalColumn],
  },
  {
    type: 'vendedores',
    label: 'Por vendedor',
    description: 'Desempenho de cada vendedor (cadastro de vendedores).',
    columns: [
      nameColumn('Vendedor'),
      { label: 'Loja', render: (row) => row.store_name ?? '—', csv: (row) => row.store_name ?? '' },
      countColumn('Quantidade'),
      discountColumn,
      averageColumn,
      totalColumn,
    ],
  },
  {
    type: 'produtos',
    label: 'Por produto',
    description: 'Produtos mais vendidos (cadastro de produtos). O valor é a soma dos itens, antes do desconto do pedido.',
    columns: [
      { label: 'Código', render: (row) => row.code ?? '—', csv: (row) => row.code ?? '' },
      nameColumn('Produto'),
      {
        label: 'Quantidade',
        render: (row) => formatQuantity(row.quantity ?? 0),
        csv: (row) => decimal(row.quantity),
        numeric: true,
      },
      { label: 'Unidade', render: (row) => row.unit, csv: (row) => row.unit ?? '' },
      countColumn('Nº de pedidos'),
      totalColumn,
    ],
  },
  {
    type: 'clientes',
    label: 'Por cliente',
    description: 'Clientes que mais compraram (cadastro de clientes).',
    columns: [
      nameColumn('Cliente'),
      {
        label: 'WhatsApp',
        render: (row) => <span className="whitespace-nowrap">{formatWhatsapp(row.whatsapp ?? '')}</span>,
        csv: (row) => formatWhatsapp(row.whatsapp ?? ''),
      },
      {
        label: 'Último lançamento',
        render: (row) => (row.last_date ? formatDate(row.last_date) : '—'),
        csv: (row) => (row.last_date ? formatDate(row.last_date) : ''),
      },
      countColumn('Quantidade'),
      averageColumn,
      totalColumn,
    ],
  },
  {
    type: 'formas-de-pagamento',
    label: 'Por forma de pagamento',
    description: 'Como os clientes pagam (cadastro de formas de pagamento).',
    columns: [nameColumn('Forma de pagamento'), countColumn('Quantidade'), discountColumn, averageColumn, totalColumn],
  },
];

/** Data local no formato do campo de data (YYYY-MM-DD). */
function toInputDate(date: Date) {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function presets() {
  const now = new Date();
  const today = toInputDate(now);
  const daysAgo = (n: number) => toInputDate(new Date(now.getFullYear(), now.getMonth(), now.getDate() - n));
  return [
    { label: 'Hoje', from: today, to: today },
    { label: '7 dias', from: daysAgo(6), to: today },
    { label: 'Este mês', from: toInputDate(new Date(now.getFullYear(), now.getMonth(), 1)), to: today },
    {
      label: 'Mês passado',
      from: toInputDate(new Date(now.getFullYear(), now.getMonth() - 1, 1)),
      to: toInputDate(new Date(now.getFullYear(), now.getMonth(), 0)),
    },
  ];
}

function downloadCsv(fileName: string, columns: Column[], rows: ReportRow[]) {
  // Ponto e vírgula e BOM: o Excel em português abre direto, com acentos.
  const escape = (value: string | number) => {
    const text = String(value);
    return /[";\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  };
  const lines = [columns.map((c) => escape(c.label)), ...rows.map((row) => columns.map((c) => escape(c.csv(row))))];
  const blob = new Blob([`﻿${lines.map((l) => l.join(';')).join('\r\n')}`], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName;
  link.click();
  URL.revokeObjectURL(url);
}

function Metric({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="rounded-lg border border-border bg-card px-4 py-3 sm:px-5 sm:py-4">
      <p className="text-sm text-muted-foreground">{label}</p>
      <p className="mt-1 text-xl font-bold tracking-tight tabular-nums sm:text-2xl">{value}</p>
    </div>
  );
}

export function ReportsPage() {
  useDocumentTitle('Relatórios');
  const user = useUser();
  const isAdmin = user.role === 'admin';
  const [params, setParams] = useSearchParams();
  const periods = presets();
  const thisMonth = periods[2]!;

  const available = REPORTS.filter((r) => isAdmin || !r.adminOnly);
  const report = available.find((r) => r.type === params.get('tipo')) ?? available[0]!;
  const status = params.get('situacao') === 'quote' ? 'quote' : 'order';
  // Sem período na URL, abre no mês corrente.
  const from = params.get('de') ?? thisMonth.from;
  const to = params.get('ate') ?? thisMonth.to;
  const storeId = params.get('loja') ?? '';

  function update(changes: Record<string, string | null>) {
    setParams(
      (current) => {
        const next = new URLSearchParams(current);
        for (const [key, value] of Object.entries(changes)) {
          if (value !== null) next.set(key, value);
          else next.delete(key);
        }
        return next;
      },
      { replace: true },
    );
  }

  const stores = useQuery({
    queryKey: ['stores'],
    queryFn: () => api<{ items: Store[] }>('/stores').then((r) => r.items),
    enabled: isAdmin,
  });

  const filters = { from, to, status, store_id: storeId };
  const result = useQuery({
    queryKey: ['reports', report.type, filters],
    queryFn: () => api<Report>(`/reports/${report.type}${toQuery(filters)}`),
    placeholderData: keepPreviousData,
  });

  const data = result.data;
  const totals = data?.totals;
  const documentWord = status === 'order' ? 'Pedidos' : 'Orçamentos';
  const maxTotal = Math.max(0, ...(data?.rows.map((r) => r.total_amount) ?? []));

  return (
    <div>
      <PageHeader
        title="Relatórios"
        description={isAdmin ? 'Vendas e orçamentos da rede, por cadastro.' : `Vendas e orçamentos da ${user.store_name}.`}
        actions={
          <Button
            variant="outline"
            disabled={!data?.rows.length}
            onClick={() => data && downloadCsv(`relatorio-${report.type}-${from}-a-${to}.csv`, report.columns, data.rows)}
          >
            <Download />
            Exportar CSV
          </Button>
        }
      />

      <div className="mb-4 flex gap-1 overflow-x-auto border-b border-border" role="tablist" aria-label="Tipo de relatório">
        {available.map((r) => (
          <button
            key={r.type}
            role="tab"
            aria-selected={r.type === report.type}
            onClick={() => update({ tipo: r.type })}
            className={cn(
              '-mb-px h-10 shrink-0 border-b-2 px-3 text-sm font-medium whitespace-nowrap',
              r.type === report.type
                ? 'border-primary text-foreground'
                : 'border-transparent text-muted-foreground hover:text-foreground',
            )}
          >
            {r.label}
          </button>
        ))}
      </div>

      <Card className="mb-4">
        <div className="flex flex-wrap items-end gap-3 p-4">
          <div className="flex rounded-md border border-input bg-background p-0.5" role="group" aria-label="Situação">
            {(
              [
                { value: 'order', label: 'Pedidos' },
                { value: 'quote', label: 'Orçamentos' },
              ] as const
            ).map((tab) => (
              <button
                key={tab.value}
                onClick={() => update({ situacao: tab.value === 'order' ? null : tab.value })}
                aria-pressed={status === tab.value}
                className={cn(
                  'h-8 rounded px-3 text-sm font-medium',
                  status === tab.value ? 'bg-card text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground',
                )}
              >
                {tab.label}
              </button>
            ))}
          </div>

          <div className="grid gap-1">
            <Label htmlFor="relatorio-de" className="text-xs text-muted-foreground">
              De
            </Label>
            <Input id="relatorio-de" type="date" value={from} onChange={(e) => update({ de: e.target.value })} className="w-full sm:w-40" />
          </div>
          <div className="grid gap-1">
            <Label htmlFor="relatorio-ate" className="text-xs text-muted-foreground">
              Até
            </Label>
            <Input id="relatorio-ate" type="date" value={to} onChange={(e) => update({ ate: e.target.value })} className="w-full sm:w-40" />
          </div>

          <div className="flex flex-wrap gap-1">
            {periods.map((p) => (
              <Button
                key={p.label}
                variant={p.from === from && p.to === to ? 'steel' : 'ghost'}
                size="sm"
                className="h-10"
                onClick={() => update({ de: p.from, ate: p.to })}
              >
                {p.label}
              </Button>
            ))}
          </div>

          {isAdmin && (
            <NativeSelect
              aria-label="Loja"
              value={storeId}
              onChange={(e) => update({ loja: e.target.value || null })}
              className="w-full sm:ml-auto sm:w-48"
            >
              <option value="">Todas as lojas</option>
              {stores.data?.map((store) => (
                <option key={store.id} value={store.id}>
                  {store.name}
                </option>
              ))}
            </NativeSelect>
          )}
        </div>
      </Card>

      {result.isError ? (
        <Alert variant="danger" title="Não foi possível gerar o relatório.">
          <p>{result.error.message}</p>
        </Alert>
      ) : (
        <>
          <div className="mb-4 grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-4">
            {!totals ? (
              Array.from({ length: 4 }, (_, i) => <Skeleton key={i} className="h-24" />)
            ) : (
              <>
                <Metric label={`${documentWord} no período`} value={totals.count} />
                <Metric label="Valor total" value={formatMoney(totals.total_amount)} />
                <Metric label="Ticket médio" value={formatMoney(totals.average_amount)} />
                <Metric label="Descontos concedidos" value={formatMoney(totals.discount_amount)} />
              </>
            )}
          </div>

          <Card>
            <div className="border-b border-border px-5 py-3">
              <h2 className="text-base font-semibold">
                {report.label} · {documentWord.toLowerCase()} de {formatDay(from)} a {formatDay(to)}
              </h2>
              <p className="text-sm text-muted-foreground">{report.description}</p>
            </div>
            {result.isPending ? (
              <div className="grid gap-2 p-4">
                {Array.from({ length: 6 }, (_, i) => (
                  <Skeleton key={i} className="h-10" />
                ))}
              </div>
            ) : !data?.rows.length ? (
              <EmptyState title="Nada no período" description="Mude as datas, a loja ou a situação para ver outros lançamentos." />
            ) : (
              <Table className={cn(result.isFetching && 'opacity-60')}>
                <THead>
                  <TR>
                    {report.columns.map((column, i) => (
                      <TH key={column.label} className={cn(column.numeric && 'text-right', i === 0 && 'pl-5')}>
                        {column.label}
                      </TH>
                    ))}
                    <TH className="w-40 pr-5">
                      <span className="sr-only">Participação</span>
                    </TH>
                  </TR>
                </THead>
                <TBody>
                  {data.rows.map((row, index) => (
                    <TR key={row.id ?? row.day ?? row.name ?? index}>
                      {report.columns.map((column, i) => (
                        <TD key={column.label} className={cn('tabular-nums', column.numeric && 'text-right', i === 0 && 'pl-5')}>
                          {column.render(row)}
                        </TD>
                      ))}
                      <TD className="pr-5">
                        <div className="h-2 w-full rounded-full bg-muted" aria-hidden>
                          <div
                            className="h-2 rounded-full bg-primary"
                            style={{ width: `${maxTotal > 0 ? (row.total_amount / maxTotal) * 100 : 0}%` }}
                          />
                        </div>
                      </TD>
                    </TR>
                  ))}
                </TBody>
              </Table>
            )}
          </Card>
        </>
      )}
    </div>
  );
}
