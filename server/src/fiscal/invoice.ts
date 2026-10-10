import { cityMatchesState, isValidCnpj, isValidCpf, onlyDigits, UF_CODES } from '../lib/document.js';
import { formatOrderNumber } from '../lib/format.js';
import type { AcbrEnvironment } from './acbr.js';

/**
 * Monta o pedido de emissão da ACBr API (POST /nfe ou /nfce). O JSON segue a
 * hierarquia e os nomes de campo do layout 4.00 da NF-e (MOC). Os valores saem
 * do banco, nunca do navegador, e os totais são recalculados aqui em centavos.
 */

export type InvoiceModel = 55 | 65;

/** Dados da empresa emitente (Configurações → Fiscal). */
export type FiscalCompany = {
  environment: AcbrEnvironment;
  cnpj: string | null;
  legal_name: string | null;
  trade_name: string | null;
  state_registration: string | null;
  municipal_registration: string | null;
  cnae: string | null;
  tax_regime: number | null;
  phone: string | null;
  address_zip: string | null;
  address_street: string | null;
  address_number: string | null;
  address_complement: string | null;
  address_district: string | null;
  address_city: string | null;
  address_city_code: string | null;
  address_state: string | null;
  operation_nature: string;
  additional_info: string | null;
  ibs_uf_rate: number;
  ibs_mun_rate: number;
  cbs_rate: number;
};

/** Cadastro completo do cliente. */
export type FiscalClient = {
  name: string;
  whatsapp: string;
  person_type: 'F' | 'J' | null;
  document: string | null;
  trade_name: string | null;
  state_registration: string | null;
  ie_indicator: number | null;
  final_consumer: boolean;
  email: string | null;
  phone: string | null;
  address_zip: string | null;
  address_street: string | null;
  address_number: string | null;
  address_complement: string | null;
  address_district: string | null;
  address_city: string | null;
  address_city_code: string | null;
  address_state: string | null;
};

/** Aba fiscal do produto. */
export type ProductFiscal = {
  gtin: string | null;
  ncm: string | null;
  cest: string | null;
  cfop: string | null;
  tax_origin: number;
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

export type FiscalItem = ProductFiscal & {
  position: number;
  product_id: number;
  product_code: string | null;
  product_name: string;
  unit: string;
  quantity: number;
  unit_price: number;
  subtotal: number;
};

export type FiscalOrder = {
  id: number;
  subtotal_amount: number;
  discount_amount: number;
  total_amount: number;
  notes: string | null;
  delivery_address: string | null;
  payment_method_name: string | null;
  items: FiscalItem[];
};

export type InvoiceInput = {
  model: InvoiceModel;
  company: FiscalCompany;
  client: FiscalClient;
  order: FiscalOrder;
  series: number;
  number: number;
  reference: string;
  issuedAt: Date;
  timeZone: string;
};

export type InvoiceResult =
  | { ok: true; payload: Record<string, unknown>; recipient: { name: string | null; document: string | null } }
  | { ok: false; problems: string[] };

/** CRT 1, 2 e 4 usam CSOSN; o regime normal (3) usa CST. */
export const isSimplesNacional = (taxRegime: number | null) => taxRegime === 1 || taxRegime === 2 || taxRegime === 4;

export const SIMPLES_CSOSN = ['101', '102', '103', '300', '400', '500', '900'] as const;
export const NORMAL_ICMS_CST = ['00', '20', '40', '41', '50', '60'] as const;
/** CST 03 (alíquota por unidade de medida) não é usado no varejo e fica de fora. */
export const PIS_COFINS_CST = [
  '01', '02', '04', '05', '06', '07', '08', '09', '49',
  '50', '51', '52', '53', '54', '55', '56', '60', '61', '62', '63', '64', '65', '66', '67',
  '70', '71', '72', '73', '74', '75', '98', '99',
] as const;
/** CST do IBS/CBS suportados: tributação integral, isenção e imunidade/não incidência. */
export const IBSCBS_CST = ['000', '400', '410'] as const;

const HOMOLOGATION_RECIPIENT = 'NF-E EMITIDA EM AMBIENTE DE HOMOLOGACAO - SEM VALOR FISCAL';
const HOMOLOGATION_FIRST_ITEM = 'NOTA FISCAL EMITIDA EM AMBIENTE DE HOMOLOGACAO - SEM VALOR FISCAL';
const SOFTWARE_VERSION = 'GestaoLoja 1.0';
const BRAZIL = { cPais: '1058', xPais: 'BRASIL' };

/** A SEFAZ recusa quebra de linha e espaço duplo na maioria dos campos de texto. */
function clean(value: string | null | undefined, max: number): string | undefined {
  if (value == null) return undefined;
  const text = value.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
  return text ? text.slice(0, max).trim() : undefined;
}

/** Unidade comercial: até 6 caracteres e sem "²"/"³", que algumas SEFAZ recusam. */
function fiscalUnit(unit: string) {
  return unit.replace(/²/g, '2').replace(/³/g, '3').normalize('NFD').replace(/[̀-ͯ]/g, '').slice(0, 6);
}

const money = (cents: number) => Math.round(cents) / 100;

/** Percentual sobre um valor em centavos, arredondado ao centavo. */
function percentOf(cents: number, rate: number) {
  return Math.round(Number(((cents * rate) / 100).toFixed(6)));
}

/**
 * Rateia o desconto do pedido entre os itens, proporcional ao valor de cada um
 * (método do maior resto): a soma bate com o total ao centavo e nenhum item
 * recebe mais desconto que o próprio valor.
 */
export function apportion(totalCents: number, weights: number[]): number[] {
  const sum = weights.reduce((acc, w) => acc + w, 0);
  if (totalCents <= 0 || sum <= 0) return weights.map(() => 0);
  const exact = weights.map((w) => (totalCents * w) / sum);
  const shares = exact.map(Math.floor);
  let remaining = totalCents - shares.reduce((acc, v) => acc + v, 0);
  const order = exact.map((value, index) => ({ index, frac: value - Math.floor(value) })).sort((a, b) => b.frac - a.frac);
  for (const { index } of order) {
    if (remaining <= 0) break;
    shares[index]! += 1;
    remaining -= 1;
  }
  return shares;
}

/** Data e hora local com o fuso (AAAA-MM-DDThh:mm:ss-03:00), como pede o dhEmi. */
export function formatDateTimeOffset(date: Date, timeZone: string) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
      timeZoneName: 'longOffset',
    })
      .formatToParts(date)
      .map((part) => [part.type, part.value]),
  ) as Record<string, string>;
  const zone = parts.timeZoneName ?? 'GMT';
  const offset = zone === 'GMT' ? '+00:00' : zone.replace('GMT', '');
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}${offset}`;
}

const normalizeName = (value: string) =>
  value
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '');

/**
 * Código da forma de pagamento (tPag) pelo nome cadastrado. O que não for
 * reconhecido sai como 99 (outros) com o nome em xPag.
 */
export function paymentCode(name: string | null): { tPag: string; xPag?: string; indPag: 0 | 1 } {
  if (!name) return { tPag: '99', xPag: 'Nao informada', indPag: 0 };
  const n = normalizeName(name);
  if (/\bpix\b/.test(n)) return { tPag: '17', indPag: 0 };
  if (/boleto/.test(n)) return { tPag: '15', indPag: 1 };
  if (/debito/.test(n)) return { tPag: '04', indPag: 0 };
  if (/crediario|credito (da |na )?loja|fiado|a prazo|carne/.test(n)) return { tPag: '05', indPag: 1 };
  if (/credito|cartao/.test(n)) return { tPag: '03', indPag: 0 };
  if (/cheque/.test(n)) return { tPag: '02', indPag: 0 };
  if (/deposito/.test(n)) return { tPag: '16', indPag: 0 };
  if (/transferencia|\bted\b/.test(n)) return { tPag: '18', indPag: 0 };
  if (/dinheiro|especie/.test(n)) return { tPag: '01', indPag: 0 };
  return { tPag: '99', xPag: clean(name, 60), indPag: 0 };
}

/** CFOP padrão quando o produto não tem: 5405 para mercadoria com ST, 5102 para o resto. */
export function defaultCfop(icmsCst: string | null) {
  return icmsCst === '500' || icmsCst === '60' ? '5405' : '5102';
}

type ItemTaxes = {
  imposto: Record<string, unknown>;
  vBC: number;
  vICMS: number;
  vPIS: number;
  vCOFINS: number;
  ibscbs: { vBC: number; vIBSUF: number; vIBSMun: number; vCBS: number } | null;
};

function icmsGroup(
  simples: boolean,
  item: FiscalItem,
  baseCents: number,
  label: string,
  problems: string[],
): { group: Record<string, unknown>; vBC: number; vICMS: number } | null {
  const cst = item.icms_cst;
  const orig = item.tax_origin;
  if (!cst) {
    problems.push(`${label}: informe a situação tributária do ICMS (${simples ? 'CSOSN' : 'CST'}) na aba Fiscal.`);
    return null;
  }
  const rate = item.icms_rate;
  if (simples) {
    if (!(SIMPLES_CSOSN as readonly string[]).includes(cst)) {
      problems.push(`${label}: o CSOSN ${cst} não vale para o Simples Nacional. Use ${SIMPLES_CSOSN.join(', ')}.`);
      return null;
    }
    if (cst === '101') {
      if (rate == null) {
        problems.push(`${label}: o CSOSN 101 precisa da alíquota de crédito do Simples (campo "Alíquota ICMS").`);
        return null;
      }
      return {
        group: { ICMSSN101: { orig, CSOSN: cst, pCredSN: rate, vCredICMSSN: money(percentOf(baseCents, rate)) } },
        vBC: 0,
        vICMS: 0,
      };
    }
    if (cst === '500') return { group: { ICMSSN500: { orig, CSOSN: cst } }, vBC: 0, vICMS: 0 };
    if (cst === '900') {
      if (!rate) return { group: { ICMSSN900: { orig, CSOSN: cst } }, vBC: 0, vICMS: 0 };
      const vICMS = percentOf(baseCents, rate);
      return {
        group: { ICMSSN900: { orig, CSOSN: cst, modBC: 3, vBC: money(baseCents), pICMS: rate, vICMS: money(vICMS) } },
        vBC: baseCents,
        vICMS,
      };
    }
    return { group: { ICMSSN102: { orig, CSOSN: cst } }, vBC: 0, vICMS: 0 };
  }

  if (!(NORMAL_ICMS_CST as readonly string[]).includes(cst)) {
    problems.push(`${label}: o CST ${cst} do ICMS não é suportado. Use ${NORMAL_ICMS_CST.join(', ')}.`);
    return null;
  }
  if (cst === '00' || cst === '20') {
    if (rate == null) {
      problems.push(`${label}: o CST ${cst} precisa da alíquota do ICMS.`);
      return null;
    }
    if (cst === '00') {
      const vICMS = percentOf(baseCents, rate);
      return {
        group: { ICMS00: { orig, CST: cst, modBC: 3, vBC: money(baseCents), pICMS: rate, vICMS: money(vICMS) } },
        vBC: baseCents,
        vICMS,
      };
    }
    const reduction = item.icms_base_reduction;
    if (reduction == null) {
      problems.push(`${label}: o CST 20 precisa do percentual de redução da base do ICMS.`);
      return null;
    }
    const vBC = baseCents - percentOf(baseCents, reduction);
    const vICMS = percentOf(vBC, rate);
    return {
      group: {
        ICMS20: { orig, CST: cst, modBC: 3, pRedBC: reduction, vBC: money(vBC), pICMS: rate, vICMS: money(vICMS) },
      },
      vBC,
      vICMS,
    };
  }
  if (cst === '60') return { group: { ICMS60: { orig, CST: cst } }, vBC: 0, vICMS: 0 };
  return { group: { ICMS40: { orig, CST: cst } }, vBC: 0, vICMS: 0 };
}

/** PIS e COFINS têm a mesma estrutura; muda o prefixo dos campos. */
function contributionGroup(
  kind: 'PIS' | 'COFINS',
  cstValue: string | null,
  rate: number | null,
  simples: boolean,
  baseCents: number,
  label: string,
  problems: string[],
): { group: Record<string, unknown>; value: number } | null {
  // No Simples Nacional o PIS e a COFINS são recolhidos no DAS: 49 (outras operações) é o usual.
  const cst = cstValue ?? (simples ? '49' : null);
  if (!cst) {
    problems.push(`${label}: informe o CST do ${kind} na aba Fiscal.`);
    return null;
  }
  if (!(PIS_COFINS_CST as readonly string[]).includes(cst)) {
    problems.push(`${label}: o CST ${cst} do ${kind} não é suportado.`);
    return null;
  }
  const p = `p${kind}`;
  const v = `v${kind}`;
  if (cst === '01' || cst === '02') {
    if (rate == null) {
      problems.push(`${label}: o CST ${cst} do ${kind} precisa da alíquota.`);
      return null;
    }
    const value = percentOf(baseCents, rate);
    return { group: { [`${kind}Aliq`]: { CST: cst, vBC: money(baseCents), [p]: rate, [v]: money(value) } }, value };
  }
  if (['04', '05', '06', '07', '08', '09'].includes(cst)) return { group: { [`${kind}NT`]: { CST: cst } }, value: 0 };
  const value = rate ? percentOf(baseCents, rate) : 0;
  return {
    group: { [`${kind}Outr`]: { CST: cst, vBC: money(rate ? baseCents : 0), [p]: rate ?? 0, [v]: money(value) } },
    value,
  };
}

function itemTaxes(
  item: FiscalItem,
  company: FiscalCompany,
  vProd: number,
  vDesc: number,
  label: string,
  problems: string[],
): ItemTaxes | null {
  const simples = isSimplesNacional(company.tax_regime);
  const base = vProd - vDesc;
  const icms = icmsGroup(simples, item, base, label, problems);
  const pis = contributionGroup('PIS', item.pis_cst, item.pis_rate, simples, base, label, problems);
  const cofins = contributionGroup('COFINS', item.cofins_cst, item.cofins_rate, simples, base, label, problems);
  if (!icms || !pis || !cofins) return null;

  const imposto: Record<string, unknown> = { ICMS: icms.group, PIS: pis.group, COFINS: cofins.group };
  let ibscbs: ItemTaxes['ibscbs'] = null;
  // Reforma tributária: só o regime normal destaca IBS/CBS, e só quando o produto tem a classificação.
  if (!simples && (item.ibscbs_cst || item.ibscbs_class)) {
    const cst = item.ibscbs_cst;
    const cClassTrib = item.ibscbs_class;
    if (!cst || !cClassTrib || !/^\d{6}$/.test(cClassTrib)) {
      problems.push(`${label}: para o IBS/CBS informe o CST e a classificação tributária (6 dígitos) juntos.`);
      return null;
    }
    if (!(IBSCBS_CST as readonly string[]).includes(cst)) {
      problems.push(`${label}: o CST ${cst} do IBS/CBS não é suportado. Use ${IBSCBS_CST.join(', ')}.`);
      return null;
    }
    if (cst === '000') {
      // Na transição, ICMS, PIS e COFINS saem da base do IBS/CBS (LC 214/2025, art. 12).
      const vBC = Math.max(0, base - icms.vICMS - pis.value - cofins.value);
      const vIBSUF = percentOf(vBC, company.ibs_uf_rate);
      const vIBSMun = percentOf(vBC, company.ibs_mun_rate);
      const vCBS = percentOf(vBC, company.cbs_rate);
      imposto.IBSCBS = {
        CST: cst,
        cClassTrib,
        gIBSCBS: {
          vBC: money(vBC),
          gIBSUF: { pIBSUF: company.ibs_uf_rate, vIBSUF: money(vIBSUF) },
          gIBSMun: { pIBSMun: company.ibs_mun_rate, vIBSMun: money(vIBSMun) },
          vIBS: money(vIBSUF + vIBSMun),
          gCBS: { pCBS: company.cbs_rate, vCBS: money(vCBS) },
        },
      };
      ibscbs = { vBC, vIBSUF, vIBSMun, vCBS };
    } else {
      imposto.IBSCBS = { CST: cst, cClassTrib };
    }
  }
  return { imposto, vBC: icms.vBC, vICMS: icms.vICMS, vPIS: pis.value, vCOFINS: cofins.value, ibscbs };
}

function companyProblems(company: FiscalCompany): string[] {
  const problems: string[] = [];
  const where = 'em Configurações → Fiscal';
  if (!company.cnpj || !isValidCnpj(company.cnpj)) problems.push(`Informe um CNPJ válido da empresa ${where}.`);
  if (!company.legal_name) problems.push(`Informe a razão social da empresa ${where}.`);
  if (!company.state_registration) problems.push(`Informe a inscrição estadual da empresa ${where}.`);
  if (!company.tax_regime) problems.push(`Informe o regime tributário (CRT) da empresa ${where}.`);
  const missing = [
    ['address_street', 'logradouro'],
    ['address_number', 'número'],
    ['address_district', 'bairro'],
    ['address_city', 'município'],
    ['address_city_code', 'código IBGE do município'],
    ['address_state', 'UF'],
    ['address_zip', 'CEP'],
  ].filter(([key]) => !company[key as keyof FiscalCompany]);
  if (missing.length) problems.push(`Complete o endereço da empresa ${where}: ${missing.map(([, name]) => name).join(', ')}.`);
  if (
    company.address_city_code &&
    company.address_state &&
    !cityMatchesState(company.address_city_code, company.address_state)
  ) {
    problems.push(`O código IBGE do município da empresa não é da UF ${company.address_state}.`);
  }
  return problems;
}

function recipientDocument(client: FiscalClient): { CPF?: string; CNPJ?: string } | null {
  if (!client.document || !client.person_type) return null;
  if (client.person_type === 'F' && isValidCpf(client.document)) return { CPF: client.document };
  if (client.person_type === 'J' && isValidCnpj(client.document)) return { CNPJ: client.document };
  return null;
}

function phoneDigits(value: string | null) {
  const digits = value ? onlyDigits(value) : '';
  // No Brasil o fone vai com DDD e sem o 55: 10 ou 11 dígitos.
  const local = digits.length > 11 && digits.startsWith('55') ? digits.slice(2) : digits;
  return local.length >= 6 && local.length <= 14 ? local : undefined;
}

function buildRecipient(
  input: InvoiceInput,
  homologation: boolean,
  problems: string[],
): { dest: Record<string, unknown> | undefined; interstate: boolean; nonTaxpayer: boolean } {
  const { client, company, model } = input;
  const doc = recipientDocument(client);
  const name = homologation ? HOMOLOGATION_RECIPIENT : clean(client.name, 60);

  if (model === 65) {
    // NFC-e: o consumidor só é identificado quando informa CPF/CNPJ.
    if (client.document && !doc) problems.push('O CPF/CNPJ do cliente é inválido. Corrija no cadastro completo do cliente.');
    return { dest: doc ? { ...doc, xNome: name, indIEDest: 9 } : undefined, interstate: false, nonTaxpayer: true };
  }

  const where = 'no cadastro completo do cliente';
  if (!doc) problems.push(`Informe um CPF ou CNPJ válido ${where}.`);
  const missing = [
    ['address_street', 'logradouro'],
    ['address_number', 'número'],
    ['address_district', 'bairro'],
    ['address_city', 'município'],
    ['address_city_code', 'código IBGE do município'],
    ['address_state', 'UF'],
  ].filter(([key]) => !client[key as keyof FiscalClient]);
  if (missing.length) problems.push(`Complete o endereço ${where}: ${missing.map(([, n]) => n).join(', ')}.`);
  if (client.address_city_code && client.address_state && !cityMatchesState(client.address_city_code, client.address_state)) {
    problems.push(`O código IBGE do município do cliente não é da UF ${client.address_state}.`);
  }
  const indIEDest = client.ie_indicator ?? (client.person_type === 'J' && client.state_registration ? 1 : 9);
  const ie = client.state_registration ? onlyDigits(client.state_registration) : '';
  if (indIEDest === 1 && !ie) problems.push(`Cliente contribuinte do ICMS: informe a inscrição estadual ${where}.`);

  const dest: Record<string, unknown> = {
    ...(doc ?? {}),
    xNome: name,
    enderDest: {
      xLgr: clean(client.address_street, 60),
      nro: clean(client.address_number, 60),
      xCpl: clean(client.address_complement, 60),
      xBairro: clean(client.address_district, 60),
      cMun: client.address_city_code,
      xMun: clean(client.address_city, 60),
      UF: client.address_state,
      CEP: client.address_zip ?? undefined,
      ...BRAZIL,
      fone: phoneDigits(client.phone) ?? phoneDigits(client.whatsapp),
    },
    indIEDest,
    IE: indIEDest === 1 ? ie : undefined,
    email: clean(client.email, 60),
  };
  return {
    dest,
    interstate: Boolean(client.address_state && company.address_state && client.address_state !== company.address_state),
    nonTaxpayer: indIEDest === 9,
  };
}

/** Remove chaves undefined para o JSON sair limpo (a ACBr API valida campo vazio como inválido). */
function compact<T>(value: T): T {
  if (Array.isArray(value)) return value.map(compact) as T;
  if (value && typeof value === 'object' && !(value instanceof Date)) {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, v]) => v !== undefined)
        .map(([k, v]) => [k, compact(v)]),
    ) as T;
  }
  return value;
}

export function buildInvoice(input: InvoiceInput): InvoiceResult {
  const { model, company, client, order } = input;
  const homologation = company.environment === 'homologacao';
  const simples = isSimplesNacional(company.tax_regime);
  const problems = companyProblems(company);
  if (!order.items.length) problems.push('O pedido não tem itens.');

  const { dest, interstate, nonTaxpayer } = buildRecipient(input, homologation, problems);
  const finalConsumer = model === 65 || client.final_consumer;
  if (model === 55 && interstate && finalConsumer && nonTaxpayer) {
    problems.push(
      'Venda para consumidor final não contribuinte de outra UF exige o DIFAL, que ainda não é calculado aqui. Emita pela loja da UF do cliente ou ajuste o cadastro.',
    );
  }
  if (model === 55 && interstate && !simples) {
    problems.push('Venda interestadual no regime normal (alíquota interestadual do ICMS) ainda não é suportada.');
  }

  const itemsCents = order.items.map((item) => Math.round(item.subtotal * 100));
  const discounts = apportion(Math.round(order.discount_amount * 100), itemsCents);
  const totals = { vBC: 0, vICMS: 0, vProd: 0, vDesc: 0, vPIS: 0, vCOFINS: 0 };
  const ibscbsTotals = { used: false, vBC: 0, vIBSUF: 0, vIBSMun: 0, vCBS: 0 };

  const det = order.items.map((item, index) => {
    const label = `Produto "${item.product_name}"`;
    const vProd = itemsCents[index]!;
    const vDesc = discounts[index]!;
    if (!item.ncm || !/^\d{8}$/.test(item.ncm)) problems.push(`${label}: informe o NCM (8 dígitos) na aba Fiscal.`);
    let cfop = item.cfop ?? defaultCfop(item.icms_cst);
    if (!/^[56]\d{3}$/.test(cfop)) problems.push(`${label}: o CFOP ${cfop} não é de venda (deve começar com 5).`);
    if (model === 65 && cfop.startsWith('6')) problems.push(`${label}: a NFC-e só aceita CFOP de operação interna (5xxx).`);
    // O cadastro guarda o CFOP da venda dentro do estado; fora dele troca o primeiro dígito.
    if (interstate && cfop.startsWith('5')) cfop = `6${cfop.slice(1)}`;
    if (!interstate && cfop.startsWith('6')) cfop = `5${cfop.slice(1)}`;
    const taxes = itemTaxes(item, company, vProd, vDesc, label, problems);
    if (taxes) {
      totals.vBC += taxes.vBC;
      totals.vICMS += taxes.vICMS;
      totals.vPIS += taxes.vPIS;
      totals.vCOFINS += taxes.vCOFINS;
      if (taxes.ibscbs) {
        ibscbsTotals.used = true;
        ibscbsTotals.vBC += taxes.ibscbs.vBC;
        ibscbsTotals.vIBSUF += taxes.ibscbs.vIBSUF;
        ibscbsTotals.vIBSMun += taxes.ibscbs.vIBSMun;
        ibscbsTotals.vCBS += taxes.ibscbs.vCBS;
      }
    }
    totals.vProd += vProd;
    totals.vDesc += vDesc;

    const gtin = item.gtin ?? 'SEM GTIN';
    const unit = fiscalUnit(item.unit);
    const name =
      model === 65 && homologation && index === 0 ? HOMOLOGATION_FIRST_ITEM : (clean(item.product_name, 120) ?? 'PRODUTO');
    return {
      nItem: index + 1,
      prod: {
        cProd: clean(item.product_code, 60) ?? String(item.product_id),
        cEAN: gtin,
        xProd: name,
        NCM: item.ncm ?? undefined,
        CEST: item.cest ?? undefined,
        cBenef: item.tax_benefit_code ?? undefined,
        CFOP: cfop,
        uCom: unit,
        qCom: item.quantity,
        vUnCom: item.unit_price,
        vProd: money(vProd),
        cEANTrib: gtin,
        uTrib: unit,
        qTrib: item.quantity,
        vUnTrib: item.unit_price,
        vDesc: vDesc > 0 ? money(vDesc) : undefined,
        indTot: 1,
      },
      imposto: taxes?.imposto ?? {},
      infAdProd: clean(item.fiscal_notes, 500),
    };
  });

  if (problems.length) return { ok: false, problems: [...new Set(problems)] };

  const vNF = totals.vProd - totals.vDesc;
  if (vNF !== Math.round(order.total_amount * 100)) {
    // Não deveria acontecer: o total do pedido é calculado no servidor com os mesmos itens.
    return { ok: false, problems: ['O total do pedido não confere com a soma dos itens. Atualize a página e tente de novo.'] };
  }

  const payment = paymentCode(order.payment_method_name);
  const additional = [
    clean(company.additional_info, 2000),
    `Pedido nº ${formatOrderNumber(order.id)}`,
    order.delivery_address ? `Entrega: ${clean(order.delivery_address, 300)}` : undefined,
    order.notes ? `Obs.: ${clean(order.notes, 1000)}` : undefined,
  ].filter(Boolean);

  const total: Record<string, unknown> = {
    ICMSTot: {
      vBC: money(totals.vBC),
      vICMS: money(totals.vICMS),
      vICMSDeson: 0,
      vFCP: 0,
      vBCST: 0,
      vST: 0,
      vFCPST: 0,
      vFCPSTRet: 0,
      vProd: money(totals.vProd),
      vFrete: 0,
      vSeg: 0,
      vDesc: money(totals.vDesc),
      vII: 0,
      vIPI: 0,
      vIPIDevol: 0,
      vPIS: money(totals.vPIS),
      vCOFINS: money(totals.vCOFINS),
      vOutro: 0,
      vNF: money(vNF),
    },
  };
  if (ibscbsTotals.used) {
    total.IBSCBSTot = {
      vBCIBSCBS: money(ibscbsTotals.vBC),
      gIBS: {
        gIBSUF: { vDif: 0, vDevTrib: 0, vIBSUF: money(ibscbsTotals.vIBSUF) },
        gIBSMun: { vDif: 0, vDevTrib: 0, vIBSMun: money(ibscbsTotals.vIBSMun) },
        vIBS: money(ibscbsTotals.vIBSUF + ibscbsTotals.vIBSMun),
        vCredPres: 0,
        vCredPresCondSus: 0,
      },
      gCBS: { vDif: 0, vDevTrib: 0, vCBS: money(ibscbsTotals.vCBS), vCredPres: 0, vCredPresCondSus: 0 },
    };
  }

  const hasIm = company.municipal_registration && company.cnae;
  const infNFe = {
    versao: '4.00',
    ide: {
      cUF: UF_CODES[company.address_state!],
      natOp: clean(company.operation_nature, 60) ?? 'Venda de mercadoria',
      mod: model,
      serie: input.series,
      nNF: input.number,
      dhEmi: formatDateTimeOffset(input.issuedAt, input.timeZone),
      tpNF: 1,
      idDest: interstate ? 2 : 1,
      cMunFG: company.address_city_code,
      tpImp: model === 65 ? 4 : 1,
      tpEmis: 1,
      tpAmb: homologation ? 2 : 1,
      finNFe: 1,
      indFinal: finalConsumer ? 1 : 0,
      indPres: 1,
      procEmi: 0,
      verProc: SOFTWARE_VERSION,
    },
    emit: {
      CNPJ: company.cnpj,
      xNome: clean(company.legal_name, 60),
      xFant: clean(company.trade_name, 60),
      enderEmit: {
        xLgr: clean(company.address_street, 60),
        nro: clean(company.address_number, 60),
        xCpl: clean(company.address_complement, 60),
        xBairro: clean(company.address_district, 60),
        cMun: company.address_city_code,
        xMun: clean(company.address_city, 60),
        UF: company.address_state,
        CEP: company.address_zip,
        ...BRAZIL,
        fone: phoneDigits(company.phone),
      },
      IE: onlyDigits(company.state_registration!),
      // IM só vai junto com o CNAE (NF-e conjugada com serviços).
      IM: hasIm ? clean(company.municipal_registration, 15) : undefined,
      CNAE: hasIm ? onlyDigits(company.cnae!) : undefined,
      CRT: company.tax_regime,
    },
    dest,
    det,
    total,
    // NFC-e só aceita "sem frete"; na NF-e, entrega da loja é transporte próprio do remetente.
    transp: { modFrete: model === 55 && order.delivery_address ? 3 : 9 },
    pag: {
      detPag: [
        {
          indPag: payment.indPag,
          tPag: payment.tPag,
          xPag: payment.xPag,
          vPag: money(vNF),
          // Cartão e PIX pedem o grupo card; 2 = pagamento não integrado à automação.
          card: ['03', '04', '17'].includes(payment.tPag) ? { tpIntegra: 2 } : undefined,
        },
      ],
    },
    infAdic: additional.length ? { infCpl: clean(additional.join(' | '), 5000) } : undefined,
  };

  return {
    ok: true,
    payload: compact({ ambiente: company.environment, referencia: input.reference, infNFe }),
    recipient: {
      name: client.document || model === 55 ? client.name : null,
      document: client.document ?? null,
    },
  };
}
