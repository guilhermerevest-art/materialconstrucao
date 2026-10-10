-- Obras do cliente: o mesmo cliente compra para vários endereços (a casa, a obra
-- da Rua X, a reforma da loja). No PDV, escolher a obra preenche o endereço de
-- entrega; o pedido guarda o texto do endereço, como antes, e a obra escolhida.
create table client_sites (
  id            bigint generated always as identity primary key,
  tenant_id     bigint not null references tenants (id),
  client_id     bigint not null references clients (id) on delete cascade,
  name          text not null,
  address       text not null,
  contact_name  text,
  contact_phone text,
  notes         text,
  active        boolean not null default true,
  created_at    timestamptz not null default now()
);
create index client_sites_client_idx on client_sites (client_id);

alter table client_sites enable row level security;
alter table client_sites force  row level security;
create policy client_sites_tenant on client_sites
  for all
  using (tenant_id = (select app_tenant_id()))
  with check (tenant_id = (select app_tenant_id()));

alter table orders add column client_site_id bigint references client_sites (id) on delete set null;
create index orders_client_site_idx on orders (client_site_id) where client_site_id is not null;

-- Limite do crediário (venda a prazo pela loja). Nulo: o cliente não compra no crediário.
alter table clients add column credit_limit numeric(14, 2) check (credit_limit >= 0);
