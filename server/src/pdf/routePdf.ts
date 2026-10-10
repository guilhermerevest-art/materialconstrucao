import PDFDocument from 'pdfkit';
import { formatDateTime, formatOrderNumber, formatQuantity } from '../lib/format.js';
import { formatWhatsapp } from '../lib/phone.js';
import { pdfSafe } from './orderPdf.js';

type Doc = PDFKit.PDFDocument;

const INK = '#1B2631';
const MUTED = '#5B6670';
const RULE = '#D8DDE1';
const ACCENT = '#C2410C';
const STEEL = '#22303C';
const ZEBRA = '#F3F5F6';
const MARGIN = 40;

type RouteItem = { product_code: string | null; product_name: string; unit: string; quantity: number };

export type RoutePdfData = {
  route: {
    id: number;
    route_date: string;
    vehicle_name: string | null;
    vehicle_plate: string | null;
    driver_name: string | null;
    notes: string | null;
  };
  store: { name: string; address: string | null; phone: string | null };
  deliveries: {
    id: number;
    order_id: number;
    client_name: string;
    client_whatsapp: string;
    address: string | null;
    period: 'morning' | 'afternoon' | null;
    notes: string | null;
    order_notes: string | null;
    items: RouteItem[];
  }[];
};

const PERIOD = { morning: 'Manhã', afternoon: 'Tarde' } as const;

/** "2026-10-10" para "10/10/2026", sem fuso: a data do romaneio é o dia da loja. */
function formatDay(value: string) {
  const [year, month, day] = value.slice(0, 10).split('-');
  return `${day}/${month}/${year}`;
}

function ensureSpace(doc: Doc, y: number, needed: number, title: string): number {
  if (y + needed <= doc.page.height - MARGIN - 20) return y;
  doc.addPage();
  doc.font('Helvetica').fontSize(9).fillColor(MUTED).text(`${title} (continuação)`, MARGIN, MARGIN);
  return doc.y + 8;
}

/**
 * Romaneio de carga: uma folha para o motorista com as entregas na ordem de saída,
 * o que levar em cada uma, linha para quem recebeu assinar, e o resumo da carga
 * (soma por produto) para conferir o caminhão antes de sair.
 */
export function renderRoutePdf(data: RoutePdfData, timeZone: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const title = `Romaneio nº ${data.route.id}`;
    const doc = new PDFDocument({ size: 'A4', margin: MARGIN, bufferPages: true, info: { Title: title } });
    const chunks: Buffer[] = [];
    doc.on('data', (chunk: Buffer) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    try {
      draw(doc, data, title, timeZone);
      doc.end();
    } catch (err) {
      reject(err);
    }
  });
}

function draw(doc: Doc, data: RoutePdfData, title: string, timeZone: string) {
  const width = doc.page.width - MARGIN * 2;

  doc.font('Helvetica-Bold').fontSize(15).fillColor(INK).text(pdfSafe(data.store.name), MARGIN, MARGIN, { width: width * 0.55 });
  doc.font('Helvetica').fontSize(9).fillColor(MUTED);
  if (data.store.address) doc.text(pdfSafe(data.store.address), { width: width * 0.55 });
  if (data.store.phone) doc.text(`Telefone: ${pdfSafe(data.store.phone)}`, { width: width * 0.55 });
  const leftBottom = doc.y;

  const rightX = MARGIN + width * 0.55;
  const rightWidth = width * 0.45;
  doc.font('Helvetica-Bold').fontSize(17).fillColor(ACCENT).text(title, rightX, MARGIN, { width: rightWidth, align: 'right' });
  doc.font('Helvetica').fontSize(9.5).fillColor(INK);
  doc.text(`Data: ${formatDay(data.route.route_date)}`, rightX, doc.y + 2, { width: rightWidth, align: 'right' });
  const vehicle = [data.route.vehicle_name, data.route.vehicle_plate].filter(Boolean).join(' - ');
  if (vehicle) doc.text(`Veículo: ${pdfSafe(vehicle)}`, rightX, doc.y + 1, { width: rightWidth, align: 'right' });
  if (data.route.driver_name) doc.text(`Motorista: ${pdfSafe(data.route.driver_name)}`, rightX, doc.y + 1, { width: rightWidth, align: 'right' });
  doc.fillColor(MUTED).text(`${data.deliveries.length} entregas`, rightX, doc.y + 1, { width: rightWidth, align: 'right' });

  let y = Math.max(leftBottom, doc.y) + 10;
  doc.moveTo(MARGIN, y).lineTo(MARGIN + width, y).lineWidth(2).strokeColor(ACCENT).stroke();
  y += 12;
  if (data.route.notes) {
    doc.font('Helvetica').fontSize(9.5).fillColor(INK).text(`Observações: ${pdfSafe(data.route.notes)}`, MARGIN, y, { width });
    y = doc.y + 10;
  }

  // Resumo da carga: soma por produto, para conferir o caminhão.
  const load = new Map<string, RouteItem>();
  for (const delivery of data.deliveries) {
    for (const item of delivery.items) {
      const key = `${item.product_code ?? ''}|${item.product_name}|${item.unit}`;
      const current = load.get(key);
      if (current) current.quantity = Math.round((current.quantity + item.quantity) * 1000) / 1000;
      else load.set(key, { ...item });
    }
  }
  y = ensureSpace(doc, y, 60, title);
  doc.font('Helvetica-Bold').fontSize(10.5).fillColor(INK).text('Carga (conferir antes de sair)', MARGIN, y);
  y = doc.y + 4;
  doc.rect(MARGIN, y, width, 18).fill(STEEL);
  doc.font('Helvetica-Bold').fontSize(8.5).fillColor('#FFFFFF');
  doc.text('Código', MARGIN + 6, y + 5, { width: 70 });
  doc.text('Produto', MARGIN + 82, y + 5, { width: width - 200 });
  doc.text('Quantidade', MARGIN + width - 112, y + 5, { width: 70, align: 'right' });
  doc.text('Ok', MARGIN + width - 30, y + 5, { width: 24, align: 'center' });
  y += 18;
  [...load.values()]
    .sort((a, b) => a.product_name.localeCompare(b.product_name, 'pt-BR'))
    .forEach((item, index) => {
      y = ensureSpace(doc, y, 18, title);
      if (index % 2 === 1) doc.rect(MARGIN, y, width, 17).fill(ZEBRA);
      doc.font('Helvetica').fontSize(9).fillColor(MUTED).text(pdfSafe(item.product_code) || '-', MARGIN + 6, y + 4, { width: 70 });
      doc.fillColor(INK).text(pdfSafe(item.product_name), MARGIN + 82, y + 4, { width: width - 200, lineBreak: false, ellipsis: true });
      doc
        .font('Helvetica-Bold')
        .text(`${formatQuantity(item.quantity)} ${pdfSafe(item.unit)}`, MARGIN + width - 132, y + 4, { width: 90, align: 'right' });
      doc.rect(MARGIN + width - 24, y + 3, 11, 11).lineWidth(0.8).strokeColor(MUTED).stroke();
      y += 17;
    });
  y += 16;

  data.deliveries.forEach((delivery, index) => {
    const header = `${index + 1}. Pedido ${formatOrderNumber(delivery.order_id)} - ${pdfSafe(delivery.client_name)}`;
    const lines = [
      delivery.address ? `Endereço: ${pdfSafe(delivery.address)}` : null,
      `WhatsApp: ${formatWhatsapp(delivery.client_whatsapp)}${delivery.period ? ` · Período: ${PERIOD[delivery.period]}` : ''}`,
      delivery.notes ? `Obs. da entrega: ${pdfSafe(delivery.notes)}` : null,
      delivery.order_notes ? `Obs. do pedido: ${pdfSafe(delivery.order_notes)}` : null,
    ].filter((l): l is string => l !== null);
    doc.font('Helvetica').fontSize(9);
    const textHeight =
      lines.reduce((sum, l) => sum + doc.heightOfString(l, { width: width - 20 }) + 2, 0) + delivery.items.length * 13;
    y = ensureSpace(doc, y, textHeight + 70, title);
    const top = y;
    doc.font('Helvetica-Bold').fontSize(10.5).fillColor(INK).text(header, MARGIN + 10, y + 8, { width: width - 20 });
    y = doc.y + 3;
    doc.font('Helvetica').fontSize(9).fillColor(INK);
    for (const line of lines) {
      doc.text(line, MARGIN + 10, y, { width: width - 20 });
      y = doc.y + 2;
    }
    y += 3;
    for (const item of delivery.items) {
      doc
        .font('Helvetica-Bold')
        .text(`${formatQuantity(item.quantity)} ${pdfSafe(item.unit)}`, MARGIN + 10, y, { width: 80, continued: false });
      doc.font('Helvetica').text(`${pdfSafe(item.product_name)}${item.product_code ? ` (${pdfSafe(item.product_code)})` : ''}`, MARGIN + 92, y, {
        width: width - 102,
      });
      y = doc.y + 2;
    }
    y += 12;
    doc.font('Helvetica').fontSize(8.5).fillColor(MUTED);
    const half = (width - 30) / 2;
    doc.moveTo(MARGIN + 10, y + 12).lineTo(MARGIN + 10 + half, y + 12).lineWidth(0.6).strokeColor(MUTED).stroke();
    doc.moveTo(MARGIN + 20 + half, y + 12).lineTo(MARGIN + width - 10, y + 12).stroke();
    doc.text('Recebido por (nome e documento)', MARGIN + 10, y + 15, { width: half });
    doc.text('Assinatura', MARGIN + 20 + half, y + 15, { width: half });
    y += 32;
    doc.roundedRect(MARGIN, top, width, y - top, 4).lineWidth(1).strokeColor(RULE).stroke();
    y += 10;
  });

  drawFooters(doc, title, timeZone);
}

/** Rodapé em todas as páginas. Igual ao do pedido: sem margem inferior enquanto escreve, senão o pdfkit abre página nova. */
export function drawFooters(doc: Doc, title: string, timeZone: string) {
  const range = doc.bufferedPageRange();
  const printedAt = formatDateTime(new Date(), timeZone);
  for (let i = range.start; i < range.start + range.count; i++) {
    doc.switchToPage(i);
    const bottomMargin = doc.page.margins.bottom;
    doc.page.margins.bottom = 0;
    doc
      .font('Helvetica')
      .fontSize(8)
      .fillColor(MUTED)
      .text(`${title} · impresso em ${printedAt} · página ${i - range.start + 1} de ${range.count}`, MARGIN, doc.page.height - MARGIN - 10, {
        width: doc.page.width - MARGIN * 2,
        align: 'center',
        lineBreak: false,
      });
    doc.page.margins.bottom = bottomMargin;
  }
}
