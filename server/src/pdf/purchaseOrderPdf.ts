import PDFDocument from 'pdfkit';
import { formatDay, formatMoney, formatQuantity } from '../lib/format.js';
import { formatWhatsapp } from '../lib/phone.js';
import { pdfSafe } from './orderPdf.js';
import { drawFooters } from './routePdf.js';

type Doc = PDFKit.PDFDocument;

const INK = '#1B2631';
const MUTED = '#5B6670';
const RULE = '#D8DDE1';
const ACCENT = '#C2410C';
const ZEBRA = '#F3F5F6';
const MARGIN = 40;
const ROW = 20;

export type PurchaseOrderPdfData = {
  id: number;
  created_at: Date;
  expected_date: string | null;
  notes: string | null;
  total_amount: number;
  store: { name: string; address: string | null; phone: string | null };
  supplier: { name: string; document: string | null; contact_name: string | null; whatsapp: string | null };
  items: {
    code: string | null;
    product_name: string;
    unit: string;
    quantity: number;
    unit_cost: number | null;
    purchase_unit: string | null;
    purchase_factor: number | null;
  }[];
};

export const purchaseOrderNumber = (id: number) => `PC-${String(id).padStart(5, '0')}`;

function formatDocument(digits: string | null) {
  if (!digits) return null;
  if (digits.length === 14) return digits.replace(/^(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})$/, '$1.$2.$3/$4-$5');
  if (digits.length === 11) return digits.replace(/^(\d{3})(\d{3})(\d{3})(\d{2})$/, '$1.$2.$3-$4');
  return digits;
}

/** Pedido de compra para mandar ao fornecedor: o que a loja quer, quanto e até quando. */
export function renderPurchaseOrderPdf(data: PurchaseOrderPdfData, timeZone: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const title = `Pedido de compra ${purchaseOrderNumber(data.id)}`;
    const doc = new PDFDocument({ size: 'A4', margin: MARGIN, bufferPages: true, info: { Title: title } });
    const chunks: Buffer[] = [];
    doc.on('data', (chunk: Buffer) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    try {
      draw(doc, data, timeZone);
      drawFooters(doc, title, timeZone);
      doc.end();
    } catch (err) {
      reject(err);
    }
  });
}

function draw(doc: Doc, data: PurchaseOrderPdfData, timeZone: string) {
  const width = doc.page.width - MARGIN * 2;
  doc.font('Helvetica-Bold').fontSize(17).fillColor(ACCENT).text('Pedido de compra', MARGIN, MARGIN);
  doc.font('Helvetica-Bold').fontSize(12).fillColor(INK).text(`${purchaseOrderNumber(data.id)} · ${pdfSafe(data.store.name)}`);
  const storeLine = [data.store.address, data.store.phone].filter(Boolean).map(pdfSafe).join(' · ');
  if (storeLine) doc.font('Helvetica').fontSize(9.5).fillColor(MUTED).text(storeLine);
  doc.moveDown(0.8);

  // Fornecedor e datas
  const boxY = doc.y;
  const half = width / 2;
  const supplierLines = [
    pdfSafe(data.supplier.name),
    formatDocument(data.supplier.document),
    data.supplier.contact_name ? `Contato: ${pdfSafe(data.supplier.contact_name)}` : null,
    data.supplier.whatsapp ? formatWhatsapp(data.supplier.whatsapp) : null,
  ].filter((l): l is string => Boolean(l));
  const created = new Intl.DateTimeFormat('pt-BR', { timeZone, day: '2-digit', month: '2-digit', year: 'numeric' }).format(data.created_at);
  const dateLines = [`Pedido em ${created}`, data.expected_date ? `Entregar até ${formatDay(data.expected_date)}` : 'Entrega a combinar'];
  const boxH = 22 + Math.max(supplierLines.length, dateLines.length) * 13;
  [
    ['Fornecedor', supplierLines],
    ['Entrega', dateLines],
  ].forEach(([label, lines], i) => {
    const x = MARGIN + half * i;
    doc.rect(x + (i ? 4 : 0), boxY, half - 4, boxH).strokeColor(RULE).lineWidth(0.8).stroke();
    doc.font('Helvetica').fontSize(8.5).fillColor(MUTED).text(label as string, x + 10, boxY + 8, { width: half - 24 });
    (lines as string[]).forEach((line, j) => {
      doc
        .font(j === 0 ? 'Helvetica-Bold' : 'Helvetica')
        .fontSize(j === 0 ? 10.5 : 9.5)
        .fillColor(INK)
        .text(line, x + 10, boxY + 21 + j * 13, { width: half - 24, lineBreak: false, ellipsis: true });
    });
  });
  doc.y = boxY + boxH + 14;

  // Itens
  const showCost = data.items.some((i) => i.unit_cost !== null);
  const cols = [
    { label: 'Código', width: 70, align: 'left' as const },
    { label: 'Produto', width: width - 70 - 55 - 70 - (showCost ? 160 : 0), align: 'left' as const },
    { label: 'Un.', width: 55, align: 'left' as const },
    { label: 'Quantidade', width: 70, align: 'right' as const },
    ...(showCost
      ? [
          { label: 'Custo un.', width: 75, align: 'right' as const },
          { label: 'Total', width: 85, align: 'right' as const },
        ]
      : []),
  ];
  const header = () => {
    const y = doc.y;
    doc.rect(MARGIN, y, width, ROW).fill(ZEBRA);
    let x = MARGIN;
    doc.font('Helvetica-Bold').fontSize(8.5).fillColor(MUTED);
    for (const col of cols) {
      doc.text(col.label, x + 6, y + 6, { width: col.width - 12, align: col.align, lineBreak: false });
      x += col.width;
    }
    doc.y = y + ROW;
  };
  header();
  for (const item of data.items) {
    if (doc.y + ROW > doc.page.height - MARGIN - 24) {
      doc.addPage();
      header();
    }
    const y = doc.y;
    // Na unidade de compra (o fornecedor vende em sacos): quantidade e custo por saco.
    const factor = item.purchase_unit && item.purchase_factor ? item.purchase_factor : null;
    const quantity = factor ? Math.round((item.quantity / factor) * 1000) / 1000 : item.quantity;
    const unitCost = item.unit_cost !== null && factor ? Math.round(item.unit_cost * factor * 100) / 100 : item.unit_cost;
    const name = factor ? `${item.product_name} (${formatQuantity(factor)} ${item.unit})` : item.product_name;
    const values = [
      pdfSafe(item.code ?? ''),
      pdfSafe(name),
      pdfSafe(factor ? item.purchase_unit! : item.unit),
      formatQuantity(quantity),
      ...(showCost
        ? [
            unitCost !== null ? formatMoney(unitCost) : '',
            item.unit_cost !== null ? formatMoney(Math.round(item.quantity * item.unit_cost * 100) / 100) : '',
          ]
        : []),
    ];
    let x = MARGIN;
    cols.forEach((col, i) => {
      doc
        .font(i === 3 ? 'Helvetica-Bold' : 'Helvetica')
        .fontSize(9)
        .fillColor(INK)
        .text(values[i]!, x + 6, y + 6, { width: col.width - 12, align: col.align, lineBreak: false, ellipsis: true });
      x += col.width;
    });
    doc.moveTo(MARGIN, y + ROW).lineTo(MARGIN + width, y + ROW).strokeColor(RULE).lineWidth(0.5).stroke();
    doc.y = y + ROW;
  }
  if (showCost) {
    doc.moveDown(0.6);
    doc
      .font('Helvetica-Bold')
      .fontSize(11)
      .fillColor(INK)
      .text(`Total estimado: ${formatMoney(data.total_amount)}`, MARGIN, doc.y, { width, align: 'right' });
  }
  if (data.notes) {
    doc.moveDown(0.8);
    doc.font('Helvetica-Bold').fontSize(9).fillColor(MUTED).text('Observações', MARGIN, doc.y, { width });
    doc.font('Helvetica').fontSize(9.5).fillColor(INK).text(pdfSafe(data.notes), { width });
  }
}
