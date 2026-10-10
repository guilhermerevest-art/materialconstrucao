-- Devolução e troca. O cliente devolve parte do que levou; a mercadoria volta (ou não)
-- para o estoque e o valor volta em dinheiro, PIX, cartão, crédito para troca (vale),
-- abatimento no fiado ou nas parcelas do pedido.

create table order_returns (
  id              bigint generated always as identity primary key,
  tenant_id       bigint not null references tenants (id),
  store_id        bigint not null references stores (id),
  order_id        bigint not null references orders (id),
  client_id       bigint not null references clients (id),
  user_id         bigint not null references users (id),
  reason          text not null,
  refund_method   text not null check (refund_method in ('cash', 'pix', 'card', 'credit', 'fiado', 'receivables', 'none')),
  -- Valor da mercadoria devolvida, com o desconto do pedido rateado.
  amount          numeric(14, 2) not null check (amount >= 0),
  -- Dinheiro devolvido pelo caixa (com o financeiro ligado).
  cash_session_id bigint references cash_sessions (id),
  created_at      timestamptz not null default now()
);
create index order_returns_order_idx on order_returns (order_id);
create index order_returns_tenant_created_idx on order_returns (tenant_id, created_at desc);

create table order_return_items (
  id            bigint generated always as identity primary key,
  tenant_id     bigint not null references tenants (id),
  return_id     bigint not null references order_returns (id) on delete cascade,
  order_item_id bigint not null references order_items (id),
  product_id    bigint not null references products (id),
  product_name  text not null,
  unit          text not null,
  quantity      numeric(14, 3) not null check (quantity > 0),
  -- Preço unitário líquido (com o desconto do pedido rateado).
  unit_price    numeric(14, 4) not null check (unit_price >= 0),
  amount        numeric(14, 2) not null check (amount >= 0),
  -- Voltou para a prateleira (avariado não volta).
  restock       boolean not null default true
);
create index order_return_items_item_idx on order_return_items (order_item_id);

-- Crédito do cliente (vale-troca): entra com a devolução, sai quando ele usa numa compra.
create table client_credits (
  id           bigint generated always as identity primary key,
  tenant_id    bigint not null references tenants (id),
  client_id    bigint not null references clients (id),
  amount       numeric(14, 2) not null check (amount <> 0),
  return_id    bigint references order_returns (id),
  order_id     bigint references orders (id),
  description  text,
  user_id      bigint not null references users (id),
  created_at   timestamptz not null default now(),
  cancelled_at timestamptz
);
create index client_credits_client_idx on client_credits (client_id, created_at);
create index client_credits_order_idx on client_credits (order_id) where order_id is not null;

-- Parte do pedido paga com o crédito do cliente; o resto vai na forma de pagamento.
alter table orders add column credit_used numeric(14, 2) not null default 0 check (credit_used >= 0);

alter table stock_movements drop constraint stock_movements_kind_check;
alter table stock_movements add constraint stock_movements_kind_check
  check (kind in ('entry', 'sale', 'sale_cancel', 'adjustment', 'transfer_out', 'transfer_in', 'return'));
alter table stock_movements add column return_id bigint references order_returns (id);

-- Devolução em dinheiro sai da gaveta do caixa.
alter table cash_movements drop constraint cash_movements_kind_check;
alter table cash_movements add constraint cash_movements_kind_check check (kind in ('withdrawal', 'deposit', 'refund'));

alter table order_returns enable row level security;
alter table order_returns force  row level security;
create policy order_returns_tenant on order_returns
  for all using (tenant_id = (select app_tenant_id())) with check (tenant_id = (select app_tenant_id()));

alter table order_return_items enable row level security;
alter table order_return_items force  row level security;
create policy order_return_items_tenant on order_return_items
  for all using (tenant_id = (select app_tenant_id())) with check (tenant_id = (select app_tenant_id()));

alter table client_credits enable row level security;
alter table client_credits force  row level security;
create policy client_credits_tenant on client_credits
  for all using (tenant_id = (select app_tenant_id())) with check (tenant_id = (select app_tenant_id()));
