-- Formas de pagamento por lojamestre (Dinheiro, PIX, Cartão...). O orçamento ou
-- pedido aponta para uma delas e guarda também o nome da época, como os itens
-- guardam o nome do produto: renomear a forma depois não muda pedidos antigos.
create table payment_methods (
  id         bigint generated always as identity primary key,
  tenant_id  bigint not null references tenants (id),
  name       text not null,
  active     boolean not null default true,
  created_at timestamptz not null default now()
);
create unique index payment_methods_tenant_name_key on payment_methods (tenant_id, lower(name));

-- As mais comuns já vêm cadastradas em todas as lojamestres. Roda antes de
-- ligar o RLS: com ele forçado, o dono da tabela não enxergaria nenhuma lojamestre.
insert into payment_methods (tenant_id, name)
select t.id, m.name
  from tenants t
 cross join (values ('Dinheiro'), ('PIX'), ('Cartão de débito'), ('Cartão de crédito'), ('Boleto')) as m(name);

alter table payment_methods enable row level security;
alter table payment_methods force  row level security;
create policy payment_methods_tenant on payment_methods
  for all
  using (tenant_id = (select app_tenant_id()))
  with check (tenant_id = (select app_tenant_id()));

-- Opcional: pedidos antigos e orçamentos ainda sem forma definida ficam em branco.
alter table orders add column payment_method_id bigint references payment_methods (id);
alter table orders add column payment_method_name text;
create index orders_payment_method_idx on orders (payment_method_id);
