import type pg from 'pg';
import type { AuthUser } from '../auth.js';
import { FIADO_OPEN_DEBITS_CTE } from '../fiado/queries.js';
import { HttpError } from '../errors.js';

/** Número de destaque do relatório (os quadros acima da tabela). */
export type Metric = { label: string; value: number; format: 'money' | 'number' | 'percent' };

export type ExtraReport = { rows: Record<string, unknown>[]; metrics: Metric[] };

export type ReportContext = {
  db: pg.PoolClient;
  user: AuthUser;
  /** Período em dias da loja ("2026-10-01"), já validado. */
  from: string;
  to: string;
  /** Loja: a do vendedor, a escolhida pelo admin ou nula (todas). */
  storeId: number | null;
  timeZone: string;
  today: string;
  /** Dias sem venda para o estoque parado. */
  days: number;
};

const round = (value: number, places = 2) => Math.round(value * 10 ** places) / 10 ** places;
const sum = (rows: Record<string, unknown>[], key: string) => round(rows.reduce((acc, r) => acc + Number(r[key] ?? 0), 0));

function adminOnly(user: AuthUser) {
  if (user.role !== 'admin') throw new HttpError(403, 'Este relatório é do administrador.');
}

/** Intervalo [from, to] em dias da loja, como timestamps: `col >= $a and col < $b`. */
function period(ctx: ReportContext, params: unknown[], column: string) {
  params.push(ctx.from, ctx.to, ctx.timeZone);
  const n = params.length;
  return `${column} >= ($${n - 2}::date)::timestamp at time zone $${n} and ${column} < ($${n - 1}::date + 1)::timestamp at time zone $${n}`;
}

function storeWhere(ctx: ReportContext, params: unknown[], column: string) {
  if (ctx.storeId === null) return 'true';
  params.push(ctx.storeId);
  return `${column} = $${params.length}`;
}

/**
 * Comissão sobre a venda confirmada no período, menos as devoluções do período dos
 * pedidos do vendedor. Pedido cancelado não conta. O vendedor vê só a própria.
 */
async function commission(ctx: ReportContext): Promise<ExtraReport> {
  const params: unknown[] = [];
  const salesPeriod = period(ctx, params, 'o.confirmed_at');
  const salesStore = storeWhere(ctx, params, 'o.store_id');
  const returnsPeriod = period(ctx, params, 'r.created_at');
  const returnsStore = storeWhere(ctx, params, 'r.store_id');
  let only = 'true';
  if (ctx.user.role !== 'admin') {
    params.push(ctx.user.id);
    only = `u.id = $${params.length}`;
  }
  const { rows } = await ctx.db.query(
    `with sales as (
       select o.user_id, count(*) as count, sum(o.total_amount) as sales
         from orders o
        where o.status = 'order' and ${salesPeriod} and ${salesStore}
        group by o.user_id
     ), returns as (
       select o.user_id, sum(r.amount) as returned
         from order_returns r join orders o on o.id = r.order_id
        where ${returnsPeriod} and ${returnsStore}
        group by o.user_id
     ), st as (select default_commission_percent from settings limit 1)
     select u.id, u.name, s.name as store_name,
            coalesce(sa.count, 0) as count, coalesce(sa.sales, 0) as sales, coalesce(re.returned, 0) as returned,
            coalesce(sa.sales, 0) - coalesce(re.returned, 0) as base,
            coalesce(u.commission_percent, (select default_commission_percent from st)) as percent,
            round((coalesce(sa.sales, 0) - coalesce(re.returned, 0))
                  * coalesce(u.commission_percent, (select default_commission_percent from st), 0) / 100, 2) as commission
       from users u
       left join stores s on s.id = u.store_id
       left join sales sa on sa.user_id = u.id
       left join returns re on re.user_id = u.id
      where (sa.user_id is not null or re.user_id is not null) and ${only}
      order by commission desc, base desc, u.name`,
    params,
  );
  return {
    rows,
    metrics: [
      { label: 'Vendas confirmadas', value: sum(rows, 'sales'), format: 'money' },
      { label: 'Devoluções', value: sum(rows, 'returned'), format: 'money' },
      { label: 'Base da comissão', value: sum(rows, 'base'), format: 'money' },
      { label: 'Comissão', value: sum(rows, 'commission'), format: 'money' },
    ],
  };
}

/**
 * Orçamentos feitos no período e o que virou venda. O pedido criado direto nasce com a
 * confirmação igual à criação; o orçamento convertido tem a confirmação depois.
 */
async function conversion(ctx: ReportContext): Promise<ExtraReport> {
  const params: unknown[] = [];
  const created = period(ctx, params, 'o.created_at');
  const store = storeWhere(ctx, params, 'o.store_id');
  const { rows } = await ctx.db.query(
    `select u.id, u.name,
            count(*) as count,
            count(*) filter (where o.confirmed_at > o.created_at) as converted,
            count(*) filter (where o.cancelled_from = 'quote') as lost,
            count(*) filter (where o.status = 'quote') as open,
            sum(o.total_amount) as quoted_amount,
            coalesce(sum(o.total_amount) filter (where o.confirmed_at > o.created_at), 0) as converted_amount,
            round(100.0 * count(*) filter (where o.confirmed_at > o.created_at) / count(*), 1) as rate,
            round((avg(extract(epoch from (o.confirmed_at - o.created_at)) / 86400)
                   filter (where o.confirmed_at > o.created_at))::numeric, 1) as avg_days
       from orders o join users u on u.id = o.user_id
      where ${created} and ${store}
        and (o.status = 'quote' or o.cancelled_from = 'quote' or o.confirmed_at > o.created_at)
      group by u.id, u.name
      order by converted_amount desc, u.name`,
    params,
  );
  const count = sum(rows, 'count');
  const converted = sum(rows, 'converted');
  return {
    rows,
    metrics: [
      { label: 'Orçamentos feitos', value: count, format: 'number' },
      { label: 'Viraram pedido', value: converted, format: 'number' },
      { label: 'Taxa de conversão', value: count ? round((100 * converted) / count, 1) : 0, format: 'percent' },
      { label: 'Valor convertido', value: sum(rows, 'converted_amount'), format: 'money' },
    ],
  };
}

/** Devoluções do período por produto, com o quanto voltou avariado. */
async function returnsReport(ctx: ReportContext): Promise<ExtraReport> {
  const params: unknown[] = [];
  const created = period(ctx, params, 'r.created_at');
  const store = storeWhere(ctx, params, 'r.store_id');
  const { rows } = await ctx.db.query(
    `select i.product_id as id, max(i.product_name) as name, i.unit,
            sum(i.quantity) as quantity, coalesce(sum(i.quantity) filter (where not i.restock), 0) as damaged,
            sum(i.amount) as amount, count(distinct r.id) as count
       from order_returns r join order_return_items i on i.return_id = r.id
      where ${created} and ${store}
      group by i.product_id, i.unit
      order by amount desc, name
      limit 500`,
    params,
  );
  const methods = await ctx.db.query<{ refund_method: string; amount: number; count: number }>(
    `select r.refund_method, sum(r.amount) as amount, count(*) as count
       from order_returns r where ${created} and ${store} group by r.refund_method`,
    params,
  );
  const by = (method: string) => methods.rows.find((m) => m.refund_method === method)?.amount ?? 0;
  return {
    rows,
    metrics: [
      { label: 'Devoluções', value: methods.rows.reduce((acc, m) => acc + m.count, 0), format: 'number' },
      { label: 'Valor devolvido', value: round(methods.rows.reduce((acc, m) => acc + m.amount, 0)), format: 'money' },
      { label: 'Virou crédito (troca)', value: by('credit'), format: 'money' },
      { label: 'Devolvido em dinheiro, PIX ou cartão', value: round(by('cash') + by('pix') + by('card')), format: 'money' },
    ],
  };
}

/**
 * Curva ABC do período: A são os produtos que somam 80% da venda, B até 95%, C o resto.
 * Com o giro (vendido ÷ estoque de hoje) e quantos dias o estoque cobre nesse ritmo.
 */
async function abc(ctx: ReportContext): Promise<ExtraReport> {
  const params: unknown[] = [];
  const confirmed = period(ctx, params, 'o.confirmed_at');
  const store = storeWhere(ctx, params, 'o.store_id');
  const balanceStore = ctx.storeId === null ? 'true' : `b.store_id = $${params.indexOf(ctx.storeId) + 1}`;
  params.push(ctx.from, ctx.to);
  const days = `greatest(1, ($${params.length}::date - $${params.length - 1}::date) + 1)`;
  const { rows } = await ctx.db.query(
    `with sold as (
       select i.product_id, max(i.product_code) as code, max(i.product_name) as name, max(i.unit) as unit,
              sum(i.quantity) as quantity,
              -- Receita líquida: o desconto do pedido rateado entre os itens.
              sum(case when o.subtotal_amount > 0 then i.subtotal * o.total_amount / o.subtotal_amount else i.subtotal end) as revenue
         from orders o join order_items i on i.order_id = o.id
        where o.status = 'order' and ${confirmed} and ${store}
        group by i.product_id
     ), ranked as (
       select s.*, sum(s.revenue) over () as total,
              sum(s.revenue) over (order by s.revenue desc, s.product_id rows unbounded preceding) as cum
         from sold s
     )
     select r.product_id as id, r.code, r.name, r.unit, r.quantity, round(r.revenue, 2) as revenue,
            round(100 * r.revenue / nullif(r.total, 0), 2) as share,
            round(100 * r.cum / nullif(r.total, 0), 2) as cumulative,
            case when r.cum - r.revenue < 0.8 * r.total then 'A' when r.cum - r.revenue < 0.95 * r.total then 'B' else 'C' end as class,
            stock.quantity as stock,
            case when stock.quantity > 0 then round(r.quantity / stock.quantity, 2) end as turnover,
            case when r.quantity > 0 and stock.quantity > 0 then round(stock.quantity / (r.quantity / ${days}))::int end as coverage_days
       from ranked r
       left join lateral (
         select coalesce(sum(b.quantity), 0) as quantity from stock_balances b where b.product_id = r.product_id and ${balanceStore}
       ) stock on true
      order by r.revenue desc, r.name
      limit 1000`,
    params,
  );
  const count = (cls: string) => rows.filter((r) => r.class === cls).length;
  return {
    rows,
    metrics: [
      { label: 'Produtos vendidos', value: rows.length, format: 'number' },
      { label: 'Classe A (80% da venda)', value: count('A'), format: 'number' },
      { label: 'Classe B (15%)', value: count('B'), format: 'number' },
      { label: 'Venda líquida', value: sum(rows, 'revenue'), format: 'money' },
    ],
  };
}

/** Produtos com estoque e sem venda há `days` dias (ou nunca vendidos), com o valor parado a custo. */
async function stale(ctx: ReportContext): Promise<ExtraReport> {
  const params: unknown[] = [ctx.days];
  const store = storeWhere(ctx, params, 'b.store_id');
  const saleStore = ctx.storeId === null ? 'true' : `o.store_id = $${params.length}`;
  const { rows } = await ctx.db.query(
    `with stock as (
       select b.product_id, sum(b.quantity) as quantity from stock_balances b where ${store} group by b.product_id
     )
     select p.id, p.code, p.name, p.unit, st.quantity, p.cost_price,
            round(st.quantity * coalesce(p.cost_price, 0), 2) as value,
            last.at as last_sale_at,
            case when last.at is not null then (current_date - last.at::date) end as days_stopped
       from stock st
       join products p on p.id = st.product_id
       left join lateral (
         select max(o.confirmed_at) as at
           from order_items i join orders o on o.id = i.order_id
          where i.product_id = p.id and o.status = 'order' and ${saleStore}
       ) last on true
      where p.active and p.track_stock and st.quantity > 0
        and (last.at is null or last.at < now() - make_interval(days => $1::int))
      order by value desc, p.name
      limit 1000`,
    params,
  );
  return {
    rows,
    metrics: [
      { label: `Produtos parados (${ctx.days}+ dias)`, value: rows.length, format: 'number' },
      { label: 'Valor parado (a custo)', value: sum(rows, 'value'), format: 'money' },
      { label: 'Nunca vendidos', value: rows.filter((r) => r.last_sale_at === null).length, format: 'number' },
    ],
  };
}

/** Estoque de hoje a custo e a preço de venda. */
async function valuation(ctx: ReportContext): Promise<ExtraReport> {
  adminOnly(ctx.user);
  const params: unknown[] = [];
  const store = storeWhere(ctx, params, 'b.store_id');
  const { rows } = await ctx.db.query(
    `select p.id, p.code, p.name, p.unit, sum(b.quantity) as quantity, p.cost_price, p.price,
            round(sum(b.quantity) * coalesce(p.cost_price, 0), 2) as cost_value,
            round(sum(b.quantity) * p.price, 2) as price_value
       from stock_balances b join products p on p.id = b.product_id
      where ${store} and p.active and p.track_stock
      group by p.id
     having sum(b.quantity) > 0
      order by cost_value desc, p.name
      limit 2000`,
    params,
  );
  const cost = sum(rows, 'cost_value');
  const price = sum(rows, 'price_value');
  return {
    rows,
    metrics: [
      { label: 'Estoque a custo', value: cost, format: 'money' },
      { label: 'Estoque a preço de venda', value: price, format: 'money' },
      { label: 'Produtos com saldo', value: rows.length, format: 'number' },
      { label: 'Sem custo cadastrado', value: rows.filter((r) => r.cost_price === null).length, format: 'number' },
    ],
  };
}

/** Quem deve e está atrasado: parcelas do crediário e compras do fiado, por faixa de atraso. */
async function overdue(ctx: ReportContext): Promise<ExtraReport> {
  const params: unknown[] = [ctx.today];
  const store = storeWhere(ctx, params, 'r.store_id');
  const { rows } = await ctx.db.query(
    `with ${FIADO_OPEN_DEBITS_CTE}, debts as (
       select r.client_id, r.due_date, r.amount - r.paid_amount as remaining, 'parcela' as source
         from receivables r where r.status = 'open' and r.due_date < $1::date and ${store}
       union all
       select client_id, due_date, remaining, 'fiado' from fiado_open_debits where due_date < $1::date
     )
     select c.id, c.name, c.whatsapp,
            round(sum(d.remaining), 2) as total_amount,
            round(coalesce(sum(d.remaining) filter (where $1::date - d.due_date <= 30), 0), 2) as d30,
            round(coalesce(sum(d.remaining) filter (where $1::date - d.due_date between 31 and 60), 0), 2) as d60,
            round(coalesce(sum(d.remaining) filter (where $1::date - d.due_date between 61 and 90), 0), 2) as d90,
            round(coalesce(sum(d.remaining) filter (where $1::date - d.due_date > 90), 0), 2) as d90plus,
            round(coalesce(sum(d.remaining) filter (where d.source = 'fiado'), 0), 2) as fiado,
            min(d.due_date)::text as oldest, $1::date - min(d.due_date) as days_late
       from debts d join clients c on c.id = d.client_id
      group by c.id
      order by total_amount desc, c.name
      limit 1000`,
    params,
  );
  return {
    rows,
    metrics: [
      { label: 'Total vencido', value: sum(rows, 'total_amount'), format: 'money' },
      { label: 'Clientes em atraso', value: rows.length, format: 'number' },
      { label: 'Até 30 dias', value: sum(rows, 'd30'), format: 'money' },
      { label: 'Mais de 90 dias', value: sum(rows, 'd90plus'), format: 'money' },
    ],
  };
}

/**
 * Fluxo de caixa por dia: o que entrou (parcelas e fiado recebidos), o que saiu (contas
 * pagas e devoluções em dinheiro, PIX ou cartão) e o que vence a receber e a pagar.
 */
async function cashFlow(ctx: ReportContext): Promise<ExtraReport> {
  adminOnly(ctx.user);
  const params: unknown[] = [ctx.from, ctx.to, ctx.timeZone];
  let store = 'true';
  if (ctx.storeId !== null) {
    params.push(ctx.storeId);
    store = `$${params.length}`;
  }
  const storeOf = (column: string) => (store === 'true' ? 'true' : `${column} = ${store}`);
  const day = (column: string) => `(${column} at time zone $3)::date`;
  const { rows } = await ctx.db.query(
    `with days as (
       select d::date as day from generate_series($1::date, $2::date, interval '1 day') d
     ), moves as (
       select ${day('p.received_at')} as day, p.amount as received, 0::numeric as paid
         from receivable_payments p join receivables r on r.id = p.receivable_id
        where p.reversed_at is null and ${storeOf('r.store_id')}
       union all
       select ${day('f.created_at')}, -f.amount, 0
         from fiado_entries f left join cash_sessions cs on cs.id = f.cash_session_id
        where f.kind = 'payment' and f.cancelled_at is null and ${store === 'true' ? 'true' : `(cs.store_id is null or cs.store_id = ${store})`}
       union all
       select pp.paid_on, 0, pp.amount
         from payable_payments pp join payables pb on pb.id = pp.payable_id
        where pp.reversed_at is null and ${storeOf('pb.store_id')}
       union all
       select ${day('r.created_at')}, 0, r.amount
         from order_returns r
        where r.refund_method in ('cash', 'pix', 'card') and ${storeOf('r.store_id')}
     ), due as (
       select due_date as day, (amount - paid_amount) as to_receive, 0::numeric as to_pay
         from receivables where status = 'open' and ${storeOf('store_id')}
       union all
       select due_date, 0, amount - paid_amount from payables where status = 'open' and ${storeOf('store_id')}
     )
     select to_char(d.day, 'YYYY-MM-DD') as day,
            coalesce((select sum(received) from moves m where m.day = d.day), 0) as received,
            coalesce((select sum(paid) from moves m where m.day = d.day), 0) as paid,
            coalesce((select sum(received) - sum(paid) from moves m where m.day = d.day), 0) as balance,
            coalesce((select sum(to_receive) from due x where x.day = d.day), 0) as to_receive,
            coalesce((select sum(to_pay) from due x where x.day = d.day), 0) as to_pay
       from days d
      order by d.day`,
    params,
  );
  const received = sum(rows, 'received');
  const paid = sum(rows, 'paid');
  return {
    rows,
    metrics: [
      { label: 'Entrou', value: received, format: 'money' },
      { label: 'Saiu', value: paid, format: 'money' },
      { label: 'Saldo do período', value: round(received - paid), format: 'money' },
      { label: 'A receber − a pagar no período', value: round(sum(rows, 'to_receive') - sum(rows, 'to_pay')), format: 'money' },
    ],
  };
}

/** Margem por produto no período: venda líquida menos o custo gravado na confirmação do pedido. */
async function margin(ctx: ReportContext): Promise<ExtraReport> {
  adminOnly(ctx.user);
  const params: unknown[] = [];
  const confirmed = period(ctx, params, 'o.confirmed_at');
  const store = storeWhere(ctx, params, 'o.store_id');
  const { rows } = await ctx.db.query(
    `with lines as (
       select i.product_id, i.product_code, i.product_name, i.unit, i.quantity, i.unit_cost,
              case when o.subtotal_amount > 0 then i.subtotal * o.total_amount / o.subtotal_amount else i.subtotal end as revenue
         from orders o join order_items i on i.order_id = o.id
        where o.status = 'order' and ${confirmed} and ${store}
     )
     select product_id as id, max(product_code) as code, max(product_name) as name, max(unit) as unit,
            sum(quantity) as quantity,
            round(sum(revenue), 2) as revenue,
            round(sum(quantity * unit_cost) filter (where unit_cost is not null), 2) as cost,
            round(sum(revenue) filter (where unit_cost is not null) - sum(quantity * unit_cost) filter (where unit_cost is not null), 2) as margin,
            round(100 * (sum(revenue) filter (where unit_cost is not null) - sum(quantity * unit_cost) filter (where unit_cost is not null))
                  / nullif(sum(revenue) filter (where unit_cost is not null), 0), 1) as margin_percent,
            round(coalesce(sum(revenue) filter (where unit_cost is null), 0), 2) as revenue_without_cost
       from lines
      group by product_id
      order by margin desc nulls last, revenue desc
      limit 1000`,
    params,
  );
  const withCost = rows.filter((r) => r.cost !== null);
  const revenue = sum(withCost, 'revenue') - sum(withCost, 'revenue_without_cost');
  const marginTotal = sum(rows, 'margin');
  return {
    rows,
    metrics: [
      { label: 'Venda líquida', value: sum(rows, 'revenue'), format: 'money' },
      { label: 'Margem bruta', value: marginTotal, format: 'money' },
      { label: 'Margem %', value: revenue > 0 ? round((100 * marginTotal) / revenue, 1) : 0, format: 'percent' },
      { label: 'Venda sem custo conhecido', value: sum(rows, 'revenue_without_cost'), format: 'money' },
    ],
  };
}

/** Entradas de nota do período por fornecedor. */
async function purchases(ctx: ReportContext): Promise<ExtraReport> {
  adminOnly(ctx.user);
  const params: unknown[] = [];
  const created = period(ctx, params, 'e.created_at');
  const store = storeWhere(ctx, params, 'e.store_id');
  const { rows } = await ctx.db.query(
    `select sp.id, coalesce(sp.name, e.supplier_name, 'Sem fornecedor') as name,
            count(*) as count, sum(e.total_amount) as total_amount, max(e.created_at) as last_date,
            (select count(*) from purchase_orders po where po.supplier_id = sp.id and po.status in ('draft', 'sent', 'partial')) as open_orders,
            (select coalesce(sum(p.amount - p.paid_amount), 0) from payables p where p.supplier_id = sp.id and p.status = 'open') as open_payables
       from stock_entries e left join suppliers sp on sp.id = e.supplier_id
      where ${created} and ${store}
      group by sp.id, coalesce(sp.name, e.supplier_name, 'Sem fornecedor')
      order by total_amount desc, name
      limit 500`,
    params,
  );
  return {
    rows,
    metrics: [
      { label: 'Notas lançadas', value: sum(rows, 'count'), format: 'number' },
      { label: 'Total comprado', value: sum(rows, 'total_amount'), format: 'money' },
      { label: 'Fornecedores', value: rows.length, format: 'number' },
      { label: 'A pagar a eles', value: sum(rows, 'open_payables'), format: 'money' },
    ],
  };
}

/** Divergências das contagens conferidas no período: o furo (ou a sobra) de estoque em R$. */
async function countDivergences(ctx: ReportContext): Promise<ExtraReport> {
  adminOnly(ctx.user);
  const params: unknown[] = [];
  const reviewed = period(ctx, params, 'c.reviewed_at');
  const store = storeWhere(ctx, params, 'c.store_id');
  const from = `stock_count_items i join stock_counts c on c.id = i.count_id join stores s on s.id = c.store_id
     where c.status = 'reviewed' and i.counted_quantity is not null and ${reviewed} and ${store}`;
  const { rows } = await ctx.db.query(
    `select i.id, c.id as count_id, s.name as store_name, i.product_code as code, i.product_name as name, i.unit,
            i.expected_quantity as expected, i.counted_quantity as counted,
            round(i.counted_quantity - i.expected_quantity, 3) as difference, i.unit_cost,
            round((i.counted_quantity - i.expected_quantity) * coalesce(i.unit_cost, 0), 2) as value, i.outcome, c.reviewed_at
       from ${from} and abs(i.counted_quantity - i.expected_quantity) >= 0.0005
      order by abs((i.counted_quantity - i.expected_quantity) * coalesce(i.unit_cost, 0)) desc, i.product_name
      limit 1000`,
    params,
  );
  const totals = await ctx.db.query<{ counted: number; exact: number; loss: number; surplus: number }>(
    `select count(*) as counted,
            count(*) filter (where abs(i.counted_quantity - i.expected_quantity) < 0.0005) as exact,
            coalesce(sum((i.counted_quantity - i.expected_quantity) * coalesce(i.unit_cost, 0))
                     filter (where i.outcome = 'adjusted' and i.counted_quantity < i.expected_quantity), 0) as loss,
            coalesce(sum((i.counted_quantity - i.expected_quantity) * coalesce(i.unit_cost, 0))
                     filter (where i.outcome = 'adjusted' and i.counted_quantity > i.expected_quantity), 0) as surplus
       from ${from}`,
    params,
  );
  const t = totals.rows[0]!;
  return {
    rows,
    metrics: [
      { label: 'Produtos contados', value: t.counted, format: 'number' },
      { label: 'Acurácia (sem diferença)', value: t.counted ? round((100 * t.exact) / t.counted, 1) : 0, format: 'percent' },
      { label: 'Falta ajustada', value: round(t.loss), format: 'money' },
      { label: 'Sobra ajustada', value: round(t.surplus), format: 'money' },
    ],
  };
}

export const EXTRA_REPORTS: Record<string, (ctx: ReportContext) => Promise<ExtraReport>> = {
  comissao: commission,
  conversao: conversion,
  devolucoes: returnsReport,
  'curva-abc': abc,
  'estoque-parado': stale,
  'estoque-valorizado': valuation,
  inadimplencia: overdue,
  'fluxo-de-caixa': cashFlow,
  margem: margin,
  compras: purchases,
  divergencias: countDivergences,
};
