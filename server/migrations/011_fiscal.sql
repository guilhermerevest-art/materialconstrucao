-- Módulo fiscal: emissão de NF-e (modelo 55) e NFC-e (modelo 65) e monitor de
-- notas recebidas (distribuição DF-e), tudo pela ACBr API.
--
-- O XML assinado, o DANFE e o protocolo ficam guardados na ACBr API; aqui fica
-- só o que a tela precisa para listar, numerar e chegar ao documento de lá.

-- 1. Produto: dados fiscais (aba "Fiscal" do cadastro). Todos opcionais no
-- cadastro; a emissão recusa a nota e diz o que falta quando o produto vai para
-- uma NF-e sem eles.
alter table products add column gtin text;
alter table products add column ncm text;
alter table products add column cest text;
alter table products add column cfop text;
-- Origem da mercadoria (0 = nacional ... 8), tabela A do ICMS.
alter table products add column tax_origin smallint not null default 0;
-- CST do ICMS (regime normal) ou CSOSN (Simples Nacional), conforme o CRT da empresa.
alter table products add column icms_cst text;
-- Alíquota do ICMS; no CSOSN 101 é a alíquota do crédito do Simples.
alter table products add column icms_rate numeric(5, 2);
alter table products add column icms_base_reduction numeric(5, 2);
alter table products add column pis_cst text;
alter table products add column pis_rate numeric(7, 4);
alter table products add column cofins_cst text;
alter table products add column cofins_rate numeric(7, 4);
-- Reforma tributária: CST e classificação tributária do IBS/CBS (só regime normal).
alter table products add column ibscbs_cst text;
alter table products add column ibscbs_class text;
-- Código de benefício fiscal (cBenef), exigido por algumas UFs em CSTs com benefício.
alter table products add column tax_benefit_code text;
-- Sai em "informações adicionais do produto" (infAdProd) na nota.
alter table products add column fiscal_notes text;

alter table products add constraint products_fiscal_format check (
  (gtin is null or gtin ~ '^(\d{8}|\d{12,14})$')
  and (ncm is null or ncm ~ '^\d{8}$')
  and (cest is null or cest ~ '^\d{7}$')
  and (cfop is null or cfop ~ '^[1-7]\d{3}$')
  and tax_origin between 0 and 8
  and (icms_rate is null or icms_rate between 0 and 100)
  and (icms_base_reduction is null or icms_base_reduction between 0 and 100)
  and (pis_rate is null or pis_rate between 0 and 100)
  and (cofins_rate is null or cofins_rate between 0 and 100)
);

-- 2. Cliente: cadastro completo (aba "Cadastro completo"), exigido pela NF-e.
-- Nome e WhatsApp continuam sendo o cadastro mínimo do balcão.
alter table clients add column person_type text;
-- CPF (11 dígitos) ou CNPJ (14 posições; o CNPJ alfanumérico tem letras nas 12 primeiras).
alter table clients add column document text;
alter table clients add column trade_name text;
alter table clients add column state_registration text;
-- Indicador da IE do destinatário: 1 contribuinte, 2 isento, 9 não contribuinte.
alter table clients add column ie_indicator smallint;
-- Consumidor final (indFinal). Revenda é quem compra para revender.
alter table clients add column final_consumer boolean not null default true;
alter table clients add column email text;
alter table clients add column phone text;
alter table clients add column address_zip text;
alter table clients add column address_street text;
alter table clients add column address_number text;
alter table clients add column address_complement text;
alter table clients add column address_district text;
alter table clients add column address_city text;
-- Código IBGE do município (7 dígitos), exigido no endereço da NF-e.
alter table clients add column address_city_code text;
alter table clients add column address_state text;

alter table clients add constraint clients_fiscal_format check (
  (person_type is null or person_type in ('F', 'J'))
  and (document is null or (person_type = 'F' and document ~ '^\d{11}$')
                        or (person_type = 'J' and document ~ '^[0-9A-Z]{12}\d{2}$'))
  and (ie_indicator is null or ie_indicator in (1, 2, 9))
  and (address_zip is null or address_zip ~ '^\d{8}$')
  and (address_city_code is null or address_city_code ~ '^\d{7}$')
  and (address_state is null or address_state ~ '^[A-Z]{2}$')
);
-- Sem unicidade: uma construtora pode ter vários compradores, cada um com o seu WhatsApp.
create index clients_tenant_document_idx on clients (tenant_id, document) where document is not null;

-- 3. Dados da empresa emitente, uma linha por lojamestre (Configurações → Fiscal).
create table fiscal_settings (
  tenant_id                 bigint primary key references tenants (id),
  -- Ambiente da SEFAZ das notas emitidas e da distribuição DF-e.
  environment               text not null default 'homologacao',
  -- Conta própria na ACBr API. Em branco, vale a conta da plataforma (ACBR_CLIENT_ID).
  acbr_client_id            text,
  acbr_client_secret        text,
  cnpj                      text,
  legal_name                text,
  trade_name                text,
  state_registration        text,
  municipal_registration    text,
  cnae                      text,
  -- CRT: 1 Simples Nacional, 2 Simples com excesso de sublimite, 3 regime normal, 4 MEI.
  tax_regime                smallint,
  email                     text,
  phone                     text,
  address_zip               text,
  address_street            text,
  address_number            text,
  address_complement        text,
  address_district          text,
  address_city              text,
  address_city_code         text,
  address_state             text,
  operation_nature          text not null default 'Venda de mercadoria',
  -- Texto fixo das informações complementares (ex.: aviso do Simples Nacional).
  additional_info           text,
  nfe_series                integer not null default 1,
  nfe_next_number           integer not null default 1,
  nfce_series               integer not null default 1,
  nfce_next_number          integer not null default 1,
  -- CSC (Código de Segurança do Contribuinte) do QR Code da NFC-e, gerado no site da SEFAZ.
  nfce_csc_id               text,
  nfce_csc                  text,
  -- Alíquotas do IBS/CBS do período de teste da reforma (2026: CBS 0,9%, IBS 0,1%).
  ibs_uf_rate               numeric(5, 2) not null default 0.10,
  ibs_mun_rate              numeric(5, 2) not null default 0,
  cbs_rate                  numeric(5, 2) not null default 0.90,
  -- Monitor de notas recebidas: a ACBr API consulta a SEFAZ sozinha a cada poucas horas.
  inbound_auto_distribution boolean not null default true,
  -- Ciência da operação automática ao receber o resumo (libera o XML completo).
  inbound_auto_acknowledge  boolean not null default false,
  inbound_last_nsu          bigint not null default 0,
  inbound_synced_at         timestamptz,
  -- O certificado A1 vai direto para a ACBr API; aqui só os dados para mostrar a validade.
  certificate_subject       text,
  certificate_valid_until   timestamptz,
  certificate_uploaded_at   timestamptz,
  -- Última vez que o cadastro foi enviado para a ACBr API.
  company_synced_at         timestamptz,
  updated_at                timestamptz not null default now(),
  constraint fiscal_settings_format check (
    environment in ('homologacao', 'producao')
    and (cnpj is null or cnpj ~ '^[0-9A-Z]{12}\d{2}$')
    and (tax_regime is null or tax_regime in (1, 2, 3, 4))
    and (address_zip is null or address_zip ~ '^\d{8}$')
    and (address_city_code is null or address_city_code ~ '^\d{7}$')
    and (address_state is null or address_state ~ '^[A-Z]{2}$')
    and nfe_series between 0 and 889
    and nfce_series between 0 and 889
    and nfe_next_number between 1 and 999999999
    and nfce_next_number between 1 and 999999999
  )
);
-- Na conta da plataforma, o CNPJ é o que separa as empresas dentro da ACBr API:
-- duas lojamestres com o mesmo CNPJ veriam as notas uma da outra.
create unique index fiscal_settings_cnpj_key on fiscal_settings (cnpj);

alter table fiscal_settings enable row level security;
alter table fiscal_settings force  row level security;
create policy fiscal_settings_tenant on fiscal_settings
  for all
  using (tenant_id = (select app_tenant_id()))
  with check (tenant_id = (select app_tenant_id()));

-- 4. Notas emitidas. Cada uma nasce de um pedido confirmado.
create table fiscal_documents (
  id               bigint generated always as identity primary key,
  tenant_id        bigint not null references tenants (id),
  store_id         bigint not null references stores (id),
  order_id         bigint not null references orders (id),
  user_id          bigint not null references users (id),
  model            smallint not null,
  environment      text not null,
  series           integer not null,
  number           integer not null,
  status           text not null default 'pendente',
  -- Rejeitada ou com erro, a nota é reenviada com o mesmo número (a SEFAZ não
  -- consumiu o número). Cada envio tem a sua referência na ACBr API.
  attempts         integer not null default 1,
  reference        text,
  acbr_id          text,
  access_key       text,
  protocol         text,
  status_code      integer,
  status_message   text,
  total_amount     numeric(14, 2) not null,
  recipient_name   text,
  recipient_document text,
  issued_at        timestamptz,
  authorized_at    timestamptz,
  cancelled_at     timestamptz,
  cancel_reason    text,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  constraint fiscal_documents_format check (
    model in (55, 65)
    and environment in ('homologacao', 'producao')
    and status in ('pendente', 'autorizado', 'rejeitado', 'denegado', 'cancelado', 'erro', 'inutilizado')
  )
);
-- Número e série não se repetem por modelo e ambiente.
create unique index fiscal_documents_number_key on fiscal_documents (tenant_id, model, environment, series, number);
-- Um pedido tem no máximo uma nota em aberto (em processamento, autorizada ou
-- esperando correção). Cancelada, denegada ou inutilizada libera uma nova.
create unique index fiscal_documents_order_open_key on fiscal_documents (order_id)
  where status in ('pendente', 'autorizado', 'rejeitado', 'erro');
create index fiscal_documents_tenant_created_idx on fiscal_documents (tenant_id, created_at desc);
create index fiscal_documents_store_idx on fiscal_documents (store_id, created_at desc);

-- Mesmas regras dos pedidos: admin vê a rede; vendedor, a própria loja.
alter table fiscal_documents enable row level security;
alter table fiscal_documents force  row level security;
create policy fiscal_documents_admin on fiscal_documents
  for all
  using ((select app_role()) = 'admin' and tenant_id = (select app_tenant_id()))
  with check ((select app_role()) = 'admin' and tenant_id = (select app_tenant_id()));
create policy fiscal_documents_seller_select on fiscal_documents
  for select
  using (
    (select app_role()) = 'seller'
    and tenant_id = (select app_tenant_id())
    and store_id = (select app_store_id())
  );
create policy fiscal_documents_seller_insert on fiscal_documents
  for insert
  with check (
    (select app_role()) = 'seller'
    and tenant_id = (select app_tenant_id())
    and store_id = (select app_store_id())
    and user_id = (select app_user_id())
  );
create policy fiscal_documents_seller_update on fiscal_documents
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

-- 5. Notas recebidas (monitor): NF-e emitidas por fornecedores contra o CNPJ da
-- empresa, trazidas da SEFAZ pela distribuição DF-e. Uma linha por chave: o
-- resumo chega primeiro e é trocado pela nota completa depois da ciência.
create table fiscal_inbound_documents (
  id                        bigint generated always as identity primary key,
  tenant_id                 bigint not null references tenants (id),
  environment               text not null,
  access_key                text not null,
  -- Documento na ACBr API (o mais completo recebido para esta chave).
  acbr_id                   text not null,
  nsu                       bigint,
  summary                   boolean not null default true,
  issuer_document           text,
  issuer_name               text,
  issuer_state_registration text,
  -- 0 entrada, 1 saída (do ponto de vista de quem emitiu).
  nfe_type                  smallint,
  amount                    numeric(14, 2),
  protocol                  text,
  issued_at                 timestamptz,
  authorized_at             timestamptz,
  -- O emitente cancelou a nota (evento 110111 recebido pela distribuição).
  cancelled                 boolean not null default false,
  -- Manifestação do destinatário: 210200 confirmação, 210210 ciência,
  -- 210220 desconhecimento, 210240 operação não realizada.
  manifestation             text,
  manifestation_status      text,
  manifestation_message     text,
  manifested_at             timestamptz,
  -- Evento na ACBr API, para acompanhar a manifestação que ficou em processamento.
  manifestation_acbr_id     text,
  created_at                timestamptz not null default now(),
  updated_at                timestamptz not null default now(),
  constraint fiscal_inbound_documents_format check (
    environment in ('homologacao', 'producao')
    and (manifestation is null or manifestation in ('210200', '210210', '210220', '210240'))
  )
);
create unique index fiscal_inbound_documents_key on fiscal_inbound_documents (tenant_id, environment, access_key);
create index fiscal_inbound_documents_tenant_idx on fiscal_inbound_documents (tenant_id, environment, coalesce(issued_at, created_at) desc);

alter table fiscal_inbound_documents enable row level security;
alter table fiscal_inbound_documents force  row level security;
create policy fiscal_inbound_documents_tenant on fiscal_inbound_documents
  for all
  using (tenant_id = (select app_tenant_id()))
  with check (tenant_id = (select app_tenant_id()));
