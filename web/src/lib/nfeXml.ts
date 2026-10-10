/** Item da NF-e de compra, como veio do fornecedor. */
export type NfeItem = {
  /** Código do produto no fornecedor (cProd). */
  code: string;
  /** Código de barras (cEAN); nulo quando a nota diz "SEM GTIN". */
  ean: string | null;
  name: string;
  /** Unidade comercial da nota (uCom). */
  unit: string;
  quantity: number;
  unitPrice: number;
  /** Valor do item já com desconto e acrescido de frete, seguro e outras despesas rateados na nota. */
  total: number;
};

export type NfeInvoice = {
  accessKey: string | null;
  number: string | null;
  series: string | null;
  issuedAt: string | null;
  supplierDocument: string | null;
  supplierName: string | null;
  total: number | null;
  items: NfeItem[];
};

const text = (parent: Element | Document | null | undefined, tag: string) =>
  parent?.getElementsByTagName(tag)[0]?.textContent?.trim() || null;

const number = (value: string | null) => {
  const parsed = value === null ? NaN : Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
};

/**
 * Lê o XML da NF-e (com ou sem o envelope nfeProc). A nota é lida no navegador:
 * o servidor recebe só os itens já conferidos pela pessoa, como num lançamento manual.
 */
export function parseNfeXml(xml: string): NfeInvoice {
  const doc = new DOMParser().parseFromString(xml, 'application/xml');
  if (doc.getElementsByTagName('parsererror').length) throw new Error('O arquivo não é um XML válido.');
  const infNFe = doc.getElementsByTagName('infNFe')[0];
  if (!infNFe) throw new Error('O arquivo não parece ser uma NF-e (falta o bloco infNFe).');

  const ide = infNFe.getElementsByTagName('ide')[0];
  const emit = infNFe.getElementsByTagName('emit')[0];
  const accessKey =
    text(doc, 'chNFe') ?? (infNFe.getAttribute('Id')?.replace(/^NFe/, '') || null);

  const items = [...infNFe.getElementsByTagName('det')].map((det): NfeItem => {
    const prod = det.getElementsByTagName('prod')[0];
    const ean = text(prod, 'cEAN');
    const gross = number(text(prod, 'vProd'));
    // O que a loja pagou de fato pelo item: com desconto e despesas rateadas.
    const total = gross - number(text(prod, 'vDesc')) + number(text(prod, 'vFrete')) + number(text(prod, 'vSeg')) + number(text(prod, 'vOutro'));
    return {
      code: text(prod, 'cProd') ?? '',
      ean: ean && /^\d{8,14}$/.test(ean) ? ean : null,
      name: text(prod, 'xProd') ?? '',
      unit: (text(prod, 'uCom') ?? '').toUpperCase(),
      quantity: number(text(prod, 'qCom')),
      unitPrice: number(text(prod, 'vUnCom')),
      total: Math.round(total * 100) / 100,
    };
  });
  if (!items.length) throw new Error('A nota não tem itens.');

  const icmsTot = infNFe.getElementsByTagName('ICMSTot')[0];
  return {
    accessKey: accessKey && /^\d{44}$/.test(accessKey) ? accessKey : null,
    number: text(ide, 'nNF'),
    series: text(ide, 'serie'),
    issuedAt: text(ide, 'dhEmi') ?? text(ide, 'dEmi'),
    supplierDocument: text(emit, 'CNPJ') ?? text(emit, 'CPF'),
    supplierName: text(emit, 'xNome'),
    total: icmsTot ? number(text(icmsTot, 'vNF')) : null,
    items,
  };
}
