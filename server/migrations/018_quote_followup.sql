-- Retomada de orçamentos: voltar a falar com quem pediu orçamento e não fechou.
-- Sem configurar nada vale o padrão: 3 dias depois do último contato, com a mensagem pronta.

alter table settings add column followup_days integer not null default 3 check (followup_days between 1 and 60);
-- Mensagem da retomada pelo WhatsApp. Nula = a mensagem padrão do sistema.
alter table settings add column followup_message text;

-- Último contato da retomada e quantos já foram. Criar o orçamento e enviar o PDF
-- (sent_at) também contam como contato.
alter table orders add column last_followup_at timestamptz;
alter table orders add column followup_count integer not null default 0;
-- Dia combinado para o próximo contato ("me liga semana que vem").
-- Nulo = followup_days depois do último contato.
alter table orders add column followup_on date;

create index orders_open_quotes_idx on orders (tenant_id, store_id) where status = 'quote';

create table order_followups (
  id         bigint generated always as identity primary key,
  tenant_id  bigint not null references tenants (id),
  order_id   bigint not null references orders (id) on delete cascade,
  user_id    bigint not null references users (id),
  channel    text not null check (channel in ('whatsapp', 'call', 'visit', 'other')),
  note       text,
  -- Texto enviado pelo WhatsApp, como saiu.
  message    text,
  with_pdf   boolean not null default false,
  -- Próximo contato combinado nesta conversa.
  next_on    date,
  created_at timestamptz not null default now()
);
create index order_followups_order_idx on order_followups (order_id, created_at desc);

alter table order_followups enable row level security;
alter table order_followups force  row level security;
create policy order_followups_via_order on order_followups
  for all
  using (exists (select 1 from orders o where o.id = order_followups.order_id and o.tenant_id = (select app_tenant_id())))
  with check (exists (select 1 from orders o where o.id = order_followups.order_id and o.tenant_id = (select app_tenant_id())));
