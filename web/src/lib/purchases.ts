import type { PayableMethod, PurchaseStatus } from './types';

/** "PC-00012": número do pedido de compra (o mesmo do PDF). */
export const purchaseNumber = (id: number) => `PC-${String(id).padStart(5, '0')}`;

export const PURCHASE_STATUS: Record<PurchaseStatus, { label: string; variant: 'neutral' | 'quote' | 'warning' | 'success' | 'danger' }> = {
  draft: { label: 'Rascunho', variant: 'neutral' },
  sent: { label: 'Enviado', variant: 'quote' },
  partial: { label: 'Recebido em parte', variant: 'warning' },
  received: { label: 'Recebido', variant: 'success' },
  cancelled: { label: 'Cancelado', variant: 'danger' },
};

export const PAYABLE_METHOD_LABEL: Record<PayableMethod, string> = {
  cash: 'Dinheiro do caixa',
  bank: 'Transferência / débito',
  pix: 'PIX',
  boleto: 'Boleto',
  card: 'Cartão',
  other: 'Outro',
};

export const PAYABLE_CATEGORIES = [
  'Fornecedor',
  'Frete',
  'Aluguel',
  'Energia',
  'Água',
  'Telefone e internet',
  'Salários',
  'Impostos',
  'Manutenção',
  'Outros',
];
