import { formatDateTime, formatDay, formatMoney, formatPercent, formatQuantity } from './format';

export type AuditArea = 'produtos' | 'estoque' | 'pedidos' | 'financeiro' | 'fiscal' | 'clientes' | 'usuarios' | 'configuracoes' | 'acesso';

export type AuditItem = {
  id: number;
  created_at: string;
  user_id: number | null;
  user_name: string | null;
  area: AuditArea;
  entity: string;
  entity_id: number | null;
  label: string | null;
  action: string;
  store_id: number | null;
  store_name: string | null;
  changes: Record<string, [unknown, unknown]> | null;
  note: string | null;
  ip: string | null;
};

export const AREA_LABEL: Record<AuditArea, string> = {
  produtos: 'Produtos e preços',
  estoque: 'Estoque',
  pedidos: 'Pedidos',
  financeiro: 'Financeiro',
  fiscal: 'Notas fiscais',
  clientes: 'Clientes',
  usuarios: 'Usuários',
  configuracoes: 'Configurações',
  acesso: 'Acesso',
};

const ENTITY_NAME: Record<string, string> = {
  products: 'o produto',
  product_price_tiers: 'a faixa de preço',
  price_lists: 'a tabela de preço',
  price_list_items: 'o preço na tabela',
  clients: 'o cliente',
  users: 'o usuário',
  stores: 'a loja',
  payment_methods: 'a forma de pagamento',
  settings: 'as configurações',
  fiscal_settings: 'a configuração fiscal',
  payables: 'a conta a pagar',
  receivables: 'a parcela',
  fiado_entries: 'o lançamento do fiado',
};

const SPECIAL: Record<string, string> = {
  'orders:cancel': 'Cancelou',
  'orders:delete': 'Excluiu',
  'orders:discount': 'Liberou desconto acima do limite',
  'orders:update': 'Alterou o pedido confirmado',
  'stock_movements:adjust': 'Ajustou o estoque',
  'stock_movements:transfer': 'Transferiu estoque',
  'receivables:update': 'Renegociou a parcela',
  'receivable_payments:reverse': 'Estornou o recebimento',
  'payable_payments:reverse': 'Estornou o pagamento',
  'fiado_entries:cancel': 'Estornou o lançamento do fiado',
  'fiscal_documents:cancel': 'Cancelou a nota',
  'fiscal_documents:void': 'Inutilizou a numeração',
  'users:login': 'Entrou no sistema',
  'users:login_failed': 'Tentou entrar e foi recusado',
  'price_list_items:create': 'Incluiu na tabela de preço',
  'price_list_items:delete': 'Tirou da tabela de preço',
  'settings:update': 'Alterou as configurações',
  'fiscal_settings:create': 'Preencheu a configuração fiscal',
  'fiscal_settings:update': 'Alterou a configuração fiscal',
};

const CASH_KIND: Record<string, string> = { withdrawal: 'Fez sangria no caixa', deposit: 'Fez suprimento no caixa', refund: 'Devolveu dinheiro pelo caixa' };

/** "Alterou o produto", "Cancelou", "Ajustou o estoque"… */
export function actionText(item: AuditItem) {
  if (item.entity === 'cash_movements') return CASH_KIND[String(item.changes?.kind?.[1])] ?? 'Movimentou o caixa';
  const special = SPECIAL[`${item.entity}:${item.action}`];
  if (special) return special;
  const verb = { create: 'Criou', update: 'Alterou', delete: 'Excluiu', cancel: 'Cancelou', reverse: 'Estornou' }[item.action] ?? 'Alterou';
  const name = ENTITY_NAME[item.entity];
  return name ? `${verb} ${name}` : verb;
}

const FIELD_LABEL: Record<string, string> = {
  name: 'Nome',
  code: 'Código',
  unit: 'Unidade',
  price: 'Preço',
  cost_price: 'Custo',
  unit_cost: 'Custo',
  active: 'Ativo',
  track_stock: 'Controla estoque',
  gtin: 'Código de barras',
  ncm: 'NCM',
  cest: 'CEST',
  cfop: 'CFOP',
  tax_origin: 'Origem',
  icms_cst: 'CST do ICMS',
  icms_rate: 'Alíquota do ICMS',
  icms_base_reduction: 'Redução da base do ICMS',
  pis_cst: 'CST do PIS',
  pis_rate: 'Alíquota do PIS',
  cofins_cst: 'CST da COFINS',
  cofins_rate: 'Alíquota da COFINS',
  ibscbs_cst: 'CST do IBS/CBS',
  ibscbs_class: 'Classificação do IBS/CBS',
  tax_benefit_code: 'Benefício fiscal',
  fiscal_notes: 'Observação fiscal',
  markup_percent: 'Margem',
  purchase_unit: 'Unidade de compra',
  purchase_factor: 'Quantidade na unidade de compra',
  min_quantity: 'A partir de',
  product_id: 'Produto',
  price_list_id: 'Tabela de preço',
  adjust_percent: 'Ajuste da tabela',
  credit_limit: 'Limite de crédito',
  fiado_due_day: 'Vencimento do fiado',
  username: 'Usuário',
  email: 'E-mail',
  password_hash: 'Senha',
  role: 'Perfil',
  store_id: 'Loja',
  max_discount_percent: 'Desconto máximo',
  can_approve_discounts: 'Libera descontos',
  commission_percent: 'Comissão',
  address: 'Endereço',
  phone: 'Telefone',
  logo_mime: 'Logo',
  kind: 'Tipo',
  installments: 'Parcelas',
  first_due_days: 'Primeiro vencimento (dias)',
  interval_days: 'Intervalo (dias)',
  evolution_api_url: 'Servidor do WhatsApp',
  evolution_instance: 'Instância do WhatsApp',
  evolution_api_token: 'Chave do WhatsApp',
  finance_enabled: 'Financeiro ligado',
  pix_key: 'Chave PIX',
  pix_merchant_name: 'Nome no PIX',
  pix_city: 'Cidade no PIX',
  followup_days: 'Retomada de orçamento (dias)',
  followup_message: 'Mensagem de retomada',
  default_markup_percent: 'Margem padrão',
  fiado_enabled: 'Fiado ligado',
  fiado_block_days: 'Bloqueio do fiado (dias)',
  fiado_late_fee_percent: 'Multa do fiado',
  fiado_interest_percent: 'Juros do fiado',
  fiado_message: 'Mensagem do fiado',
  delivery_requires_invoice: 'Entrega exige nota',
  default_commission_percent: 'Comissão padrão',
  routines_enabled: 'Rotinas ligadas',
  count_items: 'Itens por contagem',
  environment: 'Ambiente',
  acbr_client_id: 'Conta da ACBr (client_id)',
  acbr_client_secret: 'Segredo da conta da ACBr',
  cnpj: 'CNPJ',
  legal_name: 'Razão social',
  trade_name: 'Nome fantasia',
  state_registration: 'Inscrição estadual',
  municipal_registration: 'Inscrição municipal',
  cnae: 'CNAE',
  tax_regime: 'Regime tributário',
  address_zip: 'CEP',
  address_street: 'Rua',
  address_number: 'Número',
  address_complement: 'Complemento',
  address_district: 'Bairro',
  address_city: 'Cidade',
  address_city_code: 'Código da cidade',
  address_state: 'UF',
  operation_nature: 'Natureza da operação',
  additional_info: 'Informações adicionais',
  nfe_series: 'Série da NF-e',
  nfce_series: 'Série da NFC-e',
  nfce_csc_id: 'Identificador do CSC',
  nfce_csc: 'CSC da NFC-e',
  ibs_uf_rate: 'IBS estadual',
  ibs_mun_rate: 'IBS municipal',
  cbs_rate: 'CBS',
  inbound_auto_distribution: 'Busca automática de notas recebidas',
  inbound_auto_acknowledge: 'Ciência automática',
  certificate_subject: 'Certificado',
  certificate_valid_until: 'Validade do certificado',
  status: 'Situação',
  total_amount: 'Total',
  cancel_reason: 'Motivo',
  reverse_reason: 'Motivo',
  reason: 'Motivo',
  client_id: 'Cliente',
  discount_type: 'Desconto em',
  discount_value: 'Desconto',
  discount_amount: 'Valor do desconto',
  discount_approved_by: 'Liberado por',
  discount_approved_percent: 'Desconto liberado',
  payment_method_name: 'Forma de pagamento',
  price_list_name: 'Tabela de preço',
  quantity: 'Quantidade',
  balance_after: 'Saldo depois',
  other_store_id: 'Para a loja',
  due_date: 'Vencimento',
  amount: 'Valor',
  description: 'Descrição',
  supplier_id: 'Fornecedor',
  category: 'Categoria',
  document_number: 'Documento',
  cancelled_at: 'Cancelado em',
  person_type: 'Tipo de pessoa',
  document: 'CPF/CNPJ',
};

const MONEY = new Set(['price', 'cost_price', 'unit_cost', 'total_amount', 'discount_amount', 'amount', 'credit_limit']);
const DAYS = new Set(['due_date', 'certificate_valid_until']);
const ENUMS: Record<string, Record<string, string>> = {
  status: { quote: 'Orçamento', order: 'Pedido', cancelled: 'Cancelado', cancelado: 'Cancelada', inutilizado: 'Inutilizada' },
  role: { admin: 'Administrador', seller: 'Vendedor' },
  discount_type: { percent: '%', amount: 'R$' },
  environment: { homologacao: 'Homologação', producao: 'Produção' },
  kind: {
    withdrawal: 'Sangria',
    deposit: 'Suprimento',
    refund: 'Devolução',
    cash: 'Dinheiro',
    pix: 'PIX',
    card: 'Cartão',
    boleto: 'Boleto',
    store_credit: 'Crediário',
    fiado: 'Fiado',
    other: 'Outro',
  },
};

export const fieldLabel = (key: string) => FIELD_LABEL[key] ?? key.replaceAll('_', ' ');

/** Valor como a loja lê: dinheiro, percentual, sim/não, data. */
export function formatValue(key: string, value: unknown): string {
  if (value === null || value === undefined || value === '') return 'vazio';
  if (typeof value === 'boolean') return value ? 'Sim' : 'Não';
  if (typeof value === 'number') {
    if (MONEY.has(key)) return formatMoney(value);
    if (key.endsWith('_percent') || key.endsWith('_rate')) return formatPercent(value);
    return formatQuantity(value);
  }
  if (typeof value === 'string') {
    if (ENUMS[key]?.[value]) return ENUMS[key][value]!;
    if (DAYS.has(key) && /^\d{4}-\d{2}-\d{2}/.test(value)) return formatDay(value.slice(0, 10));
    if (/^\d{4}-\d{2}-\d{2}T/.test(value)) return formatDateTime(value);
    return value;
  }
  return JSON.stringify(value);
}

/** Uma linha por campo: "Preço: R$ 38,90 → R$ 41,50"; senhas só dizem o que aconteceu. */
export function changeLines(item: AuditItem) {
  return Object.entries(item.changes ?? {})
    .filter(([key]) => !(item.entity === 'cash_movements' && key === 'kind'))
    .map(([key, [before, after]]) => {
      const label = fieldLabel(key);
      if (before === '•••' || after === '•••') {
        return { label, text: before === null ? 'informada' : after === null ? 'removida' : 'alterada' };
      }
      if (before === null || before === undefined) return { label, text: formatValue(key, after) };
      if (after === null || after === undefined) return { label, text: item.action === 'delete' ? formatValue(key, before) : `${formatValue(key, before)} → vazio` };
      return { label, text: `${formatValue(key, before)} → ${formatValue(key, after)}` };
    });
}
