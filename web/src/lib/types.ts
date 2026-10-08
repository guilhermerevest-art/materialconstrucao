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

export type Client = {
  id: number;
  name: string;
  whatsapp: string;
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
