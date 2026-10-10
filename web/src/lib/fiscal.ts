import type { FiscalAddress, FiscalDocumentStatus, FiscalModel, ManifestationCode } from './types';

/** Mesmas tabelas que o servidor valida (server/src/fiscal/invoice.ts). */

export const UFS = [
  'AC', 'AL', 'AM', 'AP', 'BA', 'CE', 'DF', 'ES', 'GO', 'MA', 'MG', 'MS', 'MT', 'PA', 'PB', 'PE', 'PI', 'PR',
  'RJ', 'RN', 'RO', 'RR', 'RS', 'SC', 'SE', 'SP', 'TO',
];

export const TAX_REGIMES = [
  { value: 1, label: '1 - Simples Nacional' },
  { value: 2, label: '2 - Simples Nacional, excesso de sublimite' },
  { value: 3, label: '3 - Regime normal (Lucro Presumido ou Real)' },
  { value: 4, label: '4 - MEI' },
] as const;

export const isSimples = (regime: number | null | undefined) => regime === 1 || regime === 2 || regime === 4;

export const TAX_ORIGINS = [
  { value: 0, label: '0 - Nacional' },
  { value: 1, label: '1 - Estrangeira, importação direta' },
  { value: 2, label: '2 - Estrangeira, adquirida no mercado interno' },
  { value: 3, label: '3 - Nacional, conteúdo de importação acima de 40%' },
  { value: 4, label: '4 - Nacional, processos produtivos básicos' },
  { value: 5, label: '5 - Nacional, conteúdo de importação até 40%' },
  { value: 6, label: '6 - Estrangeira, importação direta sem similar (CAMEX)' },
  { value: 7, label: '7 - Estrangeira, mercado interno sem similar (CAMEX)' },
  { value: 8, label: '8 - Nacional, conteúdo de importação acima de 70%' },
];

export const SIMPLES_CSOSN = [
  { value: '101', label: '101 - Tributada com permissão de crédito' },
  { value: '102', label: '102 - Tributada sem permissão de crédito' },
  { value: '103', label: '103 - Isenção para faixa de receita bruta' },
  { value: '300', label: '300 - Imune' },
  { value: '400', label: '400 - Não tributada' },
  { value: '500', label: '500 - ICMS cobrado antes por substituição (ST)' },
  { value: '900', label: '900 - Outros' },
];

export const NORMAL_ICMS_CST = [
  { value: '00', label: '00 - Tributada integralmente' },
  { value: '20', label: '20 - Com redução de base de cálculo' },
  { value: '40', label: '40 - Isenta' },
  { value: '41', label: '41 - Não tributada' },
  { value: '50', label: '50 - Suspensão' },
  { value: '60', label: '60 - ICMS cobrado antes por substituição (ST)' },
];

export const PIS_COFINS_CST = [
  { value: '01', label: '01 - Tributável, alíquota básica' },
  { value: '02', label: '02 - Tributável, alíquota diferenciada' },
  { value: '04', label: '04 - Monofásica, revenda a alíquota zero' },
  { value: '05', label: '05 - Substituição tributária' },
  { value: '06', label: '06 - Alíquota zero' },
  { value: '07', label: '07 - Isenta' },
  { value: '08', label: '08 - Sem incidência' },
  { value: '09', label: '09 - Com suspensão' },
  { value: '49', label: '49 - Outras operações de saída' },
  { value: '99', label: '99 - Outras operações' },
];

export const IBSCBS_CST = [
  { value: '000', label: '000 - Tributação integral' },
  { value: '400', label: '400 - Isenção' },
  { value: '410', label: '410 - Imunidade e não incidência' },
];

export const IE_INDICATORS = [
  { value: 9, label: 'Não contribuinte do ICMS' },
  { value: 1, label: 'Contribuinte do ICMS (tem IE)' },
  { value: 2, label: 'Contribuinte isento de inscrição' },
] as const;

export const MANIFESTATIONS: Record<ManifestationCode, { label: string; short: string; description: string }> = {
  '210210': {
    label: 'Ciência da operação',
    short: 'Ciência',
    description: 'Você sabe da nota, mas ainda não conferiu a mercadoria. Libera o XML completo.',
  },
  '210200': {
    label: 'Confirmação da operação',
    short: 'Confirmada',
    description: 'A mercadoria chegou e confere com a nota.',
  },
  '210220': {
    label: 'Desconhecimento da operação',
    short: 'Desconhecida',
    description: 'A empresa não reconhece esta compra.',
  },
  '210240': {
    label: 'Operação não realizada',
    short: 'Não realizada',
    description: 'A compra existiu, mas não aconteceu (devolução, recusa na entrega...). Exige justificativa.',
  },
};

export const modelLabel = (model: FiscalModel) => (model === 55 ? 'NF-e' : 'NFC-e');

export const STATUS_LABELS: Record<FiscalDocumentStatus, { text: string; variant: 'success' | 'neutral' | 'danger' | 'quote' }> = {
  pendente: { text: 'Em processamento', variant: 'quote' },
  autorizado: { text: 'Autorizada', variant: 'success' },
  rejeitado: { text: 'Rejeitada', variant: 'danger' },
  denegado: { text: 'Denegada', variant: 'danger' },
  cancelado: { text: 'Cancelada', variant: 'neutral' },
  erro: { text: 'Erro no envio', variant: 'danger' },
  inutilizado: { text: 'Número inutilizado', variant: 'neutral' },
};

const digits = (value: string) => value.replace(/\D/g, '');

/** CPF "000.000.000-00" ou CNPJ "00.000.000/0000-00" (o alfanumérico também). */
export function formatDocument(value: string | null | undefined) {
  if (!value) return '';
  const v = value.toUpperCase();
  if (/^\d{11}$/.test(v)) return `${v.slice(0, 3)}.${v.slice(3, 6)}.${v.slice(6, 9)}-${v.slice(9)}`;
  if (/^[0-9A-Z]{12}\d{2}$/.test(v)) return `${v.slice(0, 2)}.${v.slice(2, 5)}.${v.slice(5, 8)}/${v.slice(8, 12)}-${v.slice(12)}`;
  return value;
}

export const formatZip = (value: string | null | undefined) => {
  const d = digits(value ?? '');
  return d.length === 8 ? `${d.slice(0, 5)}-${d.slice(5)}` : (value ?? '');
};

/** Chave de acesso em blocos de 4, como no DANFE. */
export const formatAccessKey = (value: string | null | undefined) => (value ? value.replace(/(\d{4})(?=\d)/g, '$1 ') : '');

export const formatFiscalNumber = (series: number, number: number) =>
  `${String(number).padStart(9, '0').replace(/(\d{3})(?=\d)/g, '$1.')} / série ${series}`;

/** Campos do endereço no estado do formulário (strings, nunca null). */
export type AddressForm = { [K in keyof FiscalAddress]: string };

export const emptyAddress = (): AddressForm => ({
  address_zip: '',
  address_street: '',
  address_number: '',
  address_complement: '',
  address_district: '',
  address_city: '',
  address_city_code: '',
  address_state: '',
});

export function addressToForm(address: Partial<FiscalAddress> | null | undefined): AddressForm {
  const form = emptyAddress();
  for (const key of Object.keys(form) as (keyof AddressForm)[]) {
    const value = address?.[key];
    form[key] = key === 'address_zip' ? formatZip(value) : (value ?? '');
  }
  return form;
}

/** Texto do campo numérico ("18,5") para o JSON (18.5); vazio vira null. */
export function rateToJson(text: string): number | null {
  const value = text.trim().replace(',', '.');
  if (!value) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : Number.NaN;
}

export const rateToInput = (value: number | null | undefined) => (value == null ? '' : String(value).replace('.', ','));
