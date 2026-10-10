-- Fiado (caderneta): conta corrente do cliente na loja. Cada compra fiada soma no saldo e
-- vence no dia de vencimento do mês seguinte; o pagamento abate as compras mais antigas.
-- Módulo próprio, desligado por padrão e independente do financeiro (com o financeiro
-- ligado, o recebimento em dinheiro passa pelo caixa).

alter table settings add column fiado_enabled boolean not null default false;
-- Dia do mês em que vencem as compras do mês anterior (o cliente pode ter o próprio).
alter table settings add column fiado_due_day smallint not null default 10 check (fiado_due_day between 1 and 28);
-- Dias de atraso tolerados antes de bloquear novas compras fiadas (0 = qualquer atraso bloqueia).
alter table settings add column fiado_block_days integer not null default 0 check (fiado_block_days between 0 and 365);
-- Encargos por atraso (opcionais): multa única e juros ao mês, proporcionais aos dias.
alter table settings add column fiado_late_fee_percent numeric(5, 2) not null default 0 check (fiado_late_fee_percent between 0 and 20);
alter table settings add column fiado_interest_percent numeric(5, 2) not null default 0 check (fiado_interest_percent between 0 and 20);
-- Mensagem de cobrança pelo WhatsApp. Nula = a padrão do sistema.
alter table settings add column fiado_message text;

alter table clients add column fiado_due_day smallint check (fiado_due_day between 1 and 28);

-- Forma de pagamento "fiado": vender na caderneta.
alter table payment_methods drop constraint payment_methods_kind_check;
alter table payment_methods add constraint payment_methods_kind_check
  check (kind in ('cash', 'pix', 'card', 'boleto', 'store_credit', 'fiado', 'other'));

-- Lançamentos da conta. amount com sinal: débito (compra, encargo, ajuste a mais) positivo;
-- crédito (pagamento, devolução, ajuste a menos) negativo. O saldo é a soma dos não cancelados.
create table fiado_entries (
  id                  bigint generated always as identity primary key,
  tenant_id           bigint not null references tenants (id),
  store_id            bigint references stores (id),
  client_id           bigint not null references clients (id),
  kind                text not null check (kind in ('purchase', 'charge', 'payment', 'refund', 'adjustment')),
  amount              numeric(14, 2) not null check (amount <> 0),
  -- Débitos vencem; créditos não.
  due_date            date,
  description         text,
  order_id            bigint references orders (id) on delete set null,
  -- Recebimento: como o cliente pagou e em qual caixa (com o financeiro ligado).
  payment_method_id   bigint references payment_methods (id),
  payment_method_name text,
  payment_kind        text,
  cash_session_id     bigint references cash_sessions (id),
  -- Encargo cobrado junto com um recebimento: cai junto se o recebimento for estornado.
  payment_entry_id    bigint references fiado_entries (id),
  user_id             bigint not null references users (id),
  created_at          timestamptz not null default now(),
  -- Compra de pedido cancelado, recebimento estornado.
  cancelled_at        timestamptz,
  cancelled_by        bigint references users (id),
  cancel_reason       text,
  constraint fiado_entries_sign check (
    (kind in ('purchase', 'charge') and amount > 0 and due_date is not null)
    or (kind in ('payment', 'refund') and amount < 0)
    or (kind = 'adjustment' and (amount < 0 or due_date is not null))
  )
);
create index fiado_entries_client_idx on fiado_entries (client_id, created_at);
create index fiado_entries_order_idx on fiado_entries (order_id) where order_id is not null;
create index fiado_entries_session_idx on fiado_entries (cash_session_id) where cash_session_id is not null;

alter table fiado_entries enable row level security;
alter table fiado_entries force  row level security;
create policy fiado_entries_tenant on fiado_entries
  for all using (tenant_id = (select app_tenant_id())) with check (tenant_id = (select app_tenant_id()));
