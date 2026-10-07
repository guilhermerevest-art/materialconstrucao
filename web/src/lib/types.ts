export type Role = 'admin' | 'seller';

export type User = {
  id: number;
  name: string;
  email: string;
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

export type OrderStatus = 'quote' | 'order';

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
  total_amount: number;
  notes: string | null;
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
