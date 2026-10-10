-- Fluxo do pedido depois de confirmado (Faturamento → Separação → Expedição...).
-- Cada lojamestre monta um modelo por tipo de entrega (retirada na loja ou entrega),
-- e cada loja usa o modelo ou tem o próprio fluxo. Sem fluxo configurado nada muda:
-- o pedido fica sem etapa, como antes desta migração. Pedidos já confirmados também
-- ficam sem etapa, para os monitores não amanhecerem cheios de pedidos antigos.

-- Setores (áreas) da lojamestre. Cada etapa pertence a um setor; o monitor de cada
-- área mostra os pedidos das etapas do setor, e só quem é do setor tira o pedido dali.
create table sectors (
  id         bigint generated always as identity primary key,
  tenant_id  bigint not null references tenants (id),
  name       text not null,
  created_at timestamptz not null default now()
);
create unique index sectors_tenant_name_key on sectors (tenant_id, lower(name));

create table user_sectors (
  user_id   bigint not null references users (id) on delete cascade,
  sector_id bigint not null references sectors (id) on delete cascade,
  tenant_id bigint not null references tenants (id),
  primary key (user_id, sector_id)
);
create index user_sectors_sector_idx on user_sectors (sector_id);

-- store_id nulo é o modelo da lojamestre: vale para as lojas sem fluxo próprio
-- daquele tipo de entrega. coalesce porque o índice único trata nulos como diferentes.
create table workflows (
  id            bigint generated always as identity primary key,
  tenant_id     bigint not null references tenants (id),
  store_id      bigint references stores (id) on delete cascade,
  delivery_type text not null check (delivery_type in ('pickup', 'delivery')),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create unique index workflows_scope_key on workflows (tenant_id, coalesce(store_id, 0), delivery_type);

-- A última etapa (maior posição) é a final: o pedido que chega nela está concluído
-- e sai dos monitores. A unicidade da posição é conferida no fim da transação para
-- a reordenação poder trocar duas etapas de lugar.
create table workflow_stages (
  id               bigint generated always as identity primary key,
  tenant_id        bigint not null references tenants (id),
  workflow_id      bigint not null references workflows (id) on delete cascade,
  position         integer not null check (position > 0),
  name             text not null,
  sector_id        bigint references sectors (id),
  -- Tempo esperado na etapa. Passou disso, o cartão fica vermelho no monitor.
  sla_minutes      integer check (sla_minutes > 0),
  -- Mensagem de WhatsApp ao cliente quando o pedido avança para esta etapa.
  whatsapp_message text,
  created_at       timestamptz not null default now(),
  constraint workflow_stages_position_key unique (workflow_id, position) deferrable initially deferred
);
create index workflow_stages_sector_idx on workflow_stages (sector_id);

-- Etapa com pedido não pode ser excluída (a FK barra): o pedido ficaria sem rumo.
alter table orders add column stage_id bigint references workflow_stages (id);
alter table orders add column stage_entered_at timestamptz;
create index orders_stage_idx on orders (stage_id) where stage_id is not null;

-- Histórico de etapas do pedido. Os nomes são copiados, como nos itens do pedido:
-- renomear ou excluir a etapa depois não apaga o que aconteceu.
create table order_stage_events (
  id              bigint generated always as identity primary key,
  tenant_id       bigint not null references tenants (id),
  order_id        bigint not null references orders (id) on delete cascade,
  from_stage_id   bigint references workflow_stages (id) on delete set null,
  to_stage_id     bigint references workflow_stages (id) on delete set null,
  from_stage_name text,
  to_stage_name   text not null,
  user_id         bigint not null references users (id),
  note            text,
  created_at      timestamptz not null default now()
);
create index order_stage_events_order_idx on order_stage_events (order_id, created_at);

-- RLS por lojamestre. Quem altera setores e fluxos (só o admin) é controlado na API,
-- como nas formas de pagamento; o histórico segue a visibilidade do pedido.
alter table sectors enable row level security;
alter table sectors force  row level security;
create policy sectors_tenant on sectors
  for all
  using (tenant_id = (select app_tenant_id()))
  with check (tenant_id = (select app_tenant_id()));

alter table user_sectors enable row level security;
alter table user_sectors force  row level security;
create policy user_sectors_tenant on user_sectors
  for all
  using (tenant_id = (select app_tenant_id()))
  with check (tenant_id = (select app_tenant_id()));

alter table workflows enable row level security;
alter table workflows force  row level security;
create policy workflows_tenant on workflows
  for all
  using (tenant_id = (select app_tenant_id()))
  with check (tenant_id = (select app_tenant_id()));

alter table workflow_stages enable row level security;
alter table workflow_stages force  row level security;
create policy workflow_stages_tenant on workflow_stages
  for all
  using (tenant_id = (select app_tenant_id()))
  with check (tenant_id = (select app_tenant_id()));

alter table order_stage_events enable row level security;
alter table order_stage_events force  row level security;
create policy order_stage_events_via_order on order_stage_events
  for all
  using (
    exists (
      select 1 from orders o
       where o.id = order_stage_events.order_id
         and o.tenant_id = (select app_tenant_id())
    )
  )
  with check (
    exists (
      select 1 from orders o
       where o.id = order_stage_events.order_id
         and o.tenant_id = (select app_tenant_id())
    )
  );
