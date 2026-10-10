-- Entregas e retiradas: o pedido pode sair aos poucos (o cliente compra 200 sacos
-- e leva 50 por semana). Cada entrega/retirada leva quantidades dos itens do pedido;
-- o que falta é o saldo a entregar. O estoque já baixou na venda: aqui é só logística.

create table vehicles (
  id          bigint generated always as identity primary key,
  tenant_id   bigint not null references tenants (id),
  name        text not null,
  plate       text,
  active      boolean not null default true,
  created_at  timestamptz not null default now()
);
create unique index vehicles_tenant_plate_key on vehicles (tenant_id, upper(plate)) where plate is not null;

-- Romaneio: as entregas de um veículo numa saída.
create table delivery_routes (
  id          bigint generated always as identity primary key,
  tenant_id   bigint not null references tenants (id),
  store_id    bigint not null references stores (id),
  route_date  date not null,
  vehicle_id  bigint references vehicles (id),
  driver_name text,
  status      text not null default 'open' check (status in ('open', 'in_route', 'done')),
  notes       text,
  created_by  bigint not null references users (id),
  created_at  timestamptz not null default now(),
  departed_at timestamptz,
  finished_at timestamptz
);
create index delivery_routes_store_date_idx on delivery_routes (store_id, route_date);

create table deliveries (
  id                bigint generated always as identity primary key,
  tenant_id         bigint not null references tenants (id),
  store_id          bigint not null references stores (id),
  order_id          bigint not null references orders (id) on delete cascade,
  -- Retirada na loja ou entrega no endereço.
  kind              text not null check (kind in ('pickup', 'delivery')),
  status            text not null default 'scheduled' check (status in ('scheduled', 'in_route', 'done', 'cancelled')),
  scheduled_date    date,
  period            text check (period in ('morning', 'afternoon')),
  address           text,
  route_id          bigint references delivery_routes (id) on delete set null,
  route_position    integer,
  -- Comprovante: quem recebeu, assinatura (PNG) e foto (JPEG), em base64 como a logo da loja.
  receiver_name     text,
  receiver_document text,
  signature_data    text,
  photo_data        text,
  notes             text,
  -- Não entregue ou desmarcada: o motivo. A quantidade volta para o saldo a entregar.
  cancel_reason     text,
  created_by        bigint not null references users (id),
  completed_by      bigint references users (id),
  cancelled_by      bigint references users (id),
  created_at        timestamptz not null default now(),
  completed_at      timestamptz,
  cancelled_at      timestamptz,
  constraint deliveries_done_fields check ((status = 'done') = (completed_at is not null)),
  constraint deliveries_cancel_fields check ((status = 'cancelled') = (cancelled_at is not null)),
  constraint deliveries_delivery_address check (kind = 'pickup' or address is not null)
);
create index deliveries_order_idx on deliveries (order_id);
create index deliveries_store_date_idx on deliveries (store_id, scheduled_date) where status in ('scheduled', 'in_route');
create index deliveries_route_idx on deliveries (route_id) where route_id is not null;

create table delivery_items (
  delivery_id   bigint not null references deliveries (id) on delete cascade,
  order_item_id bigint not null references order_items (id) on delete cascade,
  tenant_id     bigint not null references tenants (id),
  quantity      numeric(14, 3) not null check (quantity > 0),
  primary key (delivery_id, order_item_id)
);
create index delivery_items_order_item_idx on delivery_items (order_item_id);

-- Saldo a entregar só vale para pedidos confirmados depois desta migração: os antigos
-- não têm registro de entrega e apareceriam todos como pendentes.
alter table orders add column delivery_tracking boolean not null default false;

-- Entregas seguem a visibilidade do pedido (a subconsulta em orders passa pelo RLS dele):
-- o vendedor vê e registra as da própria loja; o admin, as da rede.
alter table deliveries enable row level security;
alter table deliveries force  row level security;
create policy deliveries_via_order on deliveries
  for all
  using (exists (select 1 from orders o where o.id = deliveries.order_id and o.tenant_id = (select app_tenant_id())))
  with check (exists (select 1 from orders o where o.id = deliveries.order_id and o.tenant_id = (select app_tenant_id())));

alter table delivery_items enable row level security;
alter table delivery_items force  row level security;
create policy delivery_items_via_delivery on delivery_items
  for all
  using (exists (select 1 from deliveries d where d.id = delivery_items.delivery_id))
  with check (exists (select 1 from deliveries d where d.id = delivery_items.delivery_id));

-- Romaneio é da loja: o vendedor (motorista, expedição) vê os da loja dele.
alter table delivery_routes enable row level security;
alter table delivery_routes force  row level security;
create policy delivery_routes_admin on delivery_routes
  for all
  using ((select app_role()) = 'admin' and tenant_id = (select app_tenant_id()))
  with check ((select app_role()) = 'admin' and tenant_id = (select app_tenant_id()));
create policy delivery_routes_seller on delivery_routes
  for all
  using ((select app_role()) = 'seller' and tenant_id = (select app_tenant_id()) and store_id = (select app_store_id()))
  with check ((select app_role()) = 'seller' and tenant_id = (select app_tenant_id()) and store_id = (select app_store_id()));

alter table vehicles enable row level security;
alter table vehicles force  row level security;
create policy vehicles_tenant on vehicles
  for all using (tenant_id = (select app_tenant_id())) with check (tenant_id = (select app_tenant_id()));
