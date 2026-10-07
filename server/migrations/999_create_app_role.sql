-- Cria um usuário de aplicação sem superuser/bypassrls.
-- Os testes e a app conectam com esse role (não com postgres) para que
-- as políticas de RLS sejam aplicadas de verdade.
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'oms_app') then
    create role oms_app with login password 'oms_app' nosuperuser nobypassrls;
  end if;
end $$;

grant connect on database oms_test to oms_app;
grant usage on schema public to oms_app;
grant select, insert, update, delete on all tables in schema public to oms_app;
grant usage, select on all sequences in schema public to oms_app;
alter default privileges in schema public grant select, insert, update, delete on tables to oms_app;
alter default privileges in schema public grant usage, select on sequences to oms_app;