-- Rotinas e checklists: abertura e fechamento da loja, recebimento de mercadoria e a
-- contagem cega do estoque. Desligado por padrão (settings.routines_enabled): ligar cria
-- os modelos prontos, que a loja ajusta.

alter table settings add column routines_enabled boolean not null default false;
-- Produtos por contagem cíclica (a contagem do dia).
alter table settings add column count_items integer not null default 20 check (count_items between 5 and 200);

create table routine_templates (
  id          bigint generated always as identity primary key,
  tenant_id   bigint not null references tenants (id),
  name        text not null,
  -- stock_count abre uma contagem cega em vez de itens de checklist.
  kind        text not null default 'checklist' check (kind in ('checklist', 'stock_count')),
  description text,
  -- weekly: nos dias da semana marcados (0 = domingo); monthly: no dia do mês; on_demand: quando precisar.
  frequency   text not null default 'weekly' check (frequency in ('weekly', 'monthly', 'on_demand')),
  weekdays    smallint[] not null default '{1,2,3,4,5,6}',
  month_day   smallint check (month_day between 1 and 28),
  -- Feita depois deste horário (da loja), conta como atrasada.
  due_time    time,
  -- Nulo: todas as lojas.
  store_id    bigint references stores (id) on delete cascade,
  active      boolean not null default true,
  position    integer not null default 0,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  constraint routine_templates_schedule check (frequency <> 'monthly' or month_day is not null)
);
create index routine_templates_tenant_idx on routine_templates (tenant_id, position);

create table routine_template_items (
  id          bigint generated always as identity primary key,
  tenant_id   bigint not null references tenants (id),
  template_id bigint not null references routine_templates (id) on delete cascade,
  position    integer not null default 0,
  label       text not null,
  hint        text,
  -- check: feito; number: um número (ex.: dinheiro contado); text: observação; photo: foto.
  kind        text not null default 'check' check (kind in ('check', 'number', 'text', 'photo')),
  required    boolean not null default true,
  -- Item que o sistema confere: caixa aberto hoje na loja, ou todos os caixas fechados.
  action      text check (action in ('cash_open', 'cash_closed'))
);
create index routine_template_items_template_idx on routine_template_items (template_id, position);

-- Contagem cega: quem conta não vê o saldo do sistema. A diferença vira ajuste só
-- quando o administrador aprova.
create table stock_counts (
  id           bigint generated always as identity primary key,
  tenant_id    bigint not null references tenants (id),
  store_id     bigint not null references stores (id),
  user_id      bigint not null references users (id),
  -- cycle: o sistema escolheu pela curva ABC; manual: produtos escolhidos.
  mode         text not null check (mode in ('cycle', 'manual')),
  status       text not null default 'counting' check (status in ('counting', 'submitted', 'reviewed', 'cancelled')),
  notes        text,
  created_at   timestamptz not null default now(),
  submitted_at timestamptz,
  submitted_by bigint references users (id),
  reviewed_at  timestamptz,
  reviewed_by  bigint references users (id),
  review_note  text
);
create index stock_counts_store_idx on stock_counts (store_id, created_at desc);

create table stock_count_items (
  id                bigint generated always as identity primary key,
  tenant_id         bigint not null references tenants (id),
  count_id          bigint not null references stock_counts (id) on delete cascade,
  product_id        bigint not null references products (id),
  product_name      text not null,
  product_code      text,
  unit              text not null,
  -- Classe da curva ABC quando foi escolhido (contagem cíclica).
  abc_class         text check (abc_class in ('A', 'B', 'C')),
  position          integer not null default 0,
  counted_quantity  numeric(14, 3) check (counted_quantity >= 0),
  -- O que deveria estar na prateleira na hora da contagem: saldo + vendido ainda não entregue.
  expected_quantity numeric(14, 3),
  unit_cost         numeric(14, 4),
  counted_by        bigint references users (id),
  counted_at        timestamptz,
  -- Na revisão: 'adjusted' virou ajuste de estoque; 'ignored' ficou como estava.
  outcome           text check (outcome in ('adjusted', 'ignored')),
  unique (count_id, product_id)
);
create index stock_count_items_product_idx on stock_count_items (product_id, counted_at desc);


create table routine_runs (
  id          bigint generated always as identity primary key,
  tenant_id   bigint not null references tenants (id),
  template_id bigint not null references routine_templates (id),
  store_id    bigint not null references stores (id),
  -- Dia (da loja) a que a rotina se refere.
  run_date    date not null,
  -- Rotina da agenda: uma por dia e loja. Sob demanda pode repetir.
  scheduled   boolean not null default true,
  name        text not null,
  status      text not null default 'in_progress' check (status in ('in_progress', 'done')),
  user_id     bigint not null references users (id),
  started_at  timestamptz not null default now(),
  finished_at timestamptz,
  finished_by bigint references users (id),
  -- Feita depois do horário do modelo.
  late        boolean not null default false,
  count_id    bigint references stock_counts (id),
  notes       text
);
create unique index routine_runs_scheduled_key on routine_runs (template_id, store_id, run_date) where scheduled;
create index routine_runs_store_date_idx on routine_runs (store_id, run_date desc);

create table routine_run_items (
  id             bigint generated always as identity primary key,
  tenant_id      bigint not null references tenants (id),
  run_id         bigint not null references routine_runs (id) on delete cascade,
  position       integer not null default 0,
  -- Cópia do item do modelo: mudar o modelo não muda o que já foi feito.
  label          text not null,
  hint           text,
  kind           text not null,
  required       boolean not null,
  action         text,
  checked        boolean not null default false,
  value_number   numeric(14, 2),
  value_text     text,
  photo_data     text,
  done_by        bigint references users (id),
  done_at        timestamptz
);
create index routine_run_items_run_idx on routine_run_items (run_id, position);

alter table routine_templates enable row level security;
alter table routine_templates force  row level security;
create policy routine_templates_tenant on routine_templates
  for all using (tenant_id = (select app_tenant_id())) with check (tenant_id = (select app_tenant_id()));

alter table routine_template_items enable row level security;
alter table routine_template_items force  row level security;
create policy routine_template_items_tenant on routine_template_items
  for all using (tenant_id = (select app_tenant_id())) with check (tenant_id = (select app_tenant_id()));

alter table stock_counts enable row level security;
alter table stock_counts force  row level security;
create policy stock_counts_tenant on stock_counts
  for all using (tenant_id = (select app_tenant_id())) with check (tenant_id = (select app_tenant_id()));

alter table stock_count_items enable row level security;
alter table stock_count_items force  row level security;
create policy stock_count_items_tenant on stock_count_items
  for all using (tenant_id = (select app_tenant_id())) with check (tenant_id = (select app_tenant_id()));

alter table routine_runs enable row level security;
alter table routine_runs force  row level security;
create policy routine_runs_tenant on routine_runs
  for all using (tenant_id = (select app_tenant_id())) with check (tenant_id = (select app_tenant_id()));

alter table routine_run_items enable row level security;
alter table routine_run_items force  row level security;
create policy routine_run_items_tenant on routine_run_items
  for all using (tenant_id = (select app_tenant_id())) with check (tenant_id = (select app_tenant_id()));
