-- Schema inicial do sistema de pedidos e orçamentos.

create table stores (
  id         bigint generated always as identity primary key,
  name       text not null,
  address    text,
  phone      text,
  created_at timestamptz not null default now()
);

create table users (
  id            bigint generated always as identity primary key,
  name          text not null,
  email         text not null,
  password_hash text not null,
  role          text not null check (role in ('admin', 'seller')),
  store_id      bigint references stores (id),
  active        boolean not null default true,
  -- Incrementado ao trocar a senha ou desativar o usuário: invalida as sessões abertas.
  token_version integer not null default 0,
  created_at    timestamptz not null default now(),
  constraint users_seller_needs_store check (role = 'admin' or store_id is not null)
);
create unique index users_email_key on users (lower(email));

-- WhatsApp guardado só com dígitos e DDI (ex.: 5511987654321).
create table clients (
  id         bigint generated always as identity primary key,
  name       text not null,
  whatsapp   text not null,
  created_at timestamptz not null default now()
);
create index clients_whatsapp_idx on clients (whatsapp);

create table products (
  id         bigint generated always as identity primary key,
  code       text,
  name       text not null,
  unit       text not null default 'UN',
  price      numeric(12, 2) not null check (price >= 0),
  active     boolean not null default true,
  created_at timestamptz not null default now()
);
create unique index products_code_key on products (lower(code)) where code is not null;

create table orders (
  id           bigint generated always as identity primary key,
  user_id      bigint not null references users (id),
  store_id     bigint not null references stores (id),
  client_id    bigint not null references clients (id),
  status       text not null check (status in ('quote', 'order')),
  total_amount numeric(14, 2) not null default 0,
  notes        text,
  -- Quando virou pedido (criado como pedido ou convertido a partir de orçamento).
  confirmed_at timestamptz,
  -- Último envio do PDF por WhatsApp.
  sent_at      timestamptz,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
create index orders_store_created_idx on orders (store_id, created_at desc);
create index orders_created_idx on orders (created_at desc);
create index orders_client_idx on orders (client_id);
create index orders_user_idx on orders (user_id);

-- Nome, código e unidade são copiados do produto para o pedido não mudar
-- se o cadastro do produto for alterado depois.
create table order_items (
  id           bigint generated always as identity primary key,
  order_id     bigint not null references orders (id) on delete cascade,
  position     integer not null,
  product_id   bigint not null references products (id),
  product_code text,
  product_name text not null,
  unit         text not null,
  quantity     numeric(12, 3) not null check (quantity > 0),
  unit_price   numeric(12, 2) not null check (unit_price >= 0),
  subtotal     numeric(14, 2) generated always as (round(quantity * unit_price, 2)) stored
);
create index order_items_order_idx on order_items (order_id, position);
create index order_items_product_idx on order_items (product_id);

-- Linha única com as credenciais da EvolutionAPI. Só o admin acessa (controle na API).
create table settings (
  id                  integer primary key default 1 check (id = 1),
  evolution_api_url   text,
  evolution_instance  text,
  evolution_api_token text,
  updated_at          timestamptz not null default now()
);
insert into settings (id) values (1);

-- Busca sem acento e sem diferenciar maiúsculas ("areia media" encontra "Areia Média").
create function search_norm(value text) returns text
  language sql immutable parallel safe
  as $$ select translate(lower(value),
    'áàâãäéèêëíìîïóòôõöúùûüçñ',
    'aaaaaeeeeiiiiooooouuuucn') $$;

-- Row Level Security de pedidos.
-- A API abre uma transação por requisição e define app.user_id, app.role e
-- app.store_id com set_config(..., true). Sem esse contexto nenhuma linha é
-- visível. FORCE vale também para o dono das tabelas. Superusuários e papéis
-- com BYPASSRLS ignoram as políticas, então a aplicação deve conectar com um
-- usuário comum.
create function app_user_id() returns bigint
  language sql stable
  as $$ select nullif(current_setting('app.user_id', true), '')::bigint $$;

create function app_role() returns text
  language sql stable
  as $$ select nullif(current_setting('app.role', true), '') $$;

create function app_store_id() returns bigint
  language sql stable
  as $$ select nullif(current_setting('app.store_id', true), '')::bigint $$;

alter table orders enable row level security;
alter table orders force row level security;
alter table order_items enable row level security;
alter table order_items force row level security;

create policy orders_admin on orders
  for all
  using ((select app_role()) = 'admin')
  with check ((select app_role()) = 'admin');

-- Vendedor vê e altera os pedidos da própria loja; só cria pedidos em seu nome.
-- Não há política de DELETE para vendedor: excluir pedido é só do admin.
create policy orders_seller_select on orders
  for select
  using ((select app_role()) = 'seller' and store_id = (select app_store_id()));

create policy orders_seller_insert on orders
  for insert
  with check (
    (select app_role()) = 'seller'
    and store_id = (select app_store_id())
    and user_id = (select app_user_id())
  );

create policy orders_seller_update on orders
  for update
  using ((select app_role()) = 'seller' and store_id = (select app_store_id()))
  with check ((select app_role()) = 'seller' and store_id = (select app_store_id()));

-- Itens seguem a visibilidade do pedido (a subconsulta em orders já passa pelo RLS).
create policy order_items_via_order on order_items
  for all
  using (exists (select 1 from orders o where o.id = order_items.order_id))
  with check (exists (select 1 from orders o where o.id = order_items.order_id));
