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
};

export type PaymentMethod = {
  id: number;
  name: string;
  active: boolean;
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
