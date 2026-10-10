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
};

export type ManagedUser = User & {
  active: boolean;
  created_at: string;
  /** Setores do fluxo do pedido: só quem é do setor tira o pedido das etapas dele. */
  sector_ids: number[];
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

export type Client = {
  id: number;
  name: string;
  whatsapp: string;
  created_at: string;
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

export type Product = {
  id: number;
  code: string | null;
  name: string;
  unit: string;
  price: number;
  active: boolean;
  created_at: string;
  track_stock?: boolean;
  /** Saldo na loja pedida na busca (stock_store_id); nulo se o produto não controla estoque. */
  stock?: number | null;
};

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

export type StockMovementKind = 'entry' | 'sale' | 'sale_cancel' | 'adjustment' | 'transfer_out' | 'transfer_in';

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
};

export type PaymentKind = 'cash' | 'pix' | 'card' | 'boleto' | 'store_credit' | 'other';

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
  expected_cash: number;
  difference: number | null;
};

export type CashView = {
  session: CashSession;
  summary: CashSummary;
  payments: ReceivablePayment[];
  movements: { id: number; kind: 'withdrawal' | 'deposit'; amount: number; reason: string; created_at: string; user_name: string }[];
};

export type ClientCredit = {
  credit_limit: number | null;
  open_balance: number;
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
