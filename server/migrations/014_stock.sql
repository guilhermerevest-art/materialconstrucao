-- Estoque por loja (não há depósito central). A venda baixa o estoque quando o
-- pedido é confirmado, e o cancelamento devolve. Tudo passa por stock_movements,
-- que é o extrato; stock_balances é o saldo atual de cada produto em cada loja.

-- Produto que não ocupa prateleira (frete, serviço, mão de obra) não controla estoque.
alter table products add column track_stock boolean not null default true;
-- Último custo de compra, por unidade de venda. Atualizado a cada entrada.
alter table products add column cost_price numeric(14, 4) check (cost_price >= 0);

create table stock_balances (
  tenant_id    bigint not null references tenants (id),
  store_id     bigint not null references stores (id) on delete cascade,
  product_id   bigint not null references products (id) on delete cascade,
  -- Pode ficar negativo: a venda não trava por falta de estoque (o PDV avisa).
  quantity     numeric(14, 3) not null default 0,
  -- Estoque mínimo: abaixo dele o produto aparece em "comprar".
  min_quantity numeric(14, 3) check (min_quantity >= 0),
  updated_at   timestamptz not null default now(),
  primary key (store_id, product_id)
);
create index stock_balances_product_idx on stock_balances (product_id);

-- Entrada de mercadoria: nota de compra (importada do XML) ou lançamento manual.
create table stock_entries (
  id                bigint generated always as identity primary key,
  tenant_id         bigint not null references tenants (id),
  store_id          bigint not null references stores (id),
  user_id           bigint not null references users (id),
  supplier_name     text,
  -- CNPJ ou CPF do fornecedor, só dígitos.
  supplier_document text,
  invoice_number    text,
  invoice_series    text,
  -- Chave de acesso da NF-e (44 dígitos). A mesma nota não entra duas vezes.
  access_key        text check (access_key ~ '^\d{44}$'),
  issued_at         timestamptz,
  total_amount      numeric(14, 2) not null default 0,
  notes             text,
  created_at        timestamptz not null default now()
);
create unique index stock_entries_access_key on stock_entries (tenant_id, access_key) where access_key is not null;
create index stock_entries_store_idx on stock_entries (store_id, created_at desc);

create table stock_movements (
  id            bigint generated always as identity primary key,
  tenant_id     bigint not null references tenants (id),
  store_id      bigint not null references stores (id) on delete cascade,
  product_id    bigint not null references products (id) on delete cascade,
  kind          text not null check (kind in ('entry', 'sale', 'sale_cancel', 'adjustment', 'transfer_out', 'transfer_in')),
  -- Com sinal: entrada positiva, saída negativa.
  quantity      numeric(14, 3) not null check (quantity <> 0),
  balance_after numeric(14, 3) not null,
  unit_cost     numeric(14, 4),
  order_id      bigint references orders (id) on delete set null,
  entry_id      bigint references stock_entries (id) on delete set null,
  -- Transferência: a outra loja da operação.
  other_store_id bigint references stores (id) on delete set null,
  user_id       bigint not null references users (id),
  note          text,
  created_at    timestamptz not null default now()
);
create index stock_movements_product_idx on stock_movements (store_id, product_id, created_at desc);
create index stock_movements_order_idx on stock_movements (order_id) where order_id is not null;

-- Código do produto no fornecedor: na próxima nota dele, o item já vem reconhecido,
-- com a conversão de unidade (ex.: a nota vende a caixa com 10, a loja vende a unidade).
create table supplier_products (
  tenant_id         bigint not null references tenants (id),
  supplier_document text not null,
  supplier_code     text not null,
  product_id        bigint not null references products (id) on delete cascade,
  factor            numeric(14, 4) not null default 1 check (factor > 0),
  updated_at        timestamptz not null default now(),
  primary key (tenant_id, supplier_document, supplier_code)
);

-- O pedido já baixou o estoque? Só pedidos confirmados depois desta migração baixam;
-- os antigos ficam como estavam, sem movimento.
alter table orders add column stock_applied boolean not null default false;

-- Estoque é da lojamestre: todo mundo consulta o saldo das lojas (para dizer ao
-- cliente que tem na outra loja). Quem ajusta, transfere e lança nota é o admin (API).
alter table stock_balances enable row level security;
alter table stock_balances force  row level security;
create policy stock_balances_tenant on stock_balances
  for all using (tenant_id = (select app_tenant_id())) with check (tenant_id = (select app_tenant_id()));

alter table stock_entries enable row level security;
alter table stock_entries force  row level security;
create policy stock_entries_tenant on stock_entries
  for all using (tenant_id = (select app_tenant_id())) with check (tenant_id = (select app_tenant_id()));

alter table stock_movements enable row level security;
alter table stock_movements force  row level security;
create policy stock_movements_tenant on stock_movements
  for all using (tenant_id = (select app_tenant_id())) with check (tenant_id = (select app_tenant_id()));

alter table supplier_products enable row level security;
alter table supplier_products force  row level security;
create policy supplier_products_tenant on supplier_products
  for all using (tenant_id = (select app_tenant_id())) with check (tenant_id = (select app_tenant_id()));
