-- Preço: tabelas de preço por cliente, faixas por quantidade, desconto máximo com
-- liberação, margem sobre o custo e histórico de preço. Tudo opcional: sem tabela,
-- faixa ou limite configurado, o pedido usa o preço do catálogo como sempre.

-- 1. Tabelas de preço (varejo, atacado, construtora...). O preço do produto na tabela é
-- o definido nela ou o do catálogo com o ajuste (%) da tabela.
create table price_lists (
  id             bigint generated always as identity primary key,
  tenant_id      bigint not null references tenants (id),
  name           text not null,
  -- -10 = 10% abaixo do catálogo; 5 = 5% acima.
  adjust_percent numeric(6, 2) not null default 0 check (adjust_percent between -90 and 500),
  active         boolean not null default true,
  created_at     timestamptz not null default now()
);
create unique index price_lists_tenant_name_key on price_lists (tenant_id, lower(name));

create table price_list_items (
  price_list_id bigint not null references price_lists (id) on delete cascade,
  product_id    bigint not null references products (id) on delete cascade,
  tenant_id     bigint not null references tenants (id),
  price         numeric(14, 2) not null check (price >= 0),
  primary key (price_list_id, product_id)
);

alter table clients add column price_list_id bigint references price_lists (id) on delete set null;

-- 2. Faixas por quantidade: a partir de min_quantity, o produto sai por price.
create table product_price_tiers (
  id           bigint generated always as identity primary key,
  tenant_id    bigint not null references tenants (id),
  product_id   bigint not null references products (id) on delete cascade,
  min_quantity numeric(14, 3) not null check (min_quantity > 0),
  price        numeric(14, 2) not null check (price >= 0),
  unique (product_id, min_quantity)
);

-- 3. Margem sobre o custo (markup) para sugerir o preço. Nula = a padrão da loja.
alter table products add column markup_percent numeric(7, 2) check (markup_percent >= 0);

-- 4. Histórico de preço: toda mudança do preço do catálogo, por qualquer caminho
-- (cadastro, reajuste em massa, entrada de nota). O motivo vem da transação.
create table product_price_history (
  id         bigint generated always as identity primary key,
  tenant_id  bigint not null references tenants (id),
  product_id bigint not null references products (id) on delete cascade,
  old_price  numeric(14, 2) not null,
  new_price  numeric(14, 2) not null,
  reason     text,
  user_id    bigint references users (id) on delete set null,
  created_at timestamptz not null default now()
);
create index product_price_history_product_idx on product_price_history (product_id, created_at desc);

create function log_product_price() returns trigger
  language plpgsql
  as $$
begin
  if new.price is distinct from old.price then
    insert into product_price_history (tenant_id, product_id, old_price, new_price, reason, user_id)
    values (new.tenant_id, new.id, old.price, new.price,
            nullif(current_setting('app.price_reason', true), ''),
            nullif(current_setting('app.user_id', true), '')::bigint);
  end if;
  return new;
end $$;

create trigger products_price_history after update of price on products
  for each row execute function log_product_price();

-- 5. Desconto: limite por vendedor (nulo = o padrão da loja; padrão nulo = sem limite) e
-- quem pode liberar acima do limite com a própria senha.
alter table users add column max_discount_percent numeric(5, 2) check (max_discount_percent between 0 and 100);
alter table users add column can_approve_discounts boolean not null default false;
alter table settings add column max_discount_percent numeric(5, 2) check (max_discount_percent between 0 and 100);
alter table settings add column default_markup_percent numeric(7, 2) check (default_markup_percent >= 0);

alter table orders add column discount_approved_by bigint references users (id);
alter table orders add column discount_approved_percent numeric(5, 2);
-- Tabela de preço usada no pedido, para o relatório e para o pedido mostrar.
alter table orders add column price_list_id bigint references price_lists (id) on delete set null;
alter table orders add column price_list_name text;

-- 6. Custo do item na confirmação da venda, para margem e lucro nos relatórios.
alter table order_items add column unit_cost numeric(14, 4);

alter table price_lists enable row level security;
alter table price_lists force  row level security;
create policy price_lists_tenant on price_lists
  for all using (tenant_id = (select app_tenant_id())) with check (tenant_id = (select app_tenant_id()));

alter table price_list_items enable row level security;
alter table price_list_items force  row level security;
create policy price_list_items_tenant on price_list_items
  for all using (tenant_id = (select app_tenant_id())) with check (tenant_id = (select app_tenant_id()));

alter table product_price_tiers enable row level security;
alter table product_price_tiers force  row level security;
create policy product_price_tiers_tenant on product_price_tiers
  for all using (tenant_id = (select app_tenant_id())) with check (tenant_id = (select app_tenant_id()));

alter table product_price_history enable row level security;
alter table product_price_history force  row level security;
create policy product_price_history_tenant on product_price_history
  for all using (tenant_id = (select app_tenant_id())) with check (tenant_id = (select app_tenant_id()));
