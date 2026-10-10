-- Financeiro: contas a receber, caixa e PIX. Desligado por padrão (settings.finance_enabled):
-- sem ele nada muda, nenhum pedido gera parcela e nada bloqueia a venda. Ligado, cada
-- pedido confirmado gera as parcelas da forma de pagamento, recebidas no caixa.

-- Forma de pagamento: o tipo (para o caixa saber o que é dinheiro na gaveta e o que é
-- crediário) e a condição (parcelas e vencimentos).
alter table payment_methods add column kind text not null default 'other'
  check (kind in ('cash', 'pix', 'card', 'boleto', 'store_credit', 'other'));
alter table payment_methods add column installments integer not null default 1 check (installments between 1 and 48);
-- Dias da venda até a 1ª parcela (0 = à vista, no dia) e entre as parcelas.
alter table payment_methods add column first_due_days integer not null default 0 check (first_due_days between 0 and 365);
alter table payment_methods add column interval_days integer not null default 30 check (interval_days between 1 and 365);

-- As que vieram cadastradas ganham o tipo pelo nome. FORCE RLS vale para o dono da
-- tabela: sem desligar, o update não enxerga nenhuma linha.
alter table payment_methods no force row level security;
update payment_methods set kind = case
  when search_norm(name) like '%dinheiro%' then 'cash'
  when search_norm(name) like '%pix%' then 'pix'
  when search_norm(name) like '%cartao%' then 'card'
  when search_norm(name) like '%boleto%' then 'boleto'
  when search_norm(name) like '%crediario%' then 'store_credit'
  else 'other'
end;
alter table payment_methods force row level security;

alter table settings add column finance_enabled boolean not null default false;
-- PIX da loja: o QR Code sai com a chave, o nome e a cidade (como no cadastro do banco).
alter table settings add column pix_key text;
alter table settings add column pix_merchant_name text;
alter table settings add column pix_city text;

create table receivables (
  id                  bigint generated always as identity primary key,
  tenant_id           bigint not null references tenants (id),
  store_id            bigint not null references stores (id),
  order_id            bigint references orders (id) on delete cascade,
  client_id           bigint not null references clients (id),
  installment         integer not null default 1,
  installments        integer not null default 1,
  due_date            date not null,
  amount              numeric(14, 2) not null check (amount > 0),
  paid_amount         numeric(14, 2) not null default 0 check (paid_amount >= 0),
  status              text not null default 'open' check (status in ('open', 'paid', 'cancelled')),
  payment_method_id   bigint references payment_methods (id),
  payment_method_name text,
  kind                text not null default 'other',
  created_at          timestamptz not null default now(),
  paid_at             timestamptz,
  cancelled_at        timestamptz,
  cancel_reason       text,
  constraint receivables_paid_limit check (paid_amount <= amount)
);
create index receivables_order_idx on receivables (order_id);
create index receivables_client_open_idx on receivables (client_id) where status = 'open';
create index receivables_store_due_idx on receivables (store_id, due_date) where status = 'open';

-- Caixa: um por operador aberto de cada vez.
create table cash_sessions (
  id             bigint generated always as identity primary key,
  tenant_id      bigint not null references tenants (id),
  store_id       bigint not null references stores (id),
  user_id        bigint not null references users (id),
  opened_at      timestamptz not null default now(),
  opening_amount numeric(14, 2) not null default 0 check (opening_amount >= 0),
  closed_at      timestamptz,
  closed_by      bigint references users (id),
  -- Dinheiro contado na gaveta ao fechar.
  counted_amount numeric(14, 2),
  closing_notes  text
);
create unique index cash_sessions_open_user_key on cash_sessions (user_id) where closed_at is null;
create index cash_sessions_store_idx on cash_sessions (store_id, opened_at desc);

create table receivable_payments (
  id               bigint generated always as identity primary key,
  tenant_id        bigint not null references tenants (id),
  receivable_id    bigint not null references receivables (id) on delete cascade,
  cash_session_id  bigint not null references cash_sessions (id),
  payment_method_id bigint references payment_methods (id),
  method_name      text not null,
  kind             text not null,
  amount           numeric(14, 2) not null check (amount > 0),
  user_id          bigint not null references users (id),
  received_at      timestamptz not null default now(),
  reversed_at      timestamptz,
  reversed_by      bigint references users (id),
  reverse_reason   text
);
create index receivable_payments_receivable_idx on receivable_payments (receivable_id);
create index receivable_payments_session_idx on receivable_payments (cash_session_id);

-- Sangria (tirar dinheiro da gaveta) e suprimento (pôr troco).
create table cash_movements (
  id              bigint generated always as identity primary key,
  tenant_id       bigint not null references tenants (id),
  cash_session_id bigint not null references cash_sessions (id),
  kind            text not null check (kind in ('withdrawal', 'deposit')),
  amount          numeric(14, 2) not null check (amount > 0),
  reason          text not null,
  user_id         bigint not null references users (id),
  created_at      timestamptz not null default now()
);
create index cash_movements_session_idx on cash_movements (cash_session_id);

-- RLS por lojamestre: o limite do crediário soma o que o cliente deve em todas as
-- lojas. A API mostra ao vendedor só a loja dele.
alter table receivables enable row level security;
alter table receivables force  row level security;
create policy receivables_tenant on receivables
  for all using (tenant_id = (select app_tenant_id())) with check (tenant_id = (select app_tenant_id()));

alter table cash_sessions enable row level security;
alter table cash_sessions force  row level security;
create policy cash_sessions_tenant on cash_sessions
  for all using (tenant_id = (select app_tenant_id())) with check (tenant_id = (select app_tenant_id()));

alter table receivable_payments enable row level security;
alter table receivable_payments force  row level security;
create policy receivable_payments_tenant on receivable_payments
  for all using (tenant_id = (select app_tenant_id())) with check (tenant_id = (select app_tenant_id()));

alter table cash_movements enable row level security;
alter table cash_movements force  row level security;
create policy cash_movements_tenant on cash_movements
  for all using (tenant_id = (select app_tenant_id())) with check (tenant_id = (select app_tenant_id()));
