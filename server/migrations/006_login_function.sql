-- 006: o login precisa buscar o usuário por (tenant_slug, username) sem que
-- o contexto de RLS (app.user_id) esteja setado — estamos *autenticando*.
-- Sem isso, a policy users_tenant esconde todas as linhas e o login nunca acha.
--
-- Solução: a aplicação usa um segundo pool (sem RLS) só para o SELECT de
-- login. O pool principal (que respeita RLS) continua valendo para todas as
-- demais rotas. O segundo pool conecta com o role `oms_login`, que tem
-- BYPASSRLS — sua única consulta autorizada é a `find_login` (não tem grant
-- direto nas tabelas), portanto o risco de bypass é zero.
-- oms_login NÃO recebe grants em tabelas. Só pode chamar find_login.
do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'oms_login') then
    create role oms_login with login password 'oms_login' nosuperuser bypassrls;
  end if;
  execute 'grant connect on database ' || current_database() || ' to oms_login';
end $$;
-- Schema public + uso da função: o role novo não enxerga nada do schema até receber grants.
grant usage on schema public to oms_login;

-- Função que devolve a credencial encontrada. SECURITY DEFINER roda como o
-- dono da função (o usuário que rodou a migration), que tem grant nas
-- tabelas e portanto consegue ler users/tenants mesmo com RLS ativo.
create or replace function find_login(lookup_tenant_slug text, lookup_username text)
returns table (
  user_id bigint,
  password_hash text,
  user_active boolean,
  token_version integer,
  tenant_id bigint,
  tenant_slug text,
  tenant_active boolean
)
language sql
security definer
set search_path = public
as $$
  select u.id, u.password_hash, u.active, u.token_version,
         t.id, t.slug, t.active
    from tenants t
    left join users u on u.tenant_id = t.id and lower(u.username) = lower(lookup_username)
   where lower(t.slug) = lower(lookup_tenant_slug)
   limit 1
$$;

revoke all on function find_login(text, text) from public;
alter function find_login(text, text) owner to postgres;
grant execute on function find_login(text, text) to oms_login;

-- Mesma regra: a leitura do perfil completo (com store_name) é feita por
-- uma função SECURITY DEFINER, para que oms_login não precise de grants em
-- users/stores. O resultado é o mesmo de `loadAuthUser` no auth.ts.
create or replace function load_user_with_store(lookup_user_id bigint)
returns table (
  id bigint,
  tenant_id bigint,
  name text,
  username text,
  email text,
  role text,
  store_id bigint,
  store_name text,
  active boolean,
  token_version integer
)
language sql
security definer
set search_path = public
as $$
  select u.id, u.tenant_id, u.name, u.username, u.email, u.role, u.store_id,
         s.name as store_name, u.active, u.token_version
    from users u
    left join stores s on s.id = u.store_id
   where u.id = lookup_user_id
$$;

revoke all on function load_user_with_store(bigint) from public;
alter function load_user_with_store(bigint) owner to postgres;
grant execute on function load_user_with_store(bigint) to oms_login;