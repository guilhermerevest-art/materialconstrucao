-- Registro de alterações: quem mudou o quê e quando. Gravado pelo próprio banco
-- (gatilhos nas tabelas), para nenhum caminho da API ficar de fora. Só se inclui
-- e se lê: nem a app nem o dono das tabelas alteram ou apagam o que foi gravado.

create table audit_log (
  id          bigserial primary key,
  tenant_id   bigint not null references tenants (id),
  created_at  timestamptz not null default now(),
  -- Sem chave estrangeira: o nome fica gravado e o registro sobrevive ao usuário.
  user_id     bigint,
  user_name   text,
  area        text not null,
  entity      text not null,
  entity_id   bigint,
  label       text,
  action      text not null,
  store_id    bigint,
  -- {"coluna": [antes, depois]}; senhas e chaves aparecem como "•••".
  changes     jsonb,
  note        text,
  ip          text
);

create index audit_log_recent on audit_log (tenant_id, created_at desc, id desc);
create index audit_log_entity on audit_log (tenant_id, entity_id, created_at desc) where entity_id is not null;
create index audit_log_user on audit_log (tenant_id, user_id, created_at desc);

alter table audit_log enable row level security;
alter table audit_log force row level security;
create policy audit_log_read on audit_log for select
  using (tenant_id = (select app_tenant_id()));
-- Sem lojamestre no contexto (migrações), o gatilho grava a da própria linha.
create policy audit_log_insert on audit_log for insert
  with check (app_tenant_id() is null or tenant_id = (select app_tenant_id()));

create function audit_log_immutable() returns trigger language plpgsql as $$
begin
  raise exception 'O registro de alterações não pode ser alterado nem apagado.';
end
$$;

create trigger audit_log_immutable before update or delete on audit_log
  for each row execute function audit_log_immutable();
create trigger audit_log_no_truncate before truncate on audit_log
  for each statement execute function audit_log_immutable();

-- Grava uma linha com quem está logado (app.user_id). Sem usuário, vale o
-- app.audit_actor (suporte do revendedor). app.audit = 'off' desliga (cargas em massa
-- de migração). A observação vem de app.audit_note ou do motivo do reajuste de preço.
create function audit_write(
  p_tenant bigint, p_area text, p_entity text, p_entity_id bigint, p_label text,
  p_action text, p_store bigint, p_changes jsonb, p_note text default null
) returns void language plpgsql as $$
declare
  uid bigint := app_user_id();
begin
  if coalesce(current_setting('app.audit', true), '') = 'off' then
    return;
  end if;
  insert into audit_log (tenant_id, user_id, user_name, area, entity, entity_id, label, action, store_id, changes, note)
  values (
    p_tenant, uid,
    coalesce((select u.name from users u where u.id = uid), nullif(current_setting('app.audit_actor', true), '')),
    p_area, p_entity, p_entity_id, p_label, p_action, p_store, p_changes,
    coalesce(p_note, nullif(current_setting('app.audit_note', true), ''), nullif(current_setting('app.price_reason', true), ''))
  );
end
$$;

-- Gatilho genérico. Argumentos:
--   0 área; 1 nome na tela ('' | coluna | product:coluna | order:coluna);
--   2 colunas acompanhadas ('*' = todas); 3 colunas sigilosas; 4 colunas ignoradas.
-- Na inclusão e na exclusão grava os valores preenchidos; na alteração, só o que mudou.
-- cancelled_at preenchido vira a ação "cancel"; reversed_at, "reverse".
create function audit_row() returns trigger language plpgsql as $$
declare
  o jsonb := case when tg_op <> 'INSERT' then to_jsonb(old) end;
  n jsonb := case when tg_op <> 'DELETE' then to_jsonb(new) end;
  r jsonb := coalesce(n, o);
  tracked text[] := case when tg_argv[2] = '*' then null else string_to_array(tg_argv[2], ',') end;
  secret text[] := string_to_array(tg_argv[3], ',');
  skip text[] := array['id', 'tenant_id', 'created_at', 'updated_at', 'logo_data', 'xml'] || string_to_array(tg_argv[4], ',');
  label_spec text := tg_argv[1];
  changes jsonb := '{}';
  k text;
  ov jsonb;
  nv jsonb;
  label text;
  entity_id bigint := (r ->> 'id')::bigint;
  action text := case tg_op when 'INSERT' then 'create' when 'UPDATE' then 'update' else 'delete' end;
begin
  for k in select jsonb_object_keys(r) loop
    continue when k = any(skip) or (tracked is not null and not k = any(tracked));
    ov := coalesce(o -> k, 'null'::jsonb);
    nv := coalesce(n -> k, 'null'::jsonb);
    continue when ov = nv;
    if k = any(secret) then
      ov := case when ov = 'null'::jsonb then ov else '"•••"'::jsonb end;
      nv := case when nv = 'null'::jsonb then nv else '"•••"'::jsonb end;
    end if;
    changes := changes || jsonb_build_object(k, jsonb_build_array(ov, nv));
  end loop;
  if tg_op = 'UPDATE' and changes = '{}'::jsonb then
    return null;
  end if;
  if tg_op = 'UPDATE' and changes ? 'cancelled_at' and changes -> 'cancelled_at' ->> 1 is not null then
    action := 'cancel';
  elsif tg_op = 'UPDATE' and changes ? 'reversed_at' and changes -> 'reversed_at' ->> 1 is not null then
    action := 'reverse';
  end if;

  if label_spec like 'product:%' then
    entity_id := (r ->> substr(label_spec, 9))::bigint;
    label := (select p.name from products p where p.id = entity_id);
  elsif label_spec like 'order:%' then
    label := 'Pedido nº ' || lpad(r ->> substr(label_spec, 7), 6, '0');
  elsif label_spec <> '' then
    label := r ->> label_spec;
  end if;

  perform audit_write((r ->> 'tenant_id')::bigint, tg_argv[0], tg_table_name, entity_id, label, action,
                      (r ->> 'store_id')::bigint, nullif(changes, '{}'::jsonb));
  return null;
end
$$;

-- Pedidos: cancelamento, exclusão, desconto liberado e mudança em pedido já confirmado.
-- Montar e converter orçamento é o dia a dia e não entra.
create function audit_orders() returns trigger language plpgsql as $$
declare
  o jsonb;
  n jsonb;
  changes jsonb := '{}';
  k text;
  tracked text[];
  label text;
  action text;
begin
  if tg_op = 'DELETE' then
    perform audit_write(old.tenant_id, 'pedidos', 'orders', old.id,
      case when old.status = 'quote' then 'Orçamento' else 'Pedido' end || ' nº ' || lpad(old.id::text, 6, '0'),
      'delete', old.store_id,
      jsonb_build_object('status', jsonb_build_array(old.status, null),
                         'total_amount', jsonb_build_array(old.total_amount, null)));
    return null;
  end if;

  label := case when new.status = 'quote' or (new.status = 'cancelled' and new.cancelled_from = 'quote') then 'Orçamento' else 'Pedido' end
           || ' nº ' || lpad(new.id::text, 6, '0');
  if new.status = 'cancelled' and old.status <> 'cancelled' then
    perform audit_write(new.tenant_id, 'pedidos', 'orders', new.id, label, 'cancel', new.store_id,
      jsonb_build_object('status', jsonb_build_array(old.status, new.status),
                         'total_amount', jsonb_build_array(null, new.total_amount),
                         'cancel_reason', jsonb_build_array(null, new.cancel_reason)));
    return null;
  end if;

  -- Orçamento confirmado agora: o que mudar no resto desta transação é a montagem, não edição.
  if old.status = 'quote' and new.status = 'order' then
    perform set_config('audit.confirmed_' || new.id, 'on', true);
  end if;

  if new.discount_approved_by is not null and new.discount_approved_by is distinct from old.discount_approved_by then
    -- Desconto acima do limite liberado com a senha de alguém (pode ser na criação).
    tracked := array['discount_approved_by', 'discount_approved_percent'];
  elsif old.status = 'order' and new.status = 'order' then
    -- Pedido criado ou confirmado nesta transação: os totais ainda estão sendo montados.
    if old.created_at = now() or coalesce(current_setting('audit.confirmed_' || new.id, true), '') = 'on' then
      return null;
    end if;
    tracked := array['client_id', 'total_amount', 'discount_type', 'discount_value', 'discount_amount', 'payment_method_name', 'price_list_name'];
  else
    return null;
  end if;
  o := to_jsonb(old);
  n := to_jsonb(new);
  foreach k in array tracked loop
    continue when (o -> k) is not distinct from (n -> k);
    changes := changes || jsonb_build_object(k, jsonb_build_array(o -> k, n -> k));
  end loop;
  if changes = '{}'::jsonb then
    return null;
  end if;
  action := case when changes ? 'discount_approved_by' and new.discount_approved_by is not null then 'discount' else 'update' end;
  perform audit_write(new.tenant_id, 'pedidos', 'orders', new.id, label, action, new.store_id, changes);
  return null;
end
$$;

-- Estoque: ajuste (inclui a contagem aprovada) e transferência. Venda, nota e
-- devolução já têm o documento delas.
create function audit_stock() returns trigger language plpgsql as $$
begin
  if new.kind not in ('adjustment', 'transfer_out') then
    return null;
  end if;
  perform audit_write(new.tenant_id, 'estoque', 'stock_movements', new.product_id,
    (select p.name from products p where p.id = new.product_id),
    case new.kind when 'adjustment' then 'adjust' else 'transfer' end, new.store_id,
    jsonb_strip_nulls(jsonb_build_object(
      'quantity', jsonb_build_array(null, new.quantity),
      'balance_after', jsonb_build_array(null, new.balance_after),
      'other_store_id', case when new.other_store_id is not null then jsonb_build_array(null, new.other_store_id) end)),
    new.note);
  return null;
end
$$;

-- Estorno de recebimento e de pagamento.
create function audit_payment_reversal() returns trigger language plpgsql as $$
declare
  label text;
  store bigint;
begin
  if old.reversed_at is not null or new.reversed_at is null then
    return null;
  end if;
  if tg_table_name = 'receivable_payments' then
    select case when r.order_id is not null then 'Pedido nº ' || lpad(r.order_id::text, 6, '0') else 'Conta a receber' end
           || ' — parcela ' || r.installment || '/' || r.installments, r.store_id
      into label, store
      from receivables r where r.id = new.receivable_id;
  else
    select p.description, p.store_id into label, store from payables p where p.id = new.payable_id;
  end if;
  perform audit_write(new.tenant_id, 'financeiro', tg_table_name, new.id, label, 'reverse', store,
    jsonb_build_object('amount', jsonb_build_array(new.amount, null),
                       'reverse_reason', jsonb_build_array(null, new.reverse_reason)));
  return null;
end
$$;

-- Nota fiscal cancelada ou número inutilizado.
create function audit_fiscal_documents() returns trigger language plpgsql as $$
begin
  if new.status is not distinct from old.status or new.status not in ('cancelado', 'inutilizado') then
    return null;
  end if;
  perform audit_write(new.tenant_id, 'fiscal', 'fiscal_documents', new.id,
    case new.model when 55 then 'NF-e' else 'NFC-e' end || ' ' || new.series || '/' || new.number,
    case new.status when 'cancelado' then 'cancel' else 'void' end, new.store_id,
    jsonb_build_object('status', jsonb_build_array(old.status, new.status),
                       'total_amount', jsonb_build_array(null, new.total_amount),
                       'cancel_reason', jsonb_build_array(null, new.cancel_reason)));
  return null;
end
$$;

-- Cadastros e configurações
create trigger audit_products after insert or update or delete on products
  for each row execute function audit_row('produtos', 'name', '*', '', '');
create trigger audit_product_price_tiers after insert or update or delete on product_price_tiers
  for each row execute function audit_row('produtos', 'product:product_id', '*', '', '');
create trigger audit_price_lists after insert or update or delete on price_lists
  for each row execute function audit_row('produtos', 'name', '*', '', '');
create trigger audit_price_list_items after insert or update or delete on price_list_items
  for each row execute function audit_row('produtos', 'product:product_id', '*', '', '');
create trigger audit_clients after update or delete on clients
  for each row execute function audit_row('clientes', 'name', 'name,credit_limit,price_list_id,fiado_due_day', '', '');
create trigger audit_users after insert or update or delete on users
  for each row execute function audit_row('usuarios', 'name', '*', 'password_hash', 'token_version');
create trigger audit_stores after insert or update or delete on stores
  for each row execute function audit_row('configuracoes', 'name', '*', '', '');
create trigger audit_payment_methods after insert or update or delete on payment_methods
  for each row execute function audit_row('configuracoes', 'name', '*', '', '');
create trigger audit_settings after update on settings
  for each row execute function audit_row('configuracoes', '', '*', 'evolution_api_token', '');
create trigger audit_fiscal_settings after insert or update on fiscal_settings
  for each row execute function audit_row('fiscal', '', '*', 'acbr_client_secret,nfce_csc',
    'nfe_next_number,nfce_next_number,inbound_last_nsu,inbound_synced_at,company_synced_at,certificate_uploaded_at');

-- Movimento
create trigger audit_orders after update or delete on orders
  for each row execute function audit_orders();
create trigger audit_stock after insert on stock_movements
  for each row execute function audit_stock();
-- Parcela: só a renegociação (vencimento e valor). O cancelamento vem com o do pedido.
create trigger audit_receivables after update on receivables
  for each row execute function audit_row('financeiro', 'order:order_id', 'due_date,amount', '', '');
create trigger audit_receivable_payments after update on receivable_payments
  for each row execute function audit_payment_reversal();
create trigger audit_payables after insert or update or delete on payables
  for each row execute function audit_row('financeiro', 'description',
    'description,supplier_id,category,document_number,due_date,amount,cancelled_at,cancel_reason', '', '');
create trigger audit_payable_payments after update on payable_payments
  for each row execute function audit_payment_reversal();
create trigger audit_cash_movements after insert on cash_movements
  for each row execute function audit_row('financeiro', 'reason', 'kind,amount,reason', '', '');
-- Fiado: estorno de pagamento e lançamento avulso cancelado (a compra sai com o pedido).
create trigger audit_fiado_entries after update on fiado_entries
  for each row when (new.kind <> 'purchase')
  execute function audit_row('financeiro', 'description', 'amount,cancelled_at,cancel_reason', '', '');
create trigger audit_fiscal_documents after update on fiscal_documents
  for each row execute function audit_fiscal_documents();
