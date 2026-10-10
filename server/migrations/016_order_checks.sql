-- Conferência da separação: quem conferiu, quando, e o que foi contado de cada item.
-- ok = tudo bateu com o que tinha que sair; com divergência, fica registrado como estava.
create table order_checks (
  id          bigint generated always as identity primary key,
  tenant_id   bigint not null references tenants (id),
  order_id    bigint not null references orders (id) on delete cascade,
  delivery_id bigint references deliveries (id) on delete set null,
  user_id     bigint not null references users (id),
  ok          boolean not null,
  -- [{order_item_id, product_name, unit, expected, counted}]
  items       jsonb not null,
  note        text,
  created_at  timestamptz not null default now()
);
create index order_checks_order_idx on order_checks (order_id, created_at desc);

alter table order_checks enable row level security;
alter table order_checks force  row level security;
create policy order_checks_via_order on order_checks
  for all
  using (exists (select 1 from orders o where o.id = order_checks.order_id and o.tenant_id = (select app_tenant_id())))
  with check (exists (select 1 from orders o where o.id = order_checks.order_id and o.tenant_id = (select app_tenant_id())));
