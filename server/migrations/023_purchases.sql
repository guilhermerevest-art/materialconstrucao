-- Compras: fornecedores, pedido de compra (a partir do que está abaixo do mínimo) e
-- contas a pagar (das duplicatas da nota ou lançadas à mão). Nada disso muda a venda:
-- fornecedor e pedido de compra são do administrador, e contas a pagar só aparecem
-- com o financeiro ligado.

-- Unidade de compra: o produto vende em KG e chega em saco de 50 kg (SC, fator 50).
-- A entrada de nota e o pedido de compra convertem; o estoque fica sempre na unidade de venda.
alter table products add column purchase_unit text check (purchase_unit is null or length(purchase_unit) between 1 and 10);
alter table products add column purchase_factor numeric(14, 4) check (purchase_factor > 0);
alter table products add constraint products_purchase_unit_pair check ((purchase_unit is null) = (purchase_factor is null));

create table suppliers (
  id           bigint generated always as identity primary key,
  tenant_id    bigint not null references tenants (id),
  name         text not null,
  -- CNPJ ou CPF, só dígitos. O mesmo fornecedor não é cadastrado duas vezes.
  document     text check (document ~ '^(\d{11}|\d{14})$'),
  contact_name text,
  -- Só dígitos com DDI (como o WhatsApp do cliente).
  whatsapp     text,
  email        text,
  notes        text,
  active       boolean not null default true,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
create unique index suppliers_document_key on suppliers (tenant_id, document) where document is not null;
create index suppliers_name_idx on suppliers (tenant_id, lower(name));

create table purchase_orders (
  id            bigint generated always as identity primary key,
  tenant_id     bigint not null references tenants (id),
  store_id      bigint not null references stores (id),
  supplier_id   bigint not null references suppliers (id),
  user_id       bigint not null references users (id),
  -- Rascunho → enviado ao fornecedor → recebido em parte → recebido (ou encerrado sem o resto).
  status        text not null default 'draft' check (status in ('draft', 'sent', 'partial', 'received', 'cancelled')),
  expected_date date,
  notes         text,
  total_amount  numeric(14, 2) not null default 0,
  sent_at       timestamptz,
  received_at   timestamptz,
  -- Encerrado com itens faltando (o fornecedor não vai mandar o resto).
  closed_short  boolean not null default false,
  cancelled_at  timestamptz,
  cancel_reason text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create index purchase_orders_tenant_idx on purchase_orders (tenant_id, created_at desc);
create index purchase_orders_supplier_idx on purchase_orders (supplier_id);

create table purchase_order_items (
  id                bigint generated always as identity primary key,
  tenant_id         bigint not null references tenants (id),
  purchase_order_id bigint not null references purchase_orders (id) on delete cascade,
  product_id        bigint not null references products (id),
  product_name      text not null,
  unit              text not null,
  -- Na unidade da loja.
  quantity          numeric(14, 3) not null check (quantity > 0),
  unit_cost         numeric(14, 4) check (unit_cost >= 0),
  received_quantity numeric(14, 3) not null default 0 check (received_quantity >= 0),
  -- Pedido na unidade de compra (ex.: 10 SC de 50 KG): o fornecedor recebe em sacos.
  -- quantity e unit_cost continuam na unidade de venda.
  purchase_unit     text,
  purchase_factor   numeric(14, 4) check (purchase_factor > 0),
  position          integer not null default 0,
  unique (purchase_order_id, product_id)
);

-- Entrada de nota ligada ao fornecedor e, se veio de um pedido de compra, a ele.
alter table stock_entries add column supplier_id bigint references suppliers (id);
alter table stock_entries add column purchase_order_id bigint references purchase_orders (id);
create index stock_entries_purchase_order_idx on stock_entries (purchase_order_id) where purchase_order_id is not null;

-- Os fornecedores das notas que já entraram viram cadastro. FORCE RLS vale para o dono
-- da tabela: sem desligar, a leitura e o update não enxergam nenhuma linha.
alter table stock_entries no force row level security;
insert into suppliers (tenant_id, name, document)
select distinct on (tenant_id, supplier_document) tenant_id, coalesce(nullif(trim(supplier_name), ''), supplier_document), supplier_document
  from stock_entries
 where supplier_document ~ '^(\d{11}|\d{14})$'
 order by tenant_id, supplier_document, created_at desc;
insert into suppliers (tenant_id, name)
select distinct on (tenant_id, lower(trim(supplier_name))) tenant_id, trim(supplier_name)
  from stock_entries
 where (supplier_document is null or supplier_document !~ '^(\d{11}|\d{14})$') and nullif(trim(supplier_name), '') is not null
 order by tenant_id, lower(trim(supplier_name)), created_at desc;
update stock_entries e set supplier_id = s.id
  from suppliers s
 where s.tenant_id = e.tenant_id
   and ((e.supplier_document ~ '^(\d{11}|\d{14})$' and s.document = e.supplier_document)
        or ((e.supplier_document is null or e.supplier_document !~ '^(\d{11}|\d{14})$')
            and s.document is null and lower(s.name) = lower(trim(e.supplier_name))));
alter table stock_entries force row level security;

create table payables (
  id                bigint generated always as identity primary key,
  tenant_id         bigint not null references tenants (id),
  store_id          bigint not null references stores (id),
  supplier_id       bigint references suppliers (id),
  description       text not null,
  -- Fornecedor, aluguel, energia... (texto livre com sugestões na tela).
  category          text,
  -- Número da nota ou da duplicata.
  document_number   text,
  installment       integer not null default 1,
  installments      integer not null default 1,
  due_date          date not null,
  amount            numeric(14, 2) not null check (amount > 0),
  paid_amount       numeric(14, 2) not null default 0 check (paid_amount >= 0),
  status            text not null default 'open' check (status in ('open', 'paid', 'cancelled')),
  entry_id          bigint references stock_entries (id),
  purchase_order_id bigint references purchase_orders (id),
  user_id           bigint not null references users (id),
  created_at        timestamptz not null default now(),
  paid_at           timestamptz,
  cancelled_at      timestamptz,
  cancelled_by      bigint references users (id),
  cancel_reason     text,
  constraint payables_paid_limit check (paid_amount <= amount)
);
create index payables_due_idx on payables (tenant_id, due_date) where status = 'open';
create index payables_supplier_idx on payables (supplier_id);
create index payables_entry_idx on payables (entry_id) where entry_id is not null;

create table payable_payments (
  id              bigint generated always as identity primary key,
  tenant_id       bigint not null references tenants (id),
  payable_id      bigint not null references payables (id) on delete cascade,
  amount          numeric(14, 2) not null check (amount > 0),
  paid_on         date not null,
  -- Dinheiro sai da gaveta do caixa aberto de quem pagou; o resto, da conta da loja.
  method          text not null check (method in ('cash', 'bank', 'pix', 'boleto', 'card', 'other')),
  cash_session_id bigint references cash_sessions (id),
  note            text,
  user_id         bigint not null references users (id),
  created_at      timestamptz not null default now(),
  reversed_at     timestamptz,
  reversed_by     bigint references users (id),
  reverse_reason  text,
  check ((method = 'cash') = (cash_session_id is not null))
);
create index payable_payments_payable_idx on payable_payments (payable_id);
create index payable_payments_session_idx on payable_payments (cash_session_id) where cash_session_id is not null;

alter table suppliers enable row level security;
alter table suppliers force  row level security;
create policy suppliers_tenant on suppliers
  for all using (tenant_id = (select app_tenant_id())) with check (tenant_id = (select app_tenant_id()));

alter table purchase_orders enable row level security;
alter table purchase_orders force  row level security;
create policy purchase_orders_tenant on purchase_orders
  for all using (tenant_id = (select app_tenant_id())) with check (tenant_id = (select app_tenant_id()));

alter table purchase_order_items enable row level security;
alter table purchase_order_items force  row level security;
create policy purchase_order_items_tenant on purchase_order_items
  for all using (tenant_id = (select app_tenant_id())) with check (tenant_id = (select app_tenant_id()));

alter table payables enable row level security;
alter table payables force  row level security;
create policy payables_tenant on payables
  for all using (tenant_id = (select app_tenant_id())) with check (tenant_id = (select app_tenant_id()));

alter table payable_payments enable row level security;
alter table payable_payments force  row level security;
create policy payable_payments_tenant on payable_payments
  for all using (tenant_id = (select app_tenant_id())) with check (tenant_id = (select app_tenant_id()));
