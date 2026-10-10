import PDFDocument from 'pdfkit';
import { formatDateTime, formatOrderNumber, formatQuantity } from '../lib/format.js';
import { formatWhatsapp } from '../lib/phone.js';
import { pdfSafe } from './orderPdf.js';
import { drawFooters } from './routePdf.js';

type Doc = PDFKit.PDFDocument;

const INK = '#1B2631';
const MUTED = '#5B6670';
const RULE = '#D8DDE1';
const ACCENT = '#C2410C';
const STEEL = '#22303C';
const ZEBRA = '#F3F5F6';
const MARGIN = 40;
const ROW = 22;

export type SeparationItem = {
  order_item_id: number;
  product_id: number;
  product_code: string | null;
  product_name: string;
  unit: string;
  quantity: number;
};

export type SeparationPdfData = {
  order: {
    id: number;
    client_name: string;
    client_whatsapp: string;
    store_name: string;
    user_name: string;
    delivery_address: string | null;
    notes: string | null;
    confirmed_at: Date | null;
  };
  delivery: { id: number; kind: 'pickup' | 'delivery'; scheduled_date: string | null; period: string | null; address: string | null } | null;
  items: SeparationItem[];
};

const PERIOD: Record<string, string> = { morning: 'manhã', afternoon: 'tarde' };

/**
 * Lista de separação para o depósito: o que pegar, com caixa para marcar e espaço
 * para quem separou e quem conferiu. Sem preços: quem separa não precisa deles.
 */
export function renderSeparationPdf(data: SeparationPdfData, timeZone: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const title = `Separação do pedido ${formatOrderNumber(data.order.id)}`;
    const doc = new PDFDocument({ size: 'A4', margin: MARGIN, bufferPages: true, info: { Title: title } });
    const chunks: Buffer[] = [];
    doc.on('data', (chunk: Buffer) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    try {
      draw(doc, data, title, timeZone);
      drawFooters(doc, title, timeZone);
      doc.end();
    } catch (err) {
      reject(err);
    }
  });
}

function draw(doc: Doc, data: SeparationPdfData, title: string, timeZone: string) {
  const width = doc.page.width - MARGIN * 2;
  const { order, delivery } = data;

  doc.font('Helvetica-Bold').fontSize(17).fillColor(ACCENT).text('Lista de separação', MARGIN, MARGIN, { width: width * 0.6 });
  doc.font('Helvetica-Bold').fontSize(12).fillColor(INK).text(`Pedido nº ${formatOrderNumber(order.id)}`, { width: width * 0.6 });
  doc.font('Helvetica').fontSize(9.5).fillColor(INK);
  doc.text(`Cliente: ${pdfSafe(order.client_name)} · ${formatWhatsapp(order.client_whatsapp)}`, { width: width * 0.6 });
  doc.fillColor(MUTED).text(`${pdfSafe(order.store_name)} · vendedor ${pdfSafe(order.user_name)}`, { width: width * 0.6 });
  const leftBottom = doc.y;

  const rightX = MARGIN + width * 0.6;
  const rightWidth = width * 0.4;
  const kind = delivery ? (delivery.kind === 'pickup' ? 'Retirada na loja' : 'Entrega') : order.delivery_address ? 'Entrega' : 'Retirada na loja';
  doc.font('Helvetica-Bold').fontSize(13).fillColor(INK).text(kind, rightX, MARGIN, { width: rightWidth, align: 'right' });
  doc.font('Helvetica').fontSize(9.5).fillColor(INK);
  if (delivery?.scheduled_date) {
    const [y, m, d] = delivery.scheduled_date.slice(0, 10).split('-');
    doc.text(`Dia ${d}/${m}/${y}${delivery.period ? `, ${PERIOD[delivery.period] ?? ''}` : ''}`, rightX, doc.y + 2, {
      width: rightWidth,
      align: 'right',
    });
  }
  if (!delivery) doc.fillColor(MUTED).text('Tudo o que falta sair do pedido', rightX, doc.y + 2, { width: rightWidth, align: 'right' });

  let y = Math.max(leftBottom, doc.y) + 10;
  doc.moveTo(MARGIN, y).lineTo(MARGIN + width, y).lineWidth(2).strokeColor(ACCENT).stroke();
  y += 10;

  const address = delivery ? delivery.address : order.delivery_address;
  if (address) {
    doc.font('Helvetica-Bold').fontSize(9).fillColor(MUTED).text('Endereço', MARGIN, y);
    doc.font('Helvetica').fontSize(9.5).fillColor(INK).text(pdfSafe(address), MARGIN, doc.y + 1, { width });
    y = doc.y + 8;
  }

  // Tabela: caixa de marcar, código, produto, quantidade, unidade.
  const cols = { check: 26, code: 80, qty: 80, unit: 40 };
  const nameWidth = width - cols.check - cols.code - cols.qty - cols.unit;
  const header = () => {
    doc.rect(MARGIN, y, width, 20).fill(STEEL);
    doc.font('Helvetica-Bold').fontSize(8.5).fillColor('#FFFFFF');
    doc.text('Código', MARGIN + cols.check + 4, y + 6, { width: cols.code - 8 });
    doc.text('Produto', MARGIN + cols.check + cols.code, y + 6, { width: nameWidth - 8 });
    doc.text('Quantidade', MARGIN + cols.check + cols.code + nameWidth, y + 6, { width: cols.qty - 8, align: 'right' });
    doc.text('Un.', MARGIN + width - cols.unit, y + 6, { width: cols.unit - 6, align: 'center' });
    y += 20;
  };
  header();
  data.items.forEach((item, index) => {
    doc.font('Helvetica').fontSize(10);
    const nameHeight = doc.heightOfString(pdfSafe(item.product_name), { width: nameWidth - 8 });
    const height = Math.max(ROW, nameHeight + 10);
    if (y + height > doc.page.height - MARGIN - 90) {
      doc.addPage();
      doc.font('Helvetica').fontSize(9).fillColor(MUTED).text(`${title} (continuação)`, MARGIN, MARGIN);
      y = doc.y + 6;
      header();
    }
    if (index % 2 === 1) doc.rect(MARGIN, y, width, height).fill(ZEBRA);
    doc.rect(MARGIN + 8, y + (height - 12) / 2, 12, 12).lineWidth(0.9).strokeColor(MUTED).stroke();
    doc.font('Helvetica').fontSize(9.5).fillColor(MUTED).text(pdfSafe(item.product_code) || '-', MARGIN + cols.check + 4, y + 6, {
      width: cols.code - 8,
    });
    doc.font('Helvetica').fontSize(10).fillColor(INK).text(pdfSafe(item.product_name), MARGIN + cols.check + cols.code, y + 5, {
      width: nameWidth - 8,
    });
    doc.font('Helvetica-Bold').fontSize(11).text(formatQuantity(item.quantity), MARGIN + cols.check + cols.code + nameWidth, y + 5, {
      width: cols.qty - 8,
      align: 'right',
    });
    doc.font('Helvetica').fontSize(9.5).fillColor(MUTED).text(pdfSafe(item.unit), MARGIN + width - cols.unit, y + 6, {
      width: cols.unit - 6,
      align: 'center',
    });
    y += height;
  });
  doc.moveTo(MARGIN, y).lineTo(MARGIN + width, y).lineWidth(1).strokeColor(RULE).stroke();
  y += 14;

  if (order.notes) {
    doc.font('Helvetica-Bold').fontSize(9).fillColor(MUTED).text('Observações do pedido', MARGIN, y);
    doc.font('Helvetica').fontSize(9.5).fillColor(INK).text(pdfSafe(order.notes), MARGIN, doc.y + 1, { width });
    y = doc.y + 14;
  }

  if (y > doc.page.height - MARGIN - 80) {
    doc.addPage();
    y = MARGIN;
  }
  const half = (width - 20) / 2;
  doc.moveTo(MARGIN, y + 30).lineTo(MARGIN + half, y + 30).lineWidth(0.6).strokeColor(MUTED).stroke();
  doc.moveTo(MARGIN + half + 20, y + 30).lineTo(MARGIN + width, y + 30).stroke();
  doc.font('Helvetica').fontSize(8.5).fillColor(MUTED);
  doc.text('Separado por', MARGIN, y + 34, { width: half });
  doc.text('Conferido por', MARGIN + half + 20, y + 34, { width: half });
  if (order.confirmed_at) {
    doc.text(`Pedido confirmado em ${formatDateTime(order.confirmed_at, timeZone)}`, MARGIN, y + 52, { width });
  }
}
