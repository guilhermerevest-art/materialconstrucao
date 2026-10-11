import type pg from 'pg';

export type Frequency = 'weekly' | 'monthly' | 'on_demand';

export type TemplateItemInput = {
  label: string;
  hint?: string | null;
  kind: 'check' | 'number' | 'text' | 'photo';
  required: boolean;
  action?: 'cash_open' | 'cash_closed' | null;
};

export type TemplateInput = {
  name: string;
  kind: 'checklist' | 'stock_count';
  description: string | null;
  frequency: Frequency;
  weekdays: number[];
  month_day: number | null;
  due_time: string | null;
  store_id: number | null;
  active: boolean;
  items: TemplateItemInput[];
};

const MON_SAT = [1, 2, 3, 4, 5, 6];

/** Modelos que a loja recebe ao ligar as rotinas. Tudo editável depois. */
export const DEFAULT_TEMPLATES: TemplateInput[] = [
  {
    name: 'Abertura da loja',
    kind: 'checklist',
    description: 'Antes de abrir as portas para o cliente.',
    frequency: 'weekly',
    weekdays: MON_SAT,
    month_day: null,
    due_time: '07:30',
    store_id: null,
    active: true,
    items: [
      { label: 'Alarme desligado e portas sem sinal de arrombamento', kind: 'check', required: true },
      { label: 'Caixa aberto com o troco conferido', kind: 'check', required: true, action: 'cash_open' },
      { label: 'Pátio e corredores livres para carga e descarga', kind: 'check', required: true },
      { label: 'Entregas do dia separadas ou em separação', kind: 'check', required: false, hint: 'Confira a agenda em Entregas.' },
      { label: 'Foto da frente da loja aberta', kind: 'photo', required: false },
    ],
  },
  {
    name: 'Fechamento da loja',
    kind: 'checklist',
    description: 'Depois do último cliente.',
    frequency: 'weekly',
    weekdays: MON_SAT,
    month_day: null,
    due_time: '18:30',
    store_id: null,
    active: true,
    items: [
      { label: 'Caixas fechados com o dinheiro contado', kind: 'check', required: true, action: 'cash_closed' },
      { label: 'Dinheiro excedente guardado no cofre', kind: 'check', required: true },
      { label: 'Mercadoria do pátio recolhida ou coberta', kind: 'check', required: true },
      { label: 'Máquinas desligadas (serra, misturador de tinta)', kind: 'check', required: true },
      { label: 'Portas trancadas e alarme ligado', kind: 'check', required: true },
      { label: 'Observações do dia', kind: 'text', required: false },
    ],
  },
  {
    name: 'Recebimento de mercadoria',
    kind: 'checklist',
    description: 'A cada caminhão de fornecedor.',
    frequency: 'on_demand',
    weekdays: [],
    month_day: null,
    due_time: null,
    store_id: null,
    active: true,
    items: [
      { label: 'Nota fiscal confere com o pedido de compra', kind: 'check', required: true },
      { label: 'Quantidade conferida item a item', kind: 'check', required: true },
      { label: 'Avarias fotografadas e anotadas na nota', kind: 'photo', required: false },
      { label: 'Entrada da nota lançada no estoque', kind: 'check', required: true, hint: 'Estoque → Entrada de nota.' },
      { label: 'Observações', kind: 'text', required: false },
    ],
  },
  {
    name: 'Contagem de estoque',
    kind: 'stock_count',
    description:
      'Contagem cega: o sistema escolhe os produtos pela curva ABC (A toda semana, B todo mês, C a cada três meses) e quem conta não vê o saldo.',
    frequency: 'weekly',
    weekdays: [1],
    month_day: null,
    due_time: null,
    store_id: null,
    active: true,
    items: [],
  },
];

/** Grava o modelo e troca os itens dele (os já feitos guardam a própria cópia). */
export async function saveTemplate(db: pg.PoolClient, tenantId: number, input: TemplateInput, id?: number) {
  let templateId = id;
  const values = [
    input.name,
    input.kind,
    input.description,
    input.frequency,
    input.frequency === 'weekly' ? input.weekdays : [],
    input.frequency === 'monthly' ? input.month_day : null,
    input.frequency === 'on_demand' ? null : input.due_time,
    input.store_id,
    input.active,
  ];
  if (templateId) {
    await db.query(
      `update routine_templates
          set name = $2, kind = $3, description = $4, frequency = $5, weekdays = $6, month_day = $7, due_time = $8,
              store_id = $9, active = $10, updated_at = now()
        where id = $1`,
      [templateId, ...values],
    );
    await db.query('delete from routine_template_items where template_id = $1', [templateId]);
  } else {
    const { rows } = await db.query<{ id: number }>(
      `insert into routine_templates (tenant_id, name, kind, description, frequency, weekdays, month_day, due_time, store_id, active, position)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
               (select coalesce(max(position), 0) + 1 from routine_templates where tenant_id = $1))
       returning id`,
      [tenantId, ...values],
    );
    templateId = rows[0]!.id;
  }
  if (input.kind === 'checklist' && input.items.length) {
    await db.query(
      `insert into routine_template_items (tenant_id, template_id, position, label, hint, kind, required, action)
       select $1, $2, i.n, i.label, i.hint, i.kind, i.required, i.action
         from unnest($3::text[], $4::text[], $5::text[], $6::boolean[], $7::text[]) with ordinality
              as i(label, hint, kind, required, action, n)`,
      [
        tenantId,
        templateId,
        input.items.map((i) => i.label),
        input.items.map((i) => i.hint ?? null),
        input.items.map((i) => i.kind),
        input.items.map((i) => i.required),
        input.items.map((i) => i.action ?? null),
      ],
    );
  }
  return templateId;
}

/** Na primeira vez que a loja liga as rotinas, os modelos prontos. */
export async function seedTemplates(db: pg.PoolClient, tenantId: number) {
  const { rowCount } = await db.query('select 1 from routine_templates limit 1');
  if (rowCount) return;
  for (const template of DEFAULT_TEMPLATES) await saveTemplate(db, tenantId, template);
}

/** O modelo vence neste dia? `day` é "2026-10-10" no fuso da loja. */
export function isDue(template: { frequency: Frequency; weekdays: number[]; month_day: number | null }, day: string) {
  const [year, month, date] = day.split('-').map(Number) as [number, number, number];
  if (template.frequency === 'weekly') return template.weekdays.includes(new Date(Date.UTC(year, month - 1, date)).getUTCDay());
  if (template.frequency === 'monthly') return template.month_day === date;
  return false;
}

/** "07:42" agora, no fuso da loja. */
export function nowTime(timeZone: string, date = new Date()) {
  return new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', minute: '2-digit', hour12: false }).format(date);
}

/**
 * Caixa da loja no dia: algum aberto agora, algum aberto hoje e se todos os do dia já
 * foram fechados. É o que os itens "caixa aberto" e "caixas fechados" conferem.
 */
export async function cashState(db: pg.PoolClient, storeId: number, day: string, timeZone: string) {
  const { rows } = await db.query<{ open_now: number; opened_today: number; closed_today: number }>(
    `select count(*) filter (where closed_at is null) as open_now,
            count(*) filter (where (opened_at at time zone $3)::date = $2::date) as opened_today,
            count(*) filter (where closed_at is not null and (closed_at at time zone $3)::date = $2::date) as closed_today
       from cash_sessions where store_id = $1`,
    [storeId, day, timeZone],
  );
  const r = rows[0]!;
  return { open_now: r.open_now > 0, opened_today: r.opened_today > 0 || r.open_now > 0, closed_today: r.closed_today > 0 };
}

/** O item ligado ao caixa está cumprido? Sem o financeiro ligado, vale o "ok" de quem fez. */
export function actionSatisfied(action: string | null, cash: Awaited<ReturnType<typeof cashState>> | null) {
  if (!action || !cash) return null;
  if (action === 'cash_open') return cash.opened_today;
  if (action === 'cash_closed') return !cash.open_now;
  return null;
}

/**
 * O que deveria estar na prateleira agora: o saldo mais o que foi vendido e ainda não
 * saiu (pedido com controle de entrega), que continua fisicamente na loja.
 */
export async function expectedShelf(db: pg.PoolClient, storeId: number, productIds: number[]) {
  const { rows } = await db.query<{ product_id: number; expected: number }>(
    `select p.id as product_id,
            coalesce((select b.quantity from stock_balances b where b.store_id = $1 and b.product_id = p.id), 0)
            + coalesce((
                select sum(i.quantity - coalesce((
                         select sum(di.quantity) from delivery_items di join deliveries d on d.id = di.delivery_id
                          where di.order_item_id = i.id and d.status = 'done'), 0))
                  from orders o join order_items i on i.order_id = o.id
                 where o.store_id = $1 and o.status = 'order' and o.delivery_tracking and i.product_id = p.id
              ), 0) as expected
       from products p
      where p.id = any($2::bigint[])`,
    [storeId, productIds],
  );
  return new Map(rows.map((r) => [r.product_id, Math.round(r.expected * 1000) / 1000]));
}

/** Dias entre contagens por classe da curva ABC. */
export const COUNT_INTERVAL_DAYS = { A: 7, B: 30, C: 90 } as const;

/**
 * Produtos da contagem cíclica: classe pela venda dos últimos 90 dias na loja (A até 80%,
 * B até 95%, C o resto), e entram os que estão há mais tempo sem contar que o intervalo
 * da classe, primeiro os A e os nunca contados. Só produtos com saldo ou venda recente.
 */
export async function cycleSelection(db: pg.PoolClient, storeId: number, limit: number) {
  const { rows } = await db.query<{ product_id: number; abc_class: 'A' | 'B' | 'C' }>(
    `with sold as (
       select i.product_id,
              sum(case when o.subtotal_amount > 0 then i.subtotal * o.total_amount / o.subtotal_amount else i.subtotal end) as revenue
         from orders o join order_items i on i.order_id = o.id
        where o.store_id = $1 and o.status = 'order' and o.confirmed_at > now() - interval '90 days'
        group by i.product_id
     ), candidates as (
       select p.id as product_id, coalesce(s.revenue, 0) as revenue
         from products p
         left join stock_balances b on b.product_id = p.id and b.store_id = $1
         left join sold s on s.product_id = p.id
        where p.active and p.track_stock and (coalesce(b.quantity, 0) <> 0 or s.revenue > 0)
     ), ranked as (
       select c.*, sum(c.revenue) over () as total,
              sum(c.revenue) over (order by c.revenue desc, c.product_id rows unbounded preceding) as cum
         from candidates c
     ), classified as (
       select r.product_id,
              case when r.revenue > 0 and r.cum - r.revenue < 0.8 * r.total then 'A'
                   when r.revenue > 0 and r.cum - r.revenue < 0.95 * r.total then 'B'
                   else 'C' end as abc_class,
              (select max(ci.counted_at) from stock_count_items ci join stock_counts sc on sc.id = ci.count_id
                where ci.product_id = r.product_id and sc.store_id = $1 and sc.status in ('submitted', 'reviewed')
                  and ci.counted_quantity is not null) as last_counted,
              -- Um produto não entra em duas contagens abertas ao mesmo tempo.
              exists (select 1 from stock_count_items ci join stock_counts sc on sc.id = ci.count_id
                       where ci.product_id = r.product_id and sc.store_id = $1 and sc.status = 'counting') as in_open_count
         from ranked r
     )
     select product_id, abc_class
       from classified
      where not in_open_count
        and (last_counted is null
             or last_counted < now() - make_interval(days => case abc_class when 'A' then $3::int when 'B' then $4::int else $5::int end))
      order by abc_class, last_counted nulls first, product_id
      limit $2`,
    [storeId, limit, COUNT_INTERVAL_DAYS.A, COUNT_INTERVAL_DAYS.B, COUNT_INTERVAL_DAYS.C],
  );
  return rows;
}

/** Abre a contagem com os produtos (na ordem) e o custo de hoje de cada um. */
export async function createStockCount(
  db: pg.PoolClient,
  user: { tenant_id: number; id: number },
  storeId: number,
  mode: 'cycle' | 'manual',
  products: { product_id: number; abc_class: 'A' | 'B' | 'C' | null }[],
) {
  const { rows } = await db.query<{ id: number }>(
    'insert into stock_counts (tenant_id, store_id, user_id, mode) values ($1, $2, $3, $4) returning id',
    [user.tenant_id, storeId, user.id, mode],
  );
  const countId = rows[0]!.id;
  await db.query(
    `insert into stock_count_items (tenant_id, count_id, product_id, product_name, product_code, unit, abc_class, unit_cost, position)
     select $1, $2, p.id, p.name, p.code, p.unit, c.abc_class, p.cost_price, c.n
       from unnest($3::bigint[], $4::text[]) with ordinality as c(product_id, abc_class, n)
       join products p on p.id = c.product_id`,
    [user.tenant_id, countId, products.map((p) => p.product_id), products.map((p) => p.abc_class)],
  );
  return countId;
}
