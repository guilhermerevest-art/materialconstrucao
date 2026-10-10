import { describe, expect, it } from 'vitest';
import {
  apportion,
  buildInvoice,
  formatDateTimeOffset,
  paymentCode,
  type FiscalClient,
  type FiscalCompany,
  type FiscalItem,
  type InvoiceInput,
} from '../src/fiscal/invoice.js';
import { isValidCnpj, isValidCpf } from '../src/lib/document.js';
import { isValidGtin } from '../src/fiscal/validation.js';

const company: FiscalCompany = {
  environment: 'homologacao',
  cnpj: '11222333000181',
  legal_name: 'Material de Construção Exemplo LTDA',
  trade_name: 'Casa do Construtor',
  state_registration: '110.042.490.114',
  municipal_registration: null,
  cnae: null,
  tax_regime: 1,
  phone: '(11) 3333-0001',
  address_zip: '01001000',
  address_street: 'Praça da Sé',
  address_number: '100',
  address_complement: null,
  address_district: 'Sé',
  address_city: 'São Paulo',
  address_city_code: '3550308',
  address_state: 'SP',
  operation_nature: 'Venda de mercadoria',
  additional_info: 'Documento emitido por ME ou EPP optante pelo Simples Nacional.',
  ibs_uf_rate: 0.1,
  ibs_mun_rate: 0,
  cbs_rate: 0.9,
};

const client: FiscalClient = {
  name: 'Maria da Silva',
  whatsapp: '5511987654321',
  person_type: 'F',
  document: '52998224725',
  trade_name: null,
  state_registration: null,
  ie_indicator: 9,
  final_consumer: true,
  email: 'maria@exemplo.com.br',
  phone: null,
  address_zip: '01310100',
  address_street: 'Avenida Paulista',
  address_number: '1000',
  address_complement: 'Apto 12',
  address_district: 'Bela Vista',
  address_city: 'São Paulo',
  address_city_code: '3550308',
  address_state: 'SP',
};

function item(overrides: Partial<FiscalItem> = {}): FiscalItem {
  return {
    position: 1,
    product_id: 1,
    product_code: 'CIM-50',
    product_name: 'Cimento CP II 50 kg',
    unit: 'SC',
    quantity: 3,
    unit_price: 38.9,
    subtotal: 116.7,
    gtin: null,
    ncm: '25232910',
    cest: null,
    cfop: null,
    tax_origin: 0,
    icms_cst: '102',
    icms_rate: null,
    icms_base_reduction: null,
    pis_cst: null,
    pis_rate: null,
    cofins_cst: null,
    cofins_rate: null,
    ibscbs_cst: null,
    ibscbs_class: null,
    tax_benefit_code: null,
    fiscal_notes: null,
    ...overrides,
  };
}

function input(overrides: Partial<InvoiceInput> = {}): InvoiceInput {
  const items = [
    item(),
    item({
      position: 2,
      product_id: 2,
      product_code: 'ARE-MED',
      product_name: 'Areia média',
      unit: 'M³',
      quantity: 2.5,
      unit_price: 145,
      subtotal: 362.5,
      ncm: '25051000',
      icms_cst: '500',
    }),
  ];
  return {
    model: 55,
    company,
    client,
    order: {
      id: 42,
      subtotal_amount: 479.2,
      discount_amount: 47.92,
      total_amount: 431.28,
      notes: 'Entregar pela manhã',
      delivery_address: 'Rua das Flores, 10\nJardim',
      payment_method_name: 'PIX',
      items,
    },
    series: 1,
    number: 15,
    reference: 'gl-1-1-1',
    issuedAt: new Date('2026-10-10T15:04:05Z'),
    timeZone: 'America/Sao_Paulo',
    ...overrides,
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function payloadOf(result: ReturnType<typeof buildInvoice>): any {
  if (!result.ok) throw new Error(`esperava nota válida, veio: ${result.problems.join(' | ')}`);
  return result.payload;
}

describe('documentos e códigos', () => {
  it('valida CPF, CNPJ (inclusive alfanumérico) e GTIN pelo dígito verificador', () => {
    expect(isValidCpf('52998224725')).toBe(true);
    expect(isValidCpf('52998224724')).toBe(false);
    expect(isValidCpf('11111111111')).toBe(false);
    expect(isValidCnpj('11222333000181')).toBe(true);
    expect(isValidCnpj('11222333000182')).toBe(false);
    expect(isValidCnpj('12ABC34501DE35')).toBe(true);
    expect(isValidGtin('7891000315507')).toBe(true);
    expect(isValidGtin('7891000315508')).toBe(false);
  });

  it('rateia o desconto ao centavo sem passar do valor de nenhum item', () => {
    expect(apportion(1000, [3333, 3333, 3334])).toEqual([333, 333, 334]);
    expect(apportion(1, [100, 100])).toEqual([1, 0]);
    expect(apportion(200, [100, 100])).toEqual([100, 100]);
    expect(apportion(0, [100])).toEqual([0]);
  });

  it('formata o dhEmi com o fuso da loja', () => {
    expect(formatDateTimeOffset(new Date('2026-10-10T15:04:05Z'), 'America/Sao_Paulo')).toBe('2026-10-10T12:04:05-03:00');
  });

  it('reconhece a forma de pagamento pelo nome', () => {
    expect(paymentCode('PIX').tPag).toBe('17');
    expect(paymentCode('Cartão de crédito').tPag).toBe('03');
    expect(paymentCode('Cartão de débito').tPag).toBe('04');
    expect(paymentCode('Dinheiro').tPag).toBe('01');
    expect(paymentCode('Boleto')).toMatchObject({ tPag: '15', indPag: 1 });
    expect(paymentCode('Vale troca')).toMatchObject({ tPag: '99', xPag: 'Vale troca' });
  });
});

describe('montagem da NF-e', () => {
  it('gera a NF-e do Simples Nacional com totais, desconto rateado e homologação', () => {
    const payload = payloadOf(buildInvoice(input()));
    expect(payload).toMatchObject({ ambiente: 'homologacao', referencia: 'gl-1-1-1' });
    const nfe = payload.infNFe;
    expect(nfe.ide).toMatchObject({
      cUF: 35,
      mod: 55,
      serie: 1,
      nNF: 15,
      dhEmi: '2026-10-10T12:04:05-03:00',
      tpNF: 1,
      idDest: 1,
      cMunFG: '3550308',
      tpImp: 1,
      tpAmb: 2,
      finNFe: 1,
      indFinal: 1,
      indPres: 1,
    });
    expect(nfe.emit).toMatchObject({ CNPJ: '11222333000181', IE: '110042490114', CRT: 1 });
    expect(nfe.emit.IM).toBeUndefined();
    // Em homologação a SEFAZ exige este nome no destinatário.
    expect(nfe.dest).toMatchObject({
      CPF: '52998224725',
      xNome: 'NF-E EMITIDA EM AMBIENTE DE HOMOLOGACAO - SEM VALOR FISCAL',
      indIEDest: 9,
      enderDest: { xLgr: 'Avenida Paulista', cMun: '3550308', UF: 'SP', cPais: '1058' },
    });

    const [cimento, areia] = nfe.det;
    expect(cimento.prod).toMatchObject({ cProd: 'CIM-50', cEAN: 'SEM GTIN', NCM: '25232910', CFOP: '5102', uCom: 'SC', vProd: 116.7 });
    expect(cimento.imposto.ICMS).toEqual({ ICMSSN102: { orig: 0, CSOSN: '102' } });
    // No Simples, PIS/COFINS sem CST saem como 49 (outras operações).
    expect(cimento.imposto.PIS).toEqual({ PISOutr: { CST: '49', vBC: 0, pPIS: 0, vPIS: 0 } });
    // ST (CSOSN 500) usa 5405 e a unidade sai sem o "³".
    expect(areia.prod).toMatchObject({ CFOP: '5405', uCom: 'M3', uTrib: 'M3', qCom: 2.5 });
    expect(areia.imposto.ICMS).toEqual({ ICMSSN500: { orig: 0, CSOSN: '500' } });

    // Desconto de 47,92 rateado: 11,67 + 36,25.
    expect(cimento.prod.vDesc + areia.prod.vDesc).toBeCloseTo(47.92, 2);
    expect(nfe.total.ICMSTot).toMatchObject({ vProd: 479.2, vDesc: 47.92, vNF: 431.28, vICMS: 0 });
    expect(nfe.pag.detPag).toEqual([{ indPag: 0, tPag: '17', vPag: 431.28, card: { tpIntegra: 2 } }]);
    // Entrega pela loja: transporte próprio; o endereço vai nas informações complementares.
    expect(nfe.transp).toEqual({ modFrete: 3 });
    expect(nfe.infAdic.infCpl).toContain('Pedido nº 000042');
    expect(nfe.infAdic.infCpl).toContain('Entrega: Rua das Flores, 10 Jardim');
    expect(nfe.infAdic.infCpl).not.toMatch(/\n/);
  });

  it('em produção usa o nome real do cliente', () => {
    const payload = payloadOf(buildInvoice(input({ company: { ...company, environment: 'producao' } })));
    expect(payload.infNFe.ide.tpAmb).toBe(1);
    expect(payload.infNFe.dest.xNome).toBe('Maria da Silva');
  });

  it('venda interestadual para contribuinte troca o CFOP para 6xxx', () => {
    const buyer: FiscalClient = {
      ...client,
      person_type: 'J',
      document: '12345678000195',
      state_registration: '0012345678',
      ie_indicator: 1,
      final_consumer: false,
      address_city: 'Rio de Janeiro',
      address_city_code: '3304557',
      address_state: 'RJ',
    };
    const nfe = payloadOf(buildInvoice(input({ client: buyer }))).infNFe;
    expect(nfe.ide).toMatchObject({ idDest: 2, indFinal: 0 });
    expect(nfe.dest).toMatchObject({ CNPJ: '12345678000195', indIEDest: 1, IE: '0012345678' });
    expect(nfe.det.map((d: { prod: { CFOP: string } }) => d.prod.CFOP)).toEqual(['6102', '6405']);
  });

  it('recusa interestadual para consumidor final não contribuinte (DIFAL)', () => {
    const result = buildInvoice(input({ client: { ...client, address_city_code: '3304557', address_state: 'RJ' } }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.problems.join(' ')).toMatch(/DIFAL/);
  });

  it('lista tudo o que falta de uma vez', () => {
    const result = buildInvoice(
      input({
        company: { ...company, state_registration: null, address_city_code: null },
        client: { ...client, document: null, address_street: null },
        order: { ...input().order, items: [item({ ncm: null, icms_cst: null })], subtotal_amount: 116.7, discount_amount: 0, total_amount: 116.7 },
      }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    const text = result.problems.join('\n');
    expect(text).toMatch(/inscrição estadual da empresa/);
    expect(text).toMatch(/código IBGE do município/);
    expect(text).toMatch(/CPF ou CNPJ válido/);
    expect(text).toMatch(/logradouro/);
    expect(text).toMatch(/"Cimento CP II 50 kg": informe o NCM/);
    expect(text).toMatch(/situação tributária do ICMS/);
  });

  it('regime normal: ICMS 00 com alíquota, PIS/COFINS por alíquota e IBS/CBS do período de teste', () => {
    const normal = { ...company, tax_regime: 3 };
    const result = buildInvoice(
      input({
        company: normal,
        order: {
          ...input().order,
          discount_amount: 0,
          total_amount: 116.7,
          subtotal_amount: 116.7,
          items: [
            item({
              icms_cst: '00',
              icms_rate: 18,
              pis_cst: '01',
              pis_rate: 1.65,
              cofins_cst: '01',
              cofins_rate: 7.6,
              ibscbs_cst: '000',
              ibscbs_class: '000001',
            }),
          ],
        },
      }),
    );
    const nfe = payloadOf(result).infNFe;
    const tax = nfe.det[0].imposto;
    expect(tax.ICMS).toEqual({ ICMS00: { orig: 0, CST: '00', modBC: 3, vBC: 116.7, pICMS: 18, vICMS: 21.01 } });
    expect(tax.PIS).toEqual({ PISAliq: { CST: '01', vBC: 116.7, pPIS: 1.65, vPIS: 1.93 } });
    expect(tax.COFINS).toEqual({ COFINSAliq: { CST: '01', vBC: 116.7, pCOFINS: 7.6, vCOFINS: 8.87 } });
    // Base do IBS/CBS sem ICMS, PIS e COFINS: 116,70 - 21,01 - 1,93 - 8,87 = 84,89.
    expect(tax.IBSCBS).toMatchObject({ CST: '000', cClassTrib: '000001', gIBSCBS: { vBC: 84.89, gCBS: { pCBS: 0.9, vCBS: 0.76 } } });
    expect(nfe.total.ICMSTot).toMatchObject({ vBC: 116.7, vICMS: 21.01, vPIS: 1.93, vCOFINS: 8.87, vNF: 116.7 });
    expect(nfe.total.IBSCBSTot).toMatchObject({ vBCIBSCBS: 84.89, gCBS: { vCBS: 0.76 } });
  });
});

describe('montagem da NFC-e', () => {
  it('consumidor sem CPF: sem destinatário, sem frete e primeiro item de homologação', () => {
    const anonymous = { ...client, document: null, person_type: null };
    const nfce = payloadOf(buildInvoice(input({ model: 65, client: anonymous }))).infNFe;
    expect(nfce.ide).toMatchObject({ mod: 65, tpImp: 4, indFinal: 1, indPres: 1, idDest: 1 });
    expect(nfce.dest).toBeUndefined();
    expect(nfce.transp).toEqual({ modFrete: 9 });
    expect(nfce.det[0].prod.xProd).toBe('NOTA FISCAL EMITIDA EM AMBIENTE DE HOMOLOGACAO - SEM VALOR FISCAL');
    expect(nfce.det[1].prod.xProd).toBe('Areia média');
  });

  it('consumidor que informa o CPF sai identificado, sem endereço', () => {
    const nfce = payloadOf(buildInvoice(input({ model: 65, company: { ...company, environment: 'producao' } }))).infNFe;
    expect(nfce.dest).toEqual({ CPF: '52998224725', xNome: 'Maria da Silva', indIEDest: 9 });
  });
});
