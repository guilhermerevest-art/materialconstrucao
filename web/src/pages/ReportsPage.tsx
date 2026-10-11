import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { Download } from 'lucide-react';
import { useEffect, useRef, type ReactNode } from 'react';
import { useSearchParams } from 'react-router';
import { EmptyState, PageHeader } from '@/components/shared';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input, Label, NativeSelect } from '@/components/ui/input';
import { Alert, Badge, Skeleton } from '@/components/ui/misc';
import { Table, TBody, TD, TH, THead, TR } from '@/components/ui/table';
import { api, toQuery } from '@/lib/api';
import { useUser } from '@/lib/auth';
import { formatDate, formatMoney, formatPercent, formatQuantity, formatWhatsapp } from '@/lib/format';
import { useDocumentTitle } from '@/lib/hooks';
import type { Report, ReportMetric, ReportRow, ReportType, Store } from '@/lib/types';
import { cn } from '@/lib/utils';

type Column = {
  label: string;
  /** Valor na tela. */
  render: (row: ReportRow) => ReactNode;
  /** Valor no CSV (sem formatação de moeda, para abrir como número na planilha). */
  csv: (row: ReportRow) => string | number;
  numeric?: boolean;
};

const decimal = (value: unknown) => String(value ?? 0).replace('.', ',');
const num = (row: ReportRow, key: string) => Number(row[key] ?? 0);
const text = (row: ReportRow, key: string) => (row[key] == null ? '' : String(row[key]));

/** "2026-10-09" sem passar por Date (que leria como UTC e voltaria um dia). */
const formatDay = (day: string) => day.split('-').reverse().join('/');
const weekday = new Intl.DateTimeFormat('pt-BR', { weekday: 'short' });
const dayOfWeek = (day: string) => weekday.format(new Date(`${day}T12:00:00`)).replace('.', '');

const countColumn = (label: string, key = 'count'): Column => ({
  label,
  render: (row) => num(row, key),
  csv: (row) => num(row, key),
  numeric: true,
});
const moneyColumn = (label: string, key: string, strong = false): Column => ({
  label,
  render: (row) => <span className={cn(strong && 'font-semibold')}>{formatMoney(num(row, key))}</span>,
  csv: (row) => decimal(row[key]),
  numeric: true,
});
const quantityColumn = (label: string, key = 'quantity'): Column => ({
  label,
  render: (row) => (
    <>
      {formatQuantity(num(row, key))}
      {row.unit ? <span className="ml-1 text-xs text-muted-foreground">{String(row.unit)}</span> : null}
    </>
  ),
  csv: (row) => decimal(row[key]),
  numeric: true,
});
const percentColumn = (label: string, key: string): Column => ({
  label,
  render: (row) => (row[key] == null ? '—' : formatPercent(num(row, key))),
  csv: (row) => (row[key] == null ? '' : decimal(row[key])),
  numeric: true,
});
const textColumn = (label: string, key: string): Column => ({
  label,
  render: (row) => text(row, key) || '—',
  csv: (row) => text(row, key),
});
const dateColumn = (label: string, key: string, empty = '—'): Column => ({
  label,
  render: (row) => (row[key] ? formatDate(text(row, key)) : empty),
  csv: (row) => (row[key] ? formatDate(text(row, key)) : ''),
});
const totalColumn = moneyColumn('Total', 'total_amount', true);
const averageColumn = moneyColumn('Ticket médio', 'average_amount');
const discountColumn = moneyColumn('Descontos', 'discount_amount');
const nameColumn = (label: string): Column => ({
  label,
  render: (row) => <span className="font-medium">{row.name}</span>,
  csv: (row) => row.name ?? '',
});
const codeColumn: Column = { label: 'Código', render: (row) => row.code ?? '—', csv: (row) => row.code ?? '' };
const whatsappColumn: Column = {
  label: 'WhatsApp',
  render: (row) => <span className="whitespace-nowrap">{formatWhatsapp(row.whatsapp ?? '')}</span>,
  csv: (row) => formatWhatsapp(row.whatsapp ?? ''),
};
const dayColumn: Column = {
  label: 'Dia',
  render: (row) => (
    <span className="font-medium whitespace-nowrap">
      {formatDay(row.day!)} <span className="font-normal text-muted-foreground">{dayOfWeek(row.day!)}</span>
    </span>
  ),
  csv: (row) => formatDay(row.day!),
};

type Group = 'vendas' | 'estoque' | 'financeiro';

type ReportDef = {
  type: ReportType;
  group: Group;
  label: string;
  description: string;
  adminOnly?: boolean;
  /** Só aparece com o módulo ligado. */
  needs?: 'finance' | 'credit';
  /** Pedidos ou orçamentos (os relatórios de pedidos agrupados). */
  status?: boolean;
  /** Usa o período (estoque de hoje e inadimplência não usam). */
  period?: boolean;
  /** Estoque parado: dias sem venda. */
  days?: boolean;
  columns: Column[];
  /** Coluna da barra de participação; nula esconde a barra. */
  bar?: string | null;
};

const GROUPS: { value: Group; label: string }[] = [
  { value: 'vendas', label: 'Vendas' },
  { value: 'estoque', label: 'Estoque e compras' },
  { value: 'financeiro', label: 'Financeiro' },
];

const REPORTS: ReportDef[] = [
  {
    type: 'dias',
    group: 'vendas',
    label: 'Por dia',
    description: 'Movimento de cada dia do período.',
    status: true,
    columns: [dayColumn, countColumn('Quantidade'), discountColumn, averageColumn, totalColumn],
  },
  {
    type: 'lojas',
    group: 'vendas',
    label: 'Por loja',
    description: 'Comparativo entre as lojas da rede (cadastro de lojas).',
    adminOnly: true,
    status: true,
    columns: [nameColumn('Loja'), countColumn('Quantidade'), discountColumn, averageColumn, totalColumn],
  },
  {
    type: 'vendedores',
    group: 'vendas',
    label: 'Por vendedor',
    description: 'Desempenho de cada vendedor (cadastro de vendedores).',
    status: true,
    columns: [nameColumn('Vendedor'), textColumn('Loja', 'store_name'), countColumn('Quantidade'), discountColumn, averageColumn, totalColumn],
  },
  {
    type: 'produtos',
    group: 'vendas',
    label: 'Por produto',
    description: 'Produtos mais vendidos (cadastro de produtos). O valor é a soma dos itens, antes do desconto do pedido.',
    status: true,
    columns: [codeColumn, nameColumn('Produto'), quantityColumn('Quantidade'), countColumn('Nº de pedidos'), totalColumn],
  },
  {
    type: 'clientes',
    group: 'vendas',
    label: 'Por cliente',
    description: 'Clientes que mais compraram (cadastro de clientes).',
    status: true,
    columns: [nameColumn('Cliente'), whatsappColumn, dateColumn('Último lançamento', 'last_date'), countColumn('Quantidade'), averageColumn, totalColumn],
  },
  {
    type: 'formas-de-pagamento',
    group: 'vendas',
    label: 'Por forma de pagamento',
    description: 'Como os clientes pagam (cadastro de formas de pagamento).',
    status: true,
    columns: [nameColumn('Forma de pagamento'), countColumn('Quantidade'), discountColumn, averageColumn, totalColumn],
  },
  {
    type: 'conversao',
    group: 'vendas',
    label: 'Conversão de orçamentos',
    description: 'Orçamentos feitos no período por vendedor: quantos viraram pedido, quantos se perderam e em quanto tempo fecharam.',
    bar: 'converted_amount',
    columns: [
      nameColumn('Vendedor'),
      countColumn('Orçamentos'),
      countColumn('Viraram pedido', 'converted'),
      countColumn('Perdidos', 'lost'),
      countColumn('Em aberto', 'open'),
      percentColumn('Conversão', 'rate'),
      moneyColumn('Valor orçado', 'quoted_amount'),
      moneyColumn('Valor convertido', 'converted_amount', true),
      {
        label: 'Dias até fechar',
        render: (row) => (row.avg_days == null ? '—' : decimal(row.avg_days)),
        csv: (row) => (row.avg_days == null ? '' : decimal(row.avg_days)),
        numeric: true,
      },
    ],
  },
  {
    type: 'comissao',
    group: 'vendas',
    label: 'Comissão',
    description:
      'Venda confirmada no período, menos as devoluções do período, vezes o percentual do vendedor (ou o padrão da loja). Pedido cancelado não conta.',
    bar: 'commission',
    columns: [
      nameColumn('Vendedor'),
      textColumn('Loja', 'store_name'),
      countColumn('Pedidos'),
      moneyColumn('Vendas', 'sales'),
      moneyColumn('Devoluções', 'returned'),
      moneyColumn('Base', 'base'),
      percentColumn('%', 'percent'),
      moneyColumn('Comissão', 'commission', true),
    ],
  },
  {
    type: 'devolucoes',
    group: 'vendas',
    label: 'Devoluções',
    description: 'O que voltou no período, por produto, e quanto voltou avariado.',
    bar: 'amount',
    columns: [
      nameColumn('Produto'),
      quantityColumn('Quantidade'),
      quantityColumn('Avariado', 'damaged'),
      countColumn('Devoluções'),
      moneyColumn('Valor', 'amount', true),
    ],
  },
  {
    type: 'curva-abc',
    group: 'estoque',
    label: 'Curva ABC e giro',
    description:
      'A são os produtos que somam 80% da venda do período, B até 95%, C o resto. Giro = vendido ÷ estoque de hoje; cobertura = dias que o estoque dura nesse ritmo.',
    bar: 'revenue',
    columns: [
      {
        label: 'Classe',
        render: (row) => (
          <Badge variant={row.class === 'A' ? 'success' : row.class === 'B' ? 'quote' : 'neutral'}>{text(row, 'class')}</Badge>
        ),
        csv: (row) => text(row, 'class'),
      },
      codeColumn,
      nameColumn('Produto'),
      quantityColumn('Vendido'),
      moneyColumn('Venda líquida', 'revenue', true),
      percentColumn('Participação', 'share'),
      percentColumn('Acumulado', 'cumulative'),
      quantityColumn('Estoque', 'stock'),
      {
        label: 'Giro',
        render: (row) => (row.turnover == null ? '—' : decimal(row.turnover)),
        csv: (row) => (row.turnover == null ? '' : decimal(row.turnover)),
        numeric: true,
      },
      {
        label: 'Cobertura',
        render: (row) => (row.coverage_days == null ? '—' : `${num(row, 'coverage_days')} dias`),
        csv: (row) => (row.coverage_days == null ? '' : num(row, 'coverage_days')),
        numeric: true,
      },
    ],
  },
  {
    type: 'estoque-parado',
    group: 'estoque',
    label: 'Estoque parado',
    description: 'Produtos com saldo e sem venda há mais dias que o escolhido (ou nunca vendidos), com o valor parado a custo.',
    period: false,
    days: true,
    bar: 'value',
    columns: [
      codeColumn,
      nameColumn('Produto'),
      quantityColumn('Saldo'),
      moneyColumn('Custo', 'cost_price'),
      moneyColumn('Valor parado', 'value', true),
      dateColumn('Última venda', 'last_sale_at', 'Nunca'),
      {
        label: 'Dias parado',
        render: (row) => (row.days_stopped == null ? '—' : num(row, 'days_stopped')),
        csv: (row) => (row.days_stopped == null ? '' : num(row, 'days_stopped')),
        numeric: true,
      },
    ],
  },
  {
    type: 'estoque-valorizado',
    group: 'estoque',
    label: 'Estoque valorizado',
    description: 'O estoque de hoje a custo (último custo de compra) e a preço de venda.',
    adminOnly: true,
    period: false,
    bar: 'cost_value',
    columns: [
      codeColumn,
      nameColumn('Produto'),
      quantityColumn('Saldo'),
      moneyColumn('Custo', 'cost_price'),
      moneyColumn('Preço', 'price'),
      moneyColumn('Valor a custo', 'cost_value', true),
      moneyColumn('Valor a preço', 'price_value'),
    ],
  },
  {
    type: 'margem',
    group: 'estoque',
    label: 'Margem',
    description:
      'Venda líquida do período (com o desconto do pedido rateado) menos o custo do produto gravado quando o pedido foi confirmado.',
    adminOnly: true,
    bar: 'margin',
    columns: [
      codeColumn,
      nameColumn('Produto'),
      quantityColumn('Vendido'),
      moneyColumn('Venda líquida', 'revenue'),
      moneyColumn('Custo', 'cost'),
      moneyColumn('Margem', 'margin', true),
      percentColumn('Margem %', 'margin_percent'),
      moneyColumn('Venda sem custo', 'revenue_without_cost'),
    ],
  },
  {
    type: 'compras',
    group: 'estoque',
    label: 'Compras',
    description: 'Notas de compra lançadas no período, por fornecedor.',
    adminOnly: true,
    bar: 'total_amount',
    columns: [
      nameColumn('Fornecedor'),
      countColumn('Notas'),
      totalColumn,
      dateColumn('Última nota', 'last_date'),
      countColumn('Pedidos abertos', 'open_orders'),
      moneyColumn('A pagar', 'open_payables'),
    ],
  },
  {
    type: 'divergencias',
    group: 'estoque',
    label: 'Divergências de contagem',
    description:
      'Produtos das contagens cegas conferidas no período com diferença entre o esperado (saldo + vendido ainda não entregue) e o contado, e o valor a custo.',
    adminOnly: true,
    bar: null,
    columns: [
      countColumn('Contagem', 'count_id'),
      textColumn('Loja', 'store_name'),
      codeColumn,
      nameColumn('Produto'),
      quantityColumn('Esperado', 'expected'),
      quantityColumn('Contado', 'counted'),
      {
        label: 'Diferença',
        render: (row) => (
          <span className={cn('font-semibold', num(row, 'difference') < 0 ? 'text-destructive' : 'text-success')}>
            {num(row, 'difference') > 0 ? '+' : ''}
            {formatQuantity(num(row, 'difference'))}
          </span>
        ),
        csv: (row) => decimal(row.difference),
        numeric: true,
      },
      moneyColumn('Valor', 'value', true),
      {
        label: 'Situação',
        render: (row) => (row.outcome === 'adjusted' ? 'Ajustado' : 'Mantido'),
        csv: (row) => (row.outcome === 'adjusted' ? 'Ajustado' : 'Mantido'),
      },
    ],
  },
  {
    type: 'inadimplencia',
    group: 'financeiro',
    label: 'Inadimplência',
    description: 'Quem está em atraso hoje, somando parcelas do crediário e compras do fiado, por faixa de dias.',
    needs: 'credit',
    period: false,
    bar: 'total_amount',
    columns: [
      nameColumn('Cliente'),
      whatsappColumn,
      moneyColumn('Até 30 dias', 'd30'),
      moneyColumn('31 a 60', 'd60'),
      moneyColumn('61 a 90', 'd90'),
      moneyColumn('Mais de 90', 'd90plus'),
      moneyColumn('Do fiado', 'fiado'),
      moneyColumn('Total vencido', 'total_amount', true),
      countColumn('Dias de atraso', 'days_late'),
    ],
  },
  {
    type: 'fluxo-de-caixa',
    group: 'financeiro',
    label: 'Fluxo de caixa',
    description:
      'Por dia: o que entrou (parcelas e fiado recebidos), o que saiu (contas pagas e devoluções em dinheiro, PIX ou cartão) e o que vence a receber e a pagar.',
    adminOnly: true,
    needs: 'finance',
    bar: null,
    columns: [
      dayColumn,
      moneyColumn('Entrou', 'received'),
      moneyColumn('Saiu', 'paid'),
      {
        label: 'Saldo do dia',
        render: (row) => (
          <span className={cn('font-semibold', num(row, 'balance') < 0 && 'text-destructive')}>{formatMoney(num(row, 'balance'))}</span>
        ),
        csv: (row) => decimal(row.balance),
        numeric: true,
      },
      moneyColumn('Vence a receber', 'to_receive'),
      moneyColumn('Vence a pagar', 'to_pay'),
    ],
  },
];

const STALE_DAYS = [30, 60, 90, 180, 365];

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
    const raw = String(value);
    return /[";\n]/.test(raw) ? `"${raw.replace(/"/g, '""')}"` : raw;
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

const formatMetric = (metric: ReportMetric) =>
  metric.format === 'money' ? formatMoney(metric.value) : metric.format === 'percent' ? formatPercent(metric.value) : formatQuantity(metric.value);

export function ReportsPage() {
  useDocumentTitle('Relatórios');
  const user = useUser();
  const isAdmin = user.role === 'admin';
  const [params, setParams] = useSearchParams();
  const periods = presets();
  const thisMonth = periods[2]!;

  const available = REPORTS.filter(
    (r) =>
      (isAdmin || !r.adminOnly) &&
      (r.needs !== 'finance' || user.finance_enabled) &&
      (r.needs !== 'credit' || user.finance_enabled || user.fiado_enabled),
  );
  const report = available.find((r) => r.type === params.get('tipo')) ?? available[0]!;
  const groups = GROUPS.filter((g) => available.some((r) => r.group === g.value));
  const usesPeriod = report.period !== false;
  const status = report.status && params.get('situacao') === 'quote' ? 'quote' : 'order';
  // Sem período na URL, abre no mês corrente.
  const from = params.get('de') ?? thisMonth.from;
  const to = params.get('ate') ?? thisMonth.to;
  const storeId = params.get('loja') ?? '';
  const days = Number(params.get('dias')) || 90;
  // No celular a faixa de abas rola: a aba aberta (ex.: vinda de um link) precisa aparecer.
  const activeTab = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    activeTab.current?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [report.type]);

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

  const filters = {
    from: usesPeriod ? from : null,
    to: usesPeriod ? to : null,
    status: report.status ? status : null,
    store_id: storeId,
    dias: report.days ? days : null,
  };
  const result = useQuery({
    queryKey: ['reports', report.type, filters],
    queryFn: () => api<Report>(`/reports/${report.type}${toQuery(filters)}`),
    // Mudando só o filtro, a tabela anterior fica até a nova chegar; mudando o relatório, não
    // (as colunas são outras).
    placeholderData: (previous, previousQuery) => (previousQuery?.queryKey[1] === report.type ? keepPreviousData(previous) : undefined),
  });

  const data = result.data;
  const documentWord = status === 'order' ? 'Pedidos' : 'Orçamentos';
  const bar = report.bar === undefined ? 'total_amount' : report.bar;
  const maxBar = bar ? Math.max(0, ...(data?.rows.map((r) => num(r, bar)) ?? [])) : 0;
  const metrics: { label: string; value: ReactNode }[] | null = data?.metrics
    ? data.metrics.map((m) => ({ label: m.label, value: formatMetric(m) }))
    : data?.totals
      ? [
          { label: `${documentWord} no período`, value: data.totals.count },
          { label: 'Valor total', value: formatMoney(data.totals.total_amount) },
          { label: 'Ticket médio', value: formatMoney(data.totals.average_amount) },
          { label: 'Descontos concedidos', value: formatMoney(data.totals.discount_amount) },
        ]
      : null;
  const subtitle = usesPeriod
    ? `${report.status ? `${documentWord.toLowerCase()} de ` : ''}${formatDay(from)} a ${formatDay(to)}`
    : report.days
      ? `sem venda há ${days} dias ou mais`
      : 'hoje';

  return (
    <div>
      <PageHeader
        title="Relatórios"
        description={isAdmin ? 'Vendas, estoque e financeiro da rede.' : `Vendas e estoque da ${user.store_name}.`}
        actions={
          <Button
            variant="outline"
            disabled={!data?.rows.length}
            onClick={() =>
              data && downloadCsv(`relatorio-${report.type}${usesPeriod ? `-${from}-a-${to}` : ''}.csv`, report.columns, data.rows)
            }
          >
            <Download />
            Exportar CSV
          </Button>
        }
      />

      {groups.length > 1 && (
        <div className="mb-2 flex rounded-md border border-input bg-background p-0.5 sm:inline-flex" role="group" aria-label="Área">
          {groups.map((g) => (
            <button
              key={g.value}
              onClick={() => update({ tipo: available.find((r) => r.group === g.value)!.type })}
              aria-pressed={report.group === g.value}
              className={cn(
                'h-8 flex-1 rounded px-3 text-sm font-medium whitespace-nowrap',
                report.group === g.value ? 'bg-card text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground',
              )}
            >
              {g.label}
            </button>
          ))}
        </div>
      )}

      <div className="mb-4 flex gap-1 overflow-x-auto border-b border-border" role="tablist" aria-label="Tipo de relatório">
        {available
          .filter((r) => r.group === report.group)
          .map((r) => (
            <button
              key={r.type}
              ref={r.type === report.type ? activeTab : undefined}
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
          {report.status && (
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
          )}

          {usesPeriod && (
            <>
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
            </>
          )}

          {report.days && (
            <div className="grid gap-1">
              <Label htmlFor="relatorio-dias" className="text-xs text-muted-foreground">
                Sem venda há
              </Label>
              <NativeSelect id="relatorio-dias" value={days} onChange={(e) => update({ dias: e.target.value })} className="w-full sm:w-40">
                {STALE_DAYS.map((d) => (
                  <option key={d} value={d}>
                    {d} dias ou mais
                  </option>
                ))}
              </NativeSelect>
            </div>
          )}

          {!usesPeriod && !report.days && <p className="text-sm text-muted-foreground">Situação de hoje: o período não se aplica.</p>}

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
            {!metrics || result.isPlaceholderData
              ? Array.from({ length: 4 }, (_, i) => <Skeleton key={i} className="h-24" />)
              : metrics.map((m) => <Metric key={m.label} label={m.label} value={m.value} />)}
          </div>

          <Card>
            <div className="border-b border-border px-5 py-3">
              <h2 className="text-base font-semibold">
                {report.label} · {subtitle}
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
              <EmptyState
                title={usesPeriod ? 'Nada no período' : 'Nada por aqui'}
                description={usesPeriod ? 'Mude as datas ou a loja para ver outros lançamentos.' : undefined}
              />
            ) : (
              <Table className={cn(result.isFetching && 'opacity-60')}>
                <THead>
                  <TR>
                    {report.columns.map((column, i) => (
                      <TH key={column.label} className={cn('whitespace-nowrap', column.numeric && 'text-right', i === 0 && 'pl-5')}>
                        {column.label}
                      </TH>
                    ))}
                    {bar && (
                      <TH className="w-40 pr-5">
                        <span className="sr-only">Participação</span>
                      </TH>
                    )}
                  </TR>
                </THead>
                <TBody>
                  {data.rows.map((row, index) => (
                    <TR key={String(row.id ?? row.day ?? row.name ?? index)}>
                      {report.columns.map((column, i) => (
                        <TD key={column.label} className={cn('tabular-nums', column.numeric && 'text-right', i === 0 && 'pl-5')}>
                          {column.render(row)}
                        </TD>
                      ))}
                      {bar && (
                        <TD className="pr-5">
                          <div className="h-2 w-full rounded-full bg-muted" aria-hidden>
                            <div
                              className="h-2 rounded-full bg-primary"
                              style={{ width: `${maxBar > 0 ? (Math.max(0, num(row, bar)) / maxBar) * 100 : 0}%` }}
                            />
                          </div>
                        </TD>
                      )}
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
