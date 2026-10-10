export type Role = 'admin' | 'seller';

export type User = {
  id: number;
  name: string;
  username: string;
  email: string | null;
  role: Role;
  store_id: number | null;
  store_name: string | null;
  /** Financeiro (contas a receber e caixa) ligado na lojamestre. */
  finance_enabled?: boolean;
  /** Desconto máximo de quem vende, em %. Nulo = sem limite. */
  max_discount_percent?: number | null;
  /** Fiado (caderneta) ligado na lojamestre. */
  fiado_enabled?: boolean;
};

export type ManagedUser = User & {
  active: boolean;
  created_at: string;
  /** Setores do fluxo do pedido: só quem é do setor tira o pedido das etapas dele. */
  sector_ids: number[];
  /** Desconto máximo próprio (nulo = o padrão da loja). */
  max_discount_percent: number | null;
  /** Libera, com a própria senha, desconto acima do limite de quem vende. */
  can_approve_discounts: boolean;
};

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
  /** Com quem falar (vai no "Olá" das mensagens). Ausente nos avisos de WhatsApp duplicado. */
  contact_name?: string | null;
  /** Tabela de preço do cliente (o admin escolhe). */
  price_list_id?: number | null;
  price_list_name?: string | null;
  /** Ausente nos avisos de WhatsApp duplicado, que só trazem o básico. */
  details?: ClientDetails;
  /** Limite do crediário. Nulo: o cliente não compra no crediário. */
  credit_limit?: number | null;
  /** Obras ativas do cliente (só na listagem). */
  sites_count?: number;
};

/** Obra (endereço de entrega) do cliente. */
export type ClientSite = {
  id: number;
  client_id: number;
  name: string;
  address: string;
  contact_name: string | null;
  /** Só dígitos, com DDI, como o WhatsApp do cliente. */
  contact_phone: string | null;
  notes: string | null;
  active: boolean;
  orders_count: number;
  created_at: string;
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
  /** Unidade em que a loja compra (SC) e quantas unidades de venda vêm em cada uma (50 KG). */
  purchase_unit?: string | null;
  purchase_factor?: number | null;
  track_stock?: boolean;
  /** Saldo na loja pedida na busca (stock_store_id); nulo se o produto não controla estoque. */
  stock?: number | null;
  /** Preço na tabela do cliente pedido na busca (client_id); nulo sem tabela. */
  client_price?: number | null;
  /** Faixas por quantidade (a partir de min_quantity, sai por price). */
  tiers?: PriceTier[] | null;
};

export type PriceTier = { min_quantity: number; price: number };

export type StockItem = {
  id: number;
  code: string | null;
  name: string;
  unit: string;
  price: number;
  cost_price: number | null;
  track_stock: boolean;
  quantity: number;
  min_quantity: number | null;
  /** Vendido e ainda não entregue: continua na prateleira. */
  to_deliver: number;
};

export type StockList = Paginated<StockItem> & {
  store_id: number;
  summary: { below_min: number; negative: number };
};

export type StockMovementKind = 'entry' | 'sale' | 'sale_cancel' | 'adjustment' | 'transfer_out' | 'transfer_in' | 'return';

export type StockMovement = {
  id: number;
  kind: StockMovementKind;
  quantity: number;
  balance_after: number;
  unit_cost: number | null;
  order_id: number | null;
  entry_id: number | null;
  note: string | null;
  created_at: string;
  user_name: string;
  other_store_name: string | null;
  supplier_name: string | null;
  invoice_number: string | null;
};

export type ProductStock = {
  store_id: number;
  product: Pick<StockItem, 'id' | 'code' | 'name' | 'unit' | 'price' | 'cost_price' | 'track_stock'>;
  balances: { store_id: number; store_name: string; quantity: number; min_quantity: number | null }[];
  movements: StockMovement[];
};

export type StockEntry = {
  id: number;
  store_id: number;
  store_name: string;
  supplier_name: string | null;
  supplier_document: string | null;
  invoice_number: string | null;
  invoice_series: string | null;
  access_key: string | null;
  issued_at: string | null;
  total_amount: number;
  created_at: string;
  user_name: string;
  items_count: number;
  purchase_order_id: number | null;
};

export type PaymentKind = 'cash' | 'pix' | 'card' | 'boleto' | 'store_credit' | 'fiado' | 'other';

export type PaymentMethod = {
  id: number;
  name: string;
  active: boolean;
  kind: PaymentKind;
  installments: number;
  /** Dias da venda até a 1ª parcela (0 = no dia). */
  first_due_days: number;
  interval_days: number;
  /** Pedidos e orçamentos que usam esta forma. Com algum, ela só pode ser desativada. */
  orders_count: number;
  created_at: string;
};

export type OrderStatus = 'quote' | 'order' | 'cancelled';

/** O que o documento cancelado era: orçamento perdido ou pedido cancelado. */
export type CancelledFrom = 'quote' | 'order' | null;

export type DiscountType = 'percent' | 'amount';

export type OrderSummary = {
  id: number;
  status: OrderStatus;
  cancelled_from: CancelledFrom;
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
  /** Etapa do fluxo. Nula em orçamentos e em pedidos sem fluxo. */
  stage_id: number | null;
  stage_name: string | null;
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
  /** Obra do cliente escolhida no PDV. */
  client_site_id: number | null;
  client_site_name: string | null;
  payment_method_id: number | null;
  /** Nome da forma de pagamento quando o pedido foi salvo. */
  payment_method_name: string | null;
  confirmed_at: string | null;
  /** Pedido com saldo a entregar (confirmado depois do controle de entregas). */
  delivery_tracking: boolean;
  sent_at: string | null;
  created_at: string;
  updated_at: string;
  cancelled_from: CancelledFrom;
  cancelled_at: string | null;
  cancelled_by_name: string | null;
  cancel_reason: string | null;
  client_name: string;
  /** Tabela de preço do cliente usada no pedido. */
  price_list_name?: string | null;
  /** Desconto acima do limite: quem liberou e até quanto. */
  discount_approved_by_name?: string | null;
  discount_approved_percent?: number | null;
  payment_method_kind?: PaymentKind | null;
  /** Parte do total paga com o crédito do cliente (vale-troca). */
  credit_used?: number;
  client_whatsapp: string;
  store_name: string;
  store_address: string | null;
  store_phone: string | null;
  user_name: string;
  items: OrderItem[];
  /** Andamento no fluxo. Nulo em orçamentos e em pedidos sem fluxo configurado. */
  workflow: OrderWorkflow | null;
};

export type DeliveryType = 'pickup' | 'delivery';

export type Sector = {
  id: number;
  name: string;
  users_count: number;
  stages_count: number;
  created_at: string;
};

export type WorkflowStage = {
  id: number;
  position: number;
  name: string;
  sector_id: number | null;
  /** Tempo esperado na etapa; passou disso, o cartão fica vermelho no monitor. */
  sla_minutes: number | null;
  /** Mensagem de WhatsApp ao cliente quando o pedido avança para a etapa. */
  whatsapp_message: string | null;
  /** Pedidos nesta etapa agora. Com algum, ela não pode ser removida. */
  orders_count: number;
};

export type Workflow = {
  id: number;
  /** Nulo: modelo da lojamestre, usado pelas lojas sem fluxo próprio. */
  store_id: number | null;
  delivery_type: DeliveryType;
  updated_at: string;
  stages: WorkflowStage[];
};

export type StageRef = { id: number; name: string };

export type StageEvent = {
  id: number;
  from_stage_name: string | null;
  to_stage_name: string;
  user_name: string;
  note: string | null;
  created_at: string;
};

export type OrderWorkflow = {
  stage_id: number;
  stage_name: string;
  sector_id: number | null;
  sector_name: string | null;
  sla_minutes: number | null;
  entered_at: string;
  is_final: boolean;
  next_stage: StageRef | null;
  previous_stage: StageRef | null;
  can_move: boolean;
  events: StageEvent[];
};

export type StageNotification = { status: 'sent' } | { status: 'failed'; error: string };

export type MonitorOrder = {
  id: number;
  store_id: number;
  store_name: string;
  client_name: string;
  user_name: string;
  total_amount: number;
  delivery_address: string | null;
  notes: string | null;
  confirmed_at: string | null;
  stage_id: number;
  stage_name: string;
  sector_id: number | null;
  sla_minutes: number | null;
  stage_entered_at: string;
  next_stage_name: string;
  items_count: number;
  column: string;
  delivery_type: DeliveryType;
  can_move: boolean;
};

export type Monitor = {
  /** Hora do servidor: o tempo na etapa não depende do relógio da TV. */
  now: string;
  my_sector_ids: number[];
  columns: { key: string; name: string }[];
  orders: MonitorOrder[];
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
    /** Orçamentos para retomar hoje (do vendedor; da rede para o admin). */
    followups_due: number;
  };
  recent: Pick<
    OrderSummary,
    'id' | 'status' | 'cancelled_from' | 'total_amount' | 'created_at' | 'sent_at' | 'client_name' | 'store_name' | 'user_name'
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

export type DeliveryKind = 'pickup' | 'delivery';
export type DeliveryStatus = 'scheduled' | 'in_route' | 'done' | 'cancelled';
export type DeliveryPeriod = 'morning' | 'afternoon';

export type FulfillmentLine = {
  order_item_id: number;
  product_id: number;
  product_code: string | null;
  product_name: string;
  unit: string;
  quantity: number;
  delivered: number;
  scheduled: number;
  pending: number;
};

export type DeliveryItem = {
  order_item_id: number;
  product_id: number;
  product_code: string | null;
  product_name: string;
  unit: string;
  quantity: number;
};

export type Delivery = {
  id: number;
  order_id: number;
  store_id: number;
  store_name: string;
  kind: DeliveryKind;
  status: DeliveryStatus;
  /** "2026-10-20" */
  scheduled_date: string | null;
  period: DeliveryPeriod | null;
  address: string | null;
  route_id: number | null;
  route_position: number | null;
  receiver_name: string | null;
  receiver_document: string | null;
  notes: string | null;
  cancel_reason: string | null;
  created_at: string;
  completed_at: string | null;
  cancelled_at: string | null;
  has_signature: boolean;
  has_photo: boolean;
  client_name: string;
  client_whatsapp: string;
  created_by_name: string;
  completed_by_name: string | null;
  items: DeliveryItem[];
  order_notes?: string | null;
};

export type OrderDeliveries = { tracking: boolean; items: FulfillmentLine[]; deliveries: Delivery[] };

export type DeliveryRoute = {
  id: number;
  store_id: number;
  store_name: string;
  route_date: string;
  vehicle_id: number | null;
  vehicle_name: string | null;
  vehicle_plate: string | null;
  driver_name: string | null;
  status: 'open' | 'in_route' | 'done';
  notes: string | null;
  created_at: string;
  departed_at: string | null;
  finished_at: string | null;
};

export type Vehicle = { id: number; name: string; plate: string | null; active: boolean; created_at: string };

export type ReceivableStatus = 'open' | 'paid' | 'cancelled';

export type Receivable = {
  id: number;
  store_id: number;
  store_name: string;
  order_id: number | null;
  client_id: number;
  client_name: string;
  client_whatsapp: string;
  installment: number;
  installments: number;
  /** "2026-11-09" */
  due_date: string;
  amount: number;
  paid_amount: number;
  remaining: number;
  status: ReceivableStatus;
  payment_method_id: number | null;
  payment_method_name: string | null;
  kind: PaymentKind;
  overdue: boolean;
  created_at: string;
  paid_at: string | null;
  cancelled_at: string | null;
  cancel_reason: string | null;
};

export type ReceivablePayment = {
  /** No movimento do caixa: parcela do financeiro ou recebimento do fiado. */
  source?: 'receivable' | 'fiado';
  id: number;
  receivable_id: number;
  method_name: string;
  amount: number;
  received_at: string;
  reversed_at: string | null;
  reverse_reason: string | null;
  user_name?: string;
  session_open?: boolean;
  order_id?: number | null;
  installment?: number;
  installments?: number;
  client_name?: string;
  kind?: PaymentKind;
};

export type CashSession = {
  id: number;
  store_id: number;
  store_name: string;
  user_id: number;
  user_name: string;
  opened_at: string;
  opening_amount: number;
  closed_at: string | null;
  counted_amount: number | null;
  closing_notes: string | null;
};

export type CashSummary = {
  methods: { method_name: string; kind: PaymentKind; amount: number; count: number }[];
  received: number;
  withdrawals: number;
  deposits: number;
  /** Devoluções em dinheiro. */
  refunds: number;
  /** Contas pagas com o dinheiro da gaveta. */
  payables: number;
  expected_cash: number;
  difference: number | null;
};

export type CashView = {
  session: CashSession;
  summary: CashSummary;
  payments: ReceivablePayment[];
  movements: {
    id: number;
    kind: 'withdrawal' | 'deposit' | 'refund' | 'payable';
    amount: number;
    reason: string;
    created_at: string;
    user_name: string;
    payable_id: number | null;
  }[];
};

export type ClientCredit = {
  credit_limit: number | null;
  open_balance: number;
  /** Saldo do fiado (o limite vale para crediário e fiado juntos). */
  fiado_balance?: number;
  overdue_amount: number;
  oldest_overdue: string | null;
  available: number | null;
};

export type FinanceSettings = {
  finance_enabled: boolean;
  pix_key: string | null;
  pix_merchant_name: string | null;
  pix_city: string | null;
};

export type FollowupChannel = 'whatsapp' | 'call' | 'visit' | 'other';

/** Orçamento na lista de retomada. */
export type FollowupItem = {
  id: number;
  total_amount: number;
  created_at: string;
  sent_at: string | null;
  followup_count: number;
  /** Dia combinado com o cliente, se houver. */
  followup_on: string | null;
  last_contact_at: string;
  /** Dia da retomada (combinado ou calculado). */
  due_on: string;
  /** Dias de atraso; negativo nos próximos. */
  days_late: number;
  store_id: number;
  store_name: string;
  user_id: number;
  user_name: string;
  client_id: number;
  client_name: string;
  client_whatsapp: string;
  last_channel: FollowupChannel | null;
  last_note: string | null;
};

/** Um contato registrado na retomada. */
export type Followup = {
  id: number;
  channel: FollowupChannel;
  note: string | null;
  message: string | null;
  with_pdf: boolean;
  next_on: string | null;
  created_at: string;
  user_id: number;
  user_name: string;
};

export type FollowupHistory = {
  status: OrderStatus;
  followup_count: number;
  followup_on: string | null;
  last_contact_at: string;
  due_on: string;
  /** Dias depois do último contato, da configuração. */
  days: number;
  /** Mensagem sugerida para o WhatsApp, já com o nome do cliente e o total. */
  message: string;
  items: Followup[];
};

export type FollowupSettings = {
  followup_days: number;
  followup_message: string | null;
  default_message: string;
};

export type PriceSource = 'catalog' | 'list' | 'tier';

/** Preço que cada item vai ter ao salvar (POST /orders/price-preview). */
export type PricePreview = {
  price_list: { id: number; name: string } | null;
  discount_limit: number | null;
  items: {
    product_id: number;
    unit_price: number;
    catalog_price: number;
    source: PriceSource;
    next_tier: PriceTier | null;
    /** Item do orçamento que ficou com o preço da época. */
    kept_previous: boolean;
  }[];
};

export type PriceList = {
  id: number;
  name: string;
  adjust_percent: number;
  active: boolean;
  created_at: string;
  clients_count?: number;
  items_count?: number;
};

export type PriceListItem = { product_id: number; code: string | null; name: string; unit: string; catalog_price: number; price: number };

export type ProductPricing = {
  id: number;
  price: number;
  cost_price: number | null;
  markup_percent: number | null;
  default_markup_percent: number | null;
  tiers: PriceTier[];
  history: { old_price: number; new_price: number; reason: string | null; created_at: string; user_name: string | null }[];
};

export type PriceAdjustResult = {
  items: { id: number; code: string | null; name: string; unit: string; cost_price: number | null; old_price: number; new_price: number }[];
  count: number;
  skipped: number;
  applied: boolean;
};

export type SalesSettings = { max_discount_percent: number | null; default_markup_percent: number | null };

export type FiadoSettings = {
  enabled: boolean;
  due_day: number;
  block_days: number;
  late_fee_percent: number;
  interest_percent: number;
  message: string | null;
  default_message: string;
};

/** Cliente na lista do fiado. */
export type FiadoAccountRow = {
  client_id: number;
  client_name: string;
  client_whatsapp: string;
  credit_limit: number | null;
  balance: number;
  overdue: number;
  oldest_overdue: string | null;
  next_due: string | null;
  days_late: number;
  last_payment_at: string | null;
};

export type FiadoEntryKind = 'purchase' | 'charge' | 'payment' | 'refund' | 'adjustment';

export type FiadoEntry = {
  id: number;
  kind: FiadoEntryKind;
  /** Com sinal: débito positivo, crédito negativo. */
  amount: number;
  due_date: string | null;
  description: string | null;
  order_id: number | null;
  payment_method_name: string | null;
  cash_session_id: number | null;
  created_at: string;
  user_name: string;
  cancelled_at: string | null;
  cancel_reason: string | null;
  /** Saldo depois do lançamento; nulo nos cancelados. */
  balance_after: number | null;
};

export type FiadoAccount = {
  client: { id: number; name: string; whatsapp: string; credit_limit: number | null; fiado_due_day: number | null };
  account: {
    balance: number;
    overdue: number;
    oldest_overdue: string | null;
    days_late: number;
    next_due: string | null;
    next_due_amount: number;
    charges: number;
  };
  due_day: number;
  store_credit_open: number;
  available: number | null;
  blocked: boolean;
  entries: FiadoEntry[];
  message: string;
};

export type RefundMethod = 'cash' | 'pix' | 'card' | 'credit' | 'fiado' | 'receivables' | 'none';

export type ReturnableItem = {
  order_item_id: number;
  product_id: number;
  product_code: string | null;
  product_name: string;
  unit: string;
  sold: number;
  /** Levado pelo cliente (entregue/retirado); sem controle de entrega, o vendido. */
  taken: number;
  returned: number;
  returnable: number;
  /** Preço unitário com o desconto do pedido rateado. */
  net_price: number;
};

export type OrderReturn = {
  id: number;
  reason: string;
  refund_method: RefundMethod;
  amount: number;
  created_at: string;
  user_name: string;
  items: { product_name: string; unit: string; quantity: number; amount: number; restock: boolean }[];
};

export type OrderReturnsView = {
  status: OrderStatus;
  items: ReturnableItem[];
  returns: OrderReturn[];
  client_credit: number;
  options: { finance: boolean; cash_open: boolean; fiado: boolean; payment_kind: PaymentKind | null; open_receivables: number };
};

export type Supplier = {
  id: number;
  name: string;
  /** CNPJ ou CPF, só dígitos. */
  document: string | null;
  contact_name: string | null;
  whatsapp: string | null;
  email: string | null;
  notes: string | null;
  active: boolean;
  created_at: string;
  open_orders?: number;
  open_payables?: number;
  last_entry_at?: string | null;
};

export type PurchaseStatus = 'draft' | 'sent' | 'partial' | 'received' | 'cancelled';

export type PurchaseOrder = {
  id: number;
  store_id: number;
  store_name: string;
  supplier_id: number;
  supplier_name: string;
  supplier_document: string | null;
  status: PurchaseStatus;
  expected_date: string | null;
  notes: string | null;
  total_amount: number;
  created_at: string;
  sent_at: string | null;
  received_at: string | null;
  closed_short: boolean;
  cancelled_at: string | null;
  cancel_reason: string | null;
  user_name: string;
  items_count?: number;
};

export type PurchaseOrderItem = {
  id: number;
  product_id: number;
  code: string | null;
  product_name: string;
  unit: string;
  quantity: number;
  unit_cost: number | null;
  received_quantity: number;
  /** Pedido em unidade de compra (quantidade e custo acima continuam na unidade de venda). */
  purchase_unit: string | null;
  purchase_factor: number | null;
};

export type PurchaseOrderDetail = PurchaseOrder & {
  supplier: Supplier;
  items: PurchaseOrderItem[];
  entries: { id: number; invoice_number: string | null; invoice_series: string | null; total_amount: number; created_at: string; user_name: string }[];
  payables: PayableInstallment[];
  whatsapp_message: string;
};

export type PurchaseSuggestion = {
  product_id: number;
  code: string | null;
  name: string;
  unit: string;
  quantity: number;
  min_quantity: number;
  on_order: number;
  suggested: number;
  purchase_unit: string | null;
  purchase_factor: number | null;
  suggested_purchase: number | null;
  unit_cost: number | null;
  supplier_id: number | null;
  supplier_name: string | null;
};

export type PayableInstallment = {
  id: number;
  installment: number;
  installments: number;
  due_date: string;
  amount: number;
  paid_amount: number;
  status: 'open' | 'paid' | 'cancelled';
};

export type Payable = PayableInstallment & {
  store_id: number;
  store_name: string;
  supplier_id: number | null;
  supplier_name: string | null;
  description: string;
  category: string | null;
  document_number: string | null;
  remaining: number;
  entry_id: number | null;
  purchase_order_id: number | null;
  created_at: string;
  paid_at: string | null;
  cancelled_at: string | null;
  cancel_reason: string | null;
  overdue: boolean;
};

export type PayableMethod = 'cash' | 'bank' | 'pix' | 'boleto' | 'card' | 'other';

export type PayablePayment = {
  id: number;
  amount: number;
  paid_on: string;
  method: PayableMethod;
  note: string | null;
  created_at: string;
  reversed_at: string | null;
  reverse_reason: string | null;
  user_name: string;
  cash_session_id: number | null;
  session_closed: boolean;
};

export type PayablesSummary = { overdue: number; today: number; next_7_days: number; next_30_days: number; open_total: number };
