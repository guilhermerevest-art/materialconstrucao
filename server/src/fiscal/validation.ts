import { z } from 'zod';
import { cityMatchesState, isValidCnpj, isValidCpf, stripDocument, UF_CODES } from '../lib/document.js';
import { optionalText } from '../lib/validation.js';
import { IBSCBS_CST, NORMAL_ICMS_CST, PIS_COFINS_CST, SIMPLES_CSOSN } from './invoice.js';

const blankToNull = (value: unknown) =>
  value === undefined || value === null || (typeof value === 'string' && value.trim() === '') ? null : value;

/** Campo só de dígitos (máscara é ignorada): vazio vira null. */
export const digitsField = (pattern: RegExp, message: string) =>
  z.preprocess(
    (value) => {
      const v = blankToNull(value);
      return v === null ? null : String(v).replace(/\D/g, '');
    },
    z.string().regex(pattern, message).nullable(),
  );

/** GTIN-8/12/13/14 com dígito verificador: a SEFAZ recusa código de barras com dígito errado. */
export function isValidGtin(value: string) {
  if (!/^(\d{8}|\d{12,14})$/.test(value)) return false;
  const digits = [...value].map(Number);
  const check = digits.pop()!;
  const sum = digits.reverse().reduce((acc, d, i) => acc + d * (i % 2 === 0 ? 3 : 1), 0);
  return (10 - (sum % 10)) % 10 === check;
}

const optionalRate = (label: string) =>
  z.preprocess(
    blankToNull,
    z
      .number(`${label} inválida.`)
      .min(0, `${label} não pode ser negativa.`)
      .max(100, `${label} não pode passar de 100%.`)
      .nullable(),
  );

const optionalEnum = <T extends readonly [string, ...string[]]>(values: T, message: string) =>
  z.preprocess(blankToNull, z.enum(values, message).nullable());

export const ufField = z.preprocess(
  (value) => {
    const v = blankToNull(value);
    return v === null ? null : String(v).trim().toUpperCase();
  },
  z.enum(Object.keys(UF_CODES) as [string, ...string[]], 'UF inválida.').nullable(),
);

export const cnpjField = z.preprocess(
  (value) => {
    const v = blankToNull(value);
    return v === null ? null : stripDocument(String(v));
  },
  z.string().refine(isValidCnpj, 'CNPJ inválido. Confira os números.').nullable(),
);

export const emailField = z.preprocess(blankToNull, z.email('E-mail inválido.').max(60).nullable());

export const zipField = digitsField(/^\d{8}$/, 'O CEP tem 8 dígitos.');
export const cityCodeField = digitsField(/^\d{7}$/, 'O código IBGE do município tem 7 dígitos.');

/** Endereço no formato da NF-e. O código IBGE precisa ser da UF informada. */
export const addressFields = {
  address_zip: zipField,
  address_street: optionalText(60),
  address_number: optionalText(60),
  address_complement: optionalText(60),
  address_district: optionalText(60),
  address_city: optionalText(60),
  address_city_code: cityCodeField,
  address_state: ufField,
};

export function refineAddress(
  value: { address_city_code: string | null; address_state: string | null },
  ctx: z.RefinementCtx,
) {
  if (value.address_city_code && value.address_state && !cityMatchesState(value.address_city_code, value.address_state)) {
    ctx.addIssue({
      code: 'custom',
      message: `O código IBGE ${value.address_city_code} não é de um município de ${value.address_state}.`,
      path: ['address_city_code'],
    });
  }
}

/** Aba fiscal do produto. Tudo opcional: o que faltar a emissão aponta na hora. */
export const productFiscalSchema = z.object({
  gtin: z.preprocess(
    (value) => {
      const v = blankToNull(value);
      return v === null || String(v).trim().toUpperCase() === 'SEM GTIN' ? null : String(v).replace(/\D/g, '');
    },
    z.string().refine(isValidGtin, 'Código de barras (GTIN/EAN) inválido. Confira os dígitos ou deixe em branco.').nullable(),
  ),
  ncm: digitsField(/^\d{8}$/, 'O NCM tem 8 dígitos.'),
  cest: digitsField(/^\d{7}$/, 'O CEST tem 7 dígitos.'),
  cfop: digitsField(/^[56]\d{3}$/, 'Informe o CFOP de venda (começa com 5), por exemplo 5102.'),
  tax_origin: z.number('Origem inválida.').int().min(0).max(8, 'Origem inválida.').default(0),
  icms_cst: optionalEnum([...SIMPLES_CSOSN, ...NORMAL_ICMS_CST] as const, 'Situação tributária do ICMS inválida.'),
  icms_rate: optionalRate('Alíquota do ICMS'),
  icms_base_reduction: optionalRate('Redução da base do ICMS'),
  pis_cst: optionalEnum(PIS_COFINS_CST, 'CST do PIS inválido.'),
  pis_rate: optionalRate('Alíquota do PIS'),
  cofins_cst: optionalEnum(PIS_COFINS_CST, 'CST da COFINS inválido.'),
  cofins_rate: optionalRate('Alíquota da COFINS'),
  ibscbs_cst: optionalEnum(IBSCBS_CST, 'CST do IBS/CBS inválido.'),
  ibscbs_class: digitsField(/^\d{6}$/, 'A classificação tributária (cClassTrib) tem 6 dígitos.'),
  tax_benefit_code: z.preprocess(
    (value) => {
      const v = blankToNull(value);
      return v === null ? null : String(v).trim().toUpperCase();
    },
    z.string().regex(/^[A-Z0-9]{8,10}$/, 'O código de benefício fiscal (cBenef) tem 8 ou 10 caracteres.').nullable(),
  ),
  fiscal_notes: optionalText(500),
});

export type ProductFiscalInput = z.infer<typeof productFiscalSchema>;

/** Cadastro completo do cliente (dados da NF-e). */
export const clientDetailsSchema = z
  .object({
    person_type: z.preprocess(blankToNull, z.enum(['F', 'J'], 'Escolha pessoa física ou jurídica.').nullable()),
    document: z.preprocess((value) => {
      const v = blankToNull(value);
      return v === null ? null : stripDocument(String(v));
    }, z.string().max(14, 'CPF ou CNPJ inválido.').nullable()),
    trade_name: optionalText(60),
    state_registration: z.preprocess((value) => {
      const v = blankToNull(value);
      return v === null ? null : String(v).replace(/[\s./-]/g, '').toUpperCase();
    }, z.string().regex(/^(\d{2,14}|ISENTO)$/, 'Inscrição estadual inválida: use só os números ou ISENTO.').nullable()),
    ie_indicator: z.preprocess(
      blankToNull,
      z
        .number()
        .int()
        .refine((v) => [1, 2, 9].includes(v), 'Indicador da IE inválido.')
        .nullable(),
    ),
    final_consumer: z.boolean().default(true),
    email: emailField,
    phone: optionalText(20),
    ...addressFields,
  })
  .superRefine((value, ctx) => {
    refineAddress(value, ctx);
    if (value.document) {
      const type = value.person_type ?? (value.document.length === 11 ? 'F' : 'J');
      const valid = type === 'F' ? isValidCpf(value.document) : isValidCnpj(value.document);
      if (!valid) {
        ctx.addIssue({ code: 'custom', message: type === 'F' ? 'CPF inválido.' : 'CNPJ inválido.', path: ['document'] });
      }
    }
    if (value.ie_indicator === 1 && (!value.state_registration || value.state_registration === 'ISENTO')) {
      ctx.addIssue({
        code: 'custom',
        message: 'Contribuinte do ICMS precisa da inscrição estadual.',
        path: ['state_registration'],
      });
    }
  })
  // Sem tipo escolhido, o tipo vem do tamanho do documento.
  .transform((value) => ({
    ...value,
    person_type: value.document ? (value.person_type ?? (value.document.length === 11 ? 'F' : 'J')) : value.person_type,
    state_registration: value.state_registration === 'ISENTO' ? null : value.state_registration,
    ie_indicator: value.state_registration === 'ISENTO' && value.ie_indicator === null ? 2 : value.ie_indicator,
  }));

export type ClientDetailsInput = z.infer<typeof clientDetailsSchema>;
