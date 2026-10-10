export type Role = 'admin' | 'seller';

export type User = {
  id: number;
  name: string;
  username: string;
  email: string | null;
  role: Role;
  store_id: number | null;
  store_name: string | null;
};

export type ManagedUser = User & { active: boolean; created_at: string };

export type Store = {
  id: number;
  name: string;
  address: string | null;
  phone: string | null;
  users_count: number;
  /** A imagem em si vem por GET /stores/:id/logo, fora do estado da tela. */
  has_logo: boolean;
  created_at: string;
};

/** Endereço no formato da NF-e (CEP e código IBGE só com dígitos). */
export type FiscalAddress = {
  address_zip: string | null;
  address_street: string | null;
  address_number: string | null;
  address_complement: string | null;
  address_district: string | null;
  address_city: string | null;
  address_city_code: string | null;
  address_state: string | null;
};

/** Aba "Cadastro completo" do cliente: dados que a NF-e exige do destinatário. */
export type ClientDetails = FiscalAddress & {
  person_type: 'F' | 'J' | null;
  document: string | null;
  trade_name: string | null;
  state_registration: string | null;
  /** 1 contribuinte do ICMS, 2 isento, 9 não contribuinte. */
  ie_indicator: 1 | 2 | 9 | null;
  final_consumer: boolean;
  email: string | null;
  phone: string | null;
};

export type Client = {
  id: number;
  name: string;
  whatsapp: string;
  created_at: string;
  /** Ausente nos avisos de WhatsApp duplicado, que só trazem o básico. */
  details?: ClientDetails;
};

/** Aba "Fiscal" do produto. */
export type ProductFiscal = {
  gtin: string | null;
  ncm: string | null;
  cest: string | null;
  cfop: string | null;
  tax_origin: number;
  /** CSOSN (Simples Nacional) ou CST (regime normal). */
  icms_cst: string | null;
  icms_rate: number | null;
  icms_base_reduction: number | null;
  pis_cst: string | null;
  pis_rate: number | null;
  cofins_cst: string | null;
  cofins_rate: number | null;
  ibscbs_cst: string | null;
  ibscbs_class: string | null;
  tax_benefit_code: string | null;
  fiscal_notes: string | null;
};

export type Product = {
  id: number;
  code: string | null;
  name: string;
  unit: string;
  price: number;
  active: boolean;
  created_at: string;
  fiscal: ProductFiscal;
};

export type PaymentMethod = {
  id: number;
  name: string;
  active: boolean;
  /** Pedidos e orçamentos que usam esta forma. Com algum, ela só pode ser desativada. */
  orders_count: number;
  created_at: string;
};

export type OrderStatus = 'quote' | 'order';

export type DiscountType = 'percent' | 'amount';

export type OrderSummary = {
  id: number;
  status: OrderStatus;
  total_amount: number;
  created_at: string;
  confirmed_at: string | null;
  sent_at: string | null;
  store_id: number;
  store_name: string;
  user_id: number;
  user_name: string;
  client_id: number;
  client_name: string;
};

export type OrderItem = {
  id: number;
  position: number;
  product_id: number;
  product_code: string | null;
  product_name: string;
  unit: string;
  quantity: number;
  unit_price: number;
  subtotal: number;
};

export type Order = {
  id: number;
  user_id: number;
  store_id: number;
  client_id: number;
  status: OrderStatus;
  /** Soma dos itens. */
  subtotal_amount: number;
  discount_type: DiscountType | null;
  /** Percentual (10 = 10%) ou valor em reais, conforme discount_type. */
  discount_value: number | null;
  /** Desconto em reais, calculado no servidor. */
  discount_amount: number;
  /** Valor final, já com desconto. */
  total_amount: number;
  notes: string | null;
  delivery_address: string | null;
  payment_method_id: number | null;
  /** Nome da forma de pagamento quando o pedido foi salvo. */
  payment_method_name: string | null;
  confirmed_at: string | null;
  sent_at: string | null;
  created_at: string;
  updated_at: string;
  client_name: string;
  client_whatsapp: string;
  store_name: string;
  store_address: string | null;
  store_phone: string | null;
  user_name: string;
  items: OrderItem[];
};

export type Paginated<T> = {
  items: T[];
  total: number;
  page: number;
  page_size: number;
};

export type Settings = {
  evolution_api_url: string | null;
  evolution_instance: string | null;
  has_token: boolean;
  token_hint: string | null;
  updated_at: string;
  /** O servidor tem a EvolutionAPI da plataforma: a loja conecta lendo o QR Code. */
  auto_connect_available: boolean;
  /** Instância criada pela conexão automática (e não preenchida à mão). */
  managed: boolean;
};

export type WhatsAppQrCode = {
  state: 'open' | 'connecting';
  qrcode: string | null;
  pairing_code: string | null;
};

export type Tenant = {
  id: number;
  slug: string;
  name: string;
  active: boolean;
  created_at: string;
  stores_count: number;
  users_count: number;
  /** Domínios próprios: quem entra por eles não informa a lojamestre no login. */
  domains: string[];
};

export type SuperAdmin = {
  id: number;
  email: string;
  active: boolean;
};

export type Dashboard = {
  summary: {
    orders_today: number;
    orders_today_amount: number;
    quotes_today: number;
    open_quotes: number;
    open_quotes_amount: number;
  };
  recent: Pick<
    OrderSummary,
    'id' | 'status' | 'total_amount' | 'created_at' | 'sent_at' | 'client_name' | 'store_name' | 'user_name'
  >[];
  by_store: { id: number; name: string; orders_today: number; orders_today_amount: number; quotes_today: number }[];
};

export type ReportType = 'dias' | 'lojas' | 'vendedores' | 'produtos' | 'clientes' | 'formas-de-pagamento';

export type ReportTotals = { count: number; total_amount: number; discount_amount: number; average_amount: number };

export type ReportRow = {
  id?: number;
  name?: string;
  day?: string;
  store_name?: string | null;
  whatsapp?: string;
  last_date?: string;
  code?: string | null;
  unit?: string;
  quantity?: number;
  count: number;
  total_amount: number;
  discount_amount?: number;
  average_amount?: number;
};

export type Report = { rows: ReportRow[]; totals: ReportTotals };

export type FiscalEnvironment = 'homologacao' | 'producao';

/** Configurações → Fiscal: dados da empresa emitente. Segredos chegam só com a dica do final. */
export type FiscalSettings = FiscalAddress & {
  environment: FiscalEnvironment;
  acbr_client_id: string | null;
  acbr_client_secret_hint: string | null;
  /** A lojamestre já informou a conta dela na ACBr API (cada uma tem a sua). */
  acbr_configured: boolean;
  cnpj: string | null;
  legal_name: string | null;
  trade_name: string | null;
  state_registration: string | null;
  municipal_registration: string | null;
  cnae: string | null;
  tax_regime: 1 | 2 | 3 | 4 | null;
  email: string | null;
  phone: string | null;
  operation_nature: string;
  additional_info: string | null;
  nfe_series: number;
  nfe_next_number: number;
  nfce_series: number;
  nfce_next_number: number;
  nfce_csc_id: string | null;
  nfce_csc_hint: string | null;
  has_nfce_csc: boolean;
  ibs_uf_rate: number;
  ibs_mun_rate: number;
  cbs_rate: number;
  inbound_auto_distribution: boolean;
  inbound_auto_acknowledge: boolean;
  inbound_last_nsu: number;
  inbound_synced_at: string | null;
  certificate_subject: string | null;
  certificate_valid_until: string | null;
  certificate_uploaded_at: string | null;
  company_synced_at: string | null;
  updated_at: string | null;
};

export type FiscalModel = 55 | 65;

export type FiscalDocumentStatus = 'pendente' | 'autorizado' | 'rejeitado' | 'denegado' | 'cancelado' | 'erro' | 'inutilizado';

export type FiscalDocument = {
  id: number;
  store_id: number;
  store_name: string;
  order_id: number;
  user_id: number;
  user_name: string;
  client_id: number;
  client_name: string;
  model: FiscalModel;
  environment: FiscalEnvironment;
  series: number;
  number: number;
  status: FiscalDocumentStatus;
  attempts: number;
  access_key: string | null;
  protocol: string | null;
  status_code: number | null;
  status_message: string | null;
  total_amount: number;
  recipient_name: string | null;
  recipient_document: string | null;
  issued_at: string | null;
  authorized_at: string | null;
  cancelled_at: string | null;
  cancel_reason: string | null;
  created_at: string;
  updated_at: string;
  /** DANFE e XML disponíveis (nota autorizada ou cancelada). */
  has_files: boolean;
};

export type ManifestationCode = '210200' | '210210' | '210220' | '210240';

export type InboundDocument = {
  id: number;
  environment: FiscalEnvironment;
  access_key: string;
  nsu: number | null;
  /** Só o resumo chegou: a nota completa vem depois da ciência. */
  summary: boolean;
  issuer_document: string | null;
  issuer_name: string | null;
  issuer_state_registration: string | null;
  nfe_type: number | null;
  amount: number | null;
  protocol: string | null;
  issued_at: string | null;
  authorized_at: string | null;
  cancelled: boolean;
  manifestation: ManifestationCode | null;
  manifestation_status: string | null;
  manifestation_message: string | null;
  manifested_at: string | null;
  created_at: string;
};

export type InboundListMeta = {
  environment: FiscalEnvironment;
  configured: boolean;
  synced_at: string | null;
  last_nsu: number;
  auto_distribution: boolean;
  auto_acknowledge: boolean;
  pending_count: number;
};
