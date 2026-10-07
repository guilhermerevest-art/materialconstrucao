-- Multi-tenant: cada lojamestre é um tenant isolado por RLS.
-- Aplicável em banco que tenha dados da v1 (1 banco = 1 cliente) — o
-- backfill migra tudo para o tenant 'default' e o super admin pode renomear
-- o admin legado pela tela /super (ou via db:rename-admin).

-- 1. Tabela de tenants. Slug é o identificador do login.
create table tenants (
  id         bigint generated always as identity primary key,
  slug       text not null,
  name       text not null,
  active     boolean not null default true,
  created_at timestamptz not null default now()
);
-- Slug normalizado: a aplicação grava lower-kebab, mas o índice garante
-- case-insensitive de qualquer forma.
create unique index tenants_slug_key on tenants (lower(slug));

-- 2. Tenant inicial 'default'. Recebe todos os dados da v1 via backfill abaixo.
insert into tenants (slug, name) values ('default', 'Lojamestre padrão');

-- 3. Super admin: papel fora da hierarquia de tenant. Cria lojamestres.
-- Senha fica na tabela `super_admins` (separada de `users` por design — super
-- admin não é "vendedor/admin de uma lojamestre", é papel à parte).
create table super_admins (
  id            bigint generated always as identity primary key,
  email         text not null,
  password_hash text not null,
  active        boolean not null default true,
  -- Trocar a senha encerra outras sessões.
  token_version integer not null default 0,
  created_at    timestamptz not null default now()
);
create unique index super_admins_email_key on super_admins (lower(email));

-- 4. Adicionar tenant_id em tudo. Nullable para backfill controlado.
alter table stores     add column tenant_id bigint references tenants (id);
alter table users      add column tenant_id bigint references tenants (id);
alter table clients    add column tenant_id bigint references tenants (id);
alter table products   add column tenant_id bigint references tenants (id);
alter table orders     add column tenant_id bigint references tenants (id);
alter table order_items add column tenant_id bigint references tenants (id);
alter table settings   add column tenant_id bigint references tenants (id);

-- 5. Backfill: tudo que existe vai para o tenant 'default' (id = 1).
update stores      set tenant_id = (select id from tenants where slug = 'default') where tenant_id is null;
update users       set tenant_id = (select id from tenants where slug = 'default') where tenant_id is null;
update clients     set tenant_id = (select id from tenants where slug = 'default') where tenant_id is null;
update products    set tenant_id = (select id from tenants where slug = 'default') where tenant_id is null;
update orders      set tenant_id = (select id from tenants where slug = 'default') where tenant_id is null;
update order_items set tenant_id = (select id from tenants where slug = 'default') where tenant_id is null;
update settings    set tenant_id = (select id from tenants where slug = 'default') where tenant_id is null;

-- 6. Agora sim, NOT NULL.
alter table stores      alter column tenant_id set not null;
alter table users       alter column tenant_id set not null;
alter table clients     alter column tenant_id set not null;
alter table products    alter column tenant_id set not null;
alter table orders      alter column tenant_id set not null;
alter table order_items alter column tenant_id set not null;
alter table settings    alter column tenant_id set not null;

-- 7. Settings passa a ser uma linha POR tenant.
-- Recria com PK em tenant_id e remove a singularidade id=1.
alter table settings drop constraint if exists settings_pkey;
alter table settings drop constraint if exists settings_id_check;
alter table settings add column if not exists tenant_id bigint references tenants (id);
update settings set tenant_id = (select id from tenants order by id limit 1) where tenant_id is null;
-- Deduplica (caso o reset tenha rodado antes com múltiplas linhas).
delete from settings a using settings b where a.tenant_id = b.tenant_id and a.ctid > b.ctid;
alter table settings alter column tenant_id set not null;
drop index if exists settings_id_key;
create unique index settings_tenant_key on settings (tenant_id);

-- 8. Login por username (não mais e-mail).
alter table users add column username text;
-- Backfill: o e-mail antigo vira username. Pega a parte antes do @, lowercased.
update users set username = lower(split_part(email, '@', 1)) where username is null;
alter table users alter column username set not null;
-- Email continua existindo (decisão: opcional no cadastro, mas preservamos o
-- antigo). Email não é mais unique global e nem obrigatório.
alter table users alter column email drop not null;
drop index if exists users_email_key;
create unique index users_tenant_username_key on users (tenant_id, lower(username));
create index users_username_idx on users (lower(username));

-- 9. WhatsApp único POR lojamestre (não mais global).
drop index if exists clients_whatsapp_idx;
drop index if exists clients_whatsapp_key;
create unique index clients_tenant_whatsapp_key on clients (tenant_id, whatsapp);

-- 10. Função de tenant lida pelas políticas de RLS. CREATE OR REPLACE para
-- sobreviver a uma reordenação de migrations.
create or replace function app_tenant_id() returns bigint
  language sql stable
  as $$ select nullif(current_setting('app.tenant_id', true), '')::bigint $$;

-- 11. Tabelas com dados: RLS por tenant. Stores, clients, products e settings
-- não tinham RLS antes; agora todas têm.
alter table stores      enable row level security;
alter table stores      force  row level security;
alter table users       enable row level security;
alter table users       force  row level security;
alter table clients     enable row level security;
alter table clients     force  row level security;
alter table products    enable row level security;
alter table products    force  row level security;
alter table settings    enable row level security;
alter table settings    force  row level security;
alter table order_items enable row level security;
alter table order_items force  row level security;
-- orders já tinha RLS, só atualizamos.

-- 12. Helpers de policy: isolar por tenant quando o role é admin/seller.
-- Super admin ignora RLS via superadmin_bypass.
create policy stores_tenant on stores
  for all
  using (tenant_id = (select app_tenant_id()))
  with check (tenant_id = (select app_tenant_id()));

create policy users_tenant on users
  for all
  using (tenant_id = (select app_tenant_id()))
  with check (tenant_id = (select app_tenant_id()));

create policy clients_tenant on clients
  for all
  using (tenant_id = (select app_tenant_id()))
  with check (tenant_id = (select app_tenant_id()));

create policy products_tenant on products
  for all
  using (tenant_id = (select app_tenant_id()))
  with check (tenant_id = (select app_tenant_id()));

create policy settings_tenant on settings
  for all
  using (tenant_id = (select app_tenant_id()))
  with check (tenant_id = (select app_tenant_id()));

-- 13. Orders: política existente passa a também checar tenant. Sellers só
-- vêem pedidos do próprio tenant; admin vê todos do próprio tenant.
drop policy if exists orders_admin on orders;
create policy orders_admin on orders
  for all
  using (
    (select app_role()) = 'admin'
    and tenant_id = (select app_tenant_id())
  )
  with check (
    (select app_role()) = 'admin'
    and tenant_id = (select app_tenant_id())
  );

drop policy if exists orders_seller_select on orders;
create policy orders_seller_select on orders
  for select
  using (
    (select app_role()) = 'seller'
    and tenant_id = (select app_tenant_id())
    and store_id = (select app_store_id())
  );

drop policy if exists orders_seller_insert on orders;
create policy orders_seller_insert on orders
  for insert
  with check (
    (select app_role()) = 'seller'
    and tenant_id = (select app_tenant_id())
    and store_id = (select app_store_id())
    and user_id = (select app_user_id())
  );

drop policy if exists orders_seller_update on orders;
create policy orders_seller_update on orders
  for update
  using (
    (select app_role()) = 'seller'
    and tenant_id = (select app_tenant_id())
    and store_id = (select app_store_id())
  )
  with check (
    (select app_role()) = 'seller'
    and tenant_id = (select app_tenant_id())
    and store_id = (select app_store_id())
  );

-- 14. Order items seguem o tenant do pedido.
drop policy if exists order_items_via_order on order_items;
create policy order_items_via_order on order_items
  for all
  using (
    exists (
      select 1 from orders o
      where o.id = order_items.order_id
        and o.tenant_id = (select app_tenant_id())
    )
  )
  with check (
    exists (
      select 1 from orders o
      where o.id = order_items.order_id
        and o.tenant_id = (select app_tenant_id())
    )
  );

-- 15. Código de produto único por lojamestre.
drop index if exists products_code_key;
create unique index products_tenant_code_key on products (tenant_id, lower(code)) where code is not null;
