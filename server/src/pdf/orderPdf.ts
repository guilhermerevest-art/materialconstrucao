import PDFDocument from 'pdfkit';
import { documentLabel, formatDateTime, formatMoney, formatOrderNumber, formatPercent, formatQuantity } from '../lib/format.js';
import { formatWhatsapp } from '../lib/phone.js';
import type { OrderDetail, OrderPdfDetail, StoreLogo } from '../orders/queries.js';

type Doc = PDFKit.PDFDocument;

const INK = '#1B2631';
const MUTED = '#5B6670';
const RULE = '#D8DDE1';
const ACCENT = '#C2410C';
const STEEL = '#22303C';
const ZEBRA = '#F3F5F6';
const TAG = '#FFD233';

const MARGIN = 40;
const FOOTER_SPACE = 34;
const CELL_PAD_X = 6;
const CELL_PAD_Y = 5;
const ROW_FONT_SIZE = 9.5;
const LOGO_BOX = 64;
const LOGO_GAP = 12;
const STORE_NAME_SIZE = 16;

type Align = 'left' | 'right' | 'center';
const COLUMNS: { label: string; width: number; align: Align }[] = [
  { label: 'Código', width: 62, align: 'left' },
  { label: 'Descrição', width: 213, align: 'left' },
  { label: 'Un.', width: 34, align: 'center' },
  { label: 'Qtd.', width: 52, align: 'right' },
  { label: 'Preço unit.', width: 72, align: 'right' },
  { label: 'Subtotal', width: 82, align: 'right' },
];

// As fontes padrão do PDF (Helvetica) só cobrem o conjunto WinAnsi. Acentos do
// português estão nele; emojis e outros símbolos são removidos para não sair lixo.
const WIN_ANSI_EXTRAS = new Set('€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ');
export function pdfSafe(value: string | null | undefined): string {
  if (!value) return '';
  return value
    .normalize('NFC')
    .replace(/[^\n -~ -ÿ]/gu, (ch) => (WIN_ANSI_EXTRAS.has(ch) ? ch : ''));
}

export function orderFileName(order: Pick<OrderPdfDetail, 'id' | 'status'>) {
  return `${order.status === 'quote' ? 'orcamento' : 'pedido'}-${formatOrderNumber(order.id)}.pdf`;
}

export function renderOrderPdf(order: OrderPdfDetail, timeZone: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const label = documentLabel(order.status, order.cancelled_from);
    const doc = new PDFDocument({
      size: 'A4',
      margin: MARGIN,
      bufferPages: true,
      info: { Title: `${label} ${formatOrderNumber(order.id)}`, Author: pdfSafe(order.store_name) },
    });
    const chunks: Buffer[] = [];
    doc.on('data', (chunk: Buffer) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    try {
      drawDocument(doc, order, timeZone);
      doc.end();
    } catch (err) {
      reject(err);
    }
  });
}

function contentBottom(doc: Doc) {
  return doc.page.height - MARGIN - FOOTER_SPACE;
}

function drawDocument(doc: Doc, order: OrderPdfDetail, timeZone: string) {
  let y = drawHeader(doc, order, timeZone);
  y = drawParties(doc, order, y + 16);
  y = drawItems(doc, order, y + 18);
  y = drawTotal(doc, order, y + 12);
  if (order.delivery_address) y = drawTextBox(doc, 'Endereço de entrega', order.delivery_address, y + 16);
  if (order.notes) drawTextBox(doc, 'Observações', order.notes, y + 16);
  drawFooters(doc, timeZone);
}

/**
 * Desenha a logo numa caixa fixa e devolve true. Logo ausente, corrompida ou de um
 * formato que o pdfkit não embute (webp) não pode derrubar a geração do orçamento:
 * nesses casos devolvemos false e o cabeçalho sai no layout sem logo.
 */
function drawStoreLogo(doc: Doc, logo: StoreLogo | null, x: number, y: number): boolean {
  if (!logo) return false;
  try {
    doc.image(Buffer.from(logo.data, 'base64'), x, y, { fit: [LOGO_BOX, LOGO_BOX] });
    return true;
  } catch (err) {
    console.error('Logo da loja não pôde ser desenhada no PDF, seguindo sem ela:', err);
    return false;
  }
}

function drawHeader(doc: Doc, order: OrderPdfDetail, timeZone: string): number {
  const left = MARGIN;
  const width = doc.page.width - MARGIN * 2;
  const storeWidth = width * 0.6;
  const docX = left + storeWidth;
  const docWidth = width - storeWidth;

  const hasLogo = drawStoreLogo(doc, order.store_logo, left, MARGIN);
  // Sem logo o texto da loja continua no canto, exatamente onde estava antes.
  const textLeft = left + (hasLogo ? LOGO_BOX + LOGO_GAP : 0);
  const textWidth = storeWidth - (textLeft - left);

  const name = pdfSafe(order.store_name);
  doc.font('Helvetica-Bold').fontSize(STORE_NAME_SIZE).fillColor(INK);
  const nameY = hasLogo ? MARGIN + Math.max(0, (LOGO_BOX - doc.heightOfString(name, { width: textWidth })) / 2) : MARGIN;
  doc.text(name, textLeft, nameY, { width: textWidth });
  doc.font('Helvetica').fontSize(9).fillColor(MUTED);
  if (order.store_address) doc.text(pdfSafe(order.store_address), textLeft, doc.y + 3, { width: textWidth });
  if (order.store_phone) doc.text(`Telefone: ${pdfSafe(order.store_phone)}`, textLeft, doc.y + 1, { width: textWidth });
  const storeBottom = hasLogo ? Math.max(doc.y, MARGIN + LOGO_BOX) : doc.y;

  doc.font('Helvetica-Bold').fontSize(18).fillColor(ACCENT).text(documentLabel(order.status, order.cancelled_from), docX, MARGIN, {
    width: docWidth,
    align: 'right',
  });
  doc.font('Helvetica-Bold').fontSize(11).fillColor(INK).text(`Nº ${formatOrderNumber(order.id)}`, docX, doc.y + 1, {
    width: docWidth,
    align: 'right',
  });
  doc.font('Helvetica').fontSize(9).fillColor(MUTED);
  doc.text(`Emitido em ${formatDateTime(order.created_at, timeZone)}`, docX, doc.y + 3, { width: docWidth, align: 'right' });
  if (order.status === 'order' && order.confirmed_at) {
    doc.text(`Confirmado em ${formatDateTime(order.confirmed_at, timeZone)}`, docX, doc.y + 1, {
      width: docWidth,
      align: 'right',
    });
  }

  const bottom = Math.max(storeBottom, doc.y) + 10;
  doc.moveTo(left, bottom).lineTo(left + width, bottom).lineWidth(2).strokeColor(ACCENT).stroke();
  return bottom;
}

function drawInfoBox(doc: Doc, x: number, y: number, width: number, title: string, lines: [string, string][]): number {
  const pad = 10;
  const labelWidth = 62;
  const valueWidth = width - pad * 2 - labelWidth;

  doc.font('Helvetica-Bold').fontSize(9).fillColor(MUTED).text(title, x + pad, y + pad, { width: width - pad * 2 });
  let cursor = doc.y + 4;
  for (const [label, value] of lines) {
    doc.font('Helvetica').fontSize(9.5).fillColor(MUTED).text(label, x + pad, cursor, { width: labelWidth });
    doc.font('Helvetica-Bold').fontSize(9.5).fillColor(INK).text(pdfSafe(value), x + pad + labelWidth, cursor, {
      width: valueWidth,
    });
    cursor = doc.y + 3;
  }
  const height = cursor - y + pad - 3;
  return height;
}

function drawParties(doc: Doc, order: OrderDetail, y: number): number {
  const left = MARGIN;
  const width = doc.page.width - MARGIN * 2;
  const gap = 16;
  const boxWidth = (width - gap) / 2;

  const clientHeight = drawInfoBox(doc, left, y, boxWidth, 'Cliente', [
    ['Nome', order.client_name],
    ['WhatsApp', formatWhatsapp(order.client_whatsapp)],
  ]);
  const service: [string, string][] = [
    ['Vendedor', order.user_name],
    ['Loja', order.store_name],
  ];
  if (order.payment_method_name) service.push(['Pagamento', order.payment_method_name]);
  const serviceHeight = drawInfoBox(doc, left + boxWidth + gap, y, boxWidth, 'Atendimento', service);
  const height = Math.max(clientHeight, serviceHeight);
  doc.lineWidth(1).strokeColor(RULE);
  doc.roundedRect(left, y, boxWidth, height, 4).stroke();
  doc.roundedRect(left + boxWidth + gap, y, boxWidth, height, 4).stroke();
  return y + height;
}

function drawTableHeader(doc: Doc, y: number): number {
  const height = 20;
  let x = MARGIN;
  doc.rect(MARGIN, y, doc.page.width - MARGIN * 2, height).fill(STEEL);
  doc.font('Helvetica-Bold').fontSize(8.5).fillColor('#FFFFFF');
  for (const col of COLUMNS) {
    doc.text(col.label, x + CELL_PAD_X, y + 6, { width: col.width - CELL_PAD_X * 2, align: col.align, lineBreak: false });
    x += col.width;
  }
  return y + height;
}

function drawItems(doc: Doc, order: OrderDetail, startY: number): number {
  let y = drawTableHeader(doc, startY);
  const tableWidth = doc.page.width - MARGIN * 2;

  order.items.forEach((item, index) => {
    const cells = [
      pdfSafe(item.product_code) || '-',
      pdfSafe(item.product_name),
      pdfSafe(item.unit),
      formatQuantity(item.quantity),
      formatMoney(item.unit_price),
      formatMoney(item.subtotal),
    ];
    doc.font('Helvetica').fontSize(ROW_FONT_SIZE);
    const textHeight = Math.max(
      ...cells.map((text, i) => doc.heightOfString(text, { width: COLUMNS[i]!.width - CELL_PAD_X * 2 })),
    );
    const rowHeight = textHeight + CELL_PAD_Y * 2;

    if (y + rowHeight > contentBottom(doc)) {
      doc.addPage();
      // Identifica a folha caso as páginas impressas se separem.
      doc
        .font('Helvetica')
        .fontSize(9)
        .fillColor(MUTED)
        .text(`${documentLabel(order.status, order.cancelled_from)} nº ${formatOrderNumber(order.id)} (continuação)`, MARGIN, MARGIN, {
          width: tableWidth,
        });
      y = drawTableHeader(doc, doc.y + 6);
    }

    if (index % 2 === 1) doc.rect(MARGIN, y, tableWidth, rowHeight).fill(ZEBRA);

    let x = MARGIN;
    cells.forEach((text, i) => {
      const col = COLUMNS[i]!;
      const bold = i === 5;
      doc
        .font(bold ? 'Helvetica-Bold' : 'Helvetica')
        .fontSize(ROW_FONT_SIZE)
        .fillColor(INK)
        .text(text, x + CELL_PAD_X, y + CELL_PAD_Y, { width: col.width - CELL_PAD_X * 2, align: col.align });
      x += col.width;
    });
    y += rowHeight;
  });

  doc.moveTo(MARGIN, y).lineTo(MARGIN + tableWidth, y).lineWidth(1).strokeColor(RULE).stroke();
  return y;
}

function drawTotal(doc: Doc, order: OrderDetail, startY: number): number {
  const boxWidth = 230;
  const boxHeight = 46;
  const hasDiscount = order.discount_amount > 0;
  const breakdownHeight = hasDiscount ? 34 : 0;
  let y = startY;
  if (y + breakdownHeight + boxHeight > contentBottom(doc)) {
    doc.addPage();
    y = MARGIN;
  }
  const right = doc.page.width - MARGIN;
  const x = right - boxWidth;

  if (hasDiscount) {
    const discountLabel =
      order.discount_type === 'percent' ? `Desconto (${formatPercent(order.discount_value ?? 0)})` : 'Desconto';
    const rows: [string, string][] = [
      ['Subtotal', formatMoney(order.subtotal_amount)],
      [discountLabel, `- ${formatMoney(order.discount_amount)}`],
    ];
    rows.forEach(([label, value], index) => {
      const rowY = y + index * 15;
      doc.font('Helvetica').fontSize(9.5).fillColor(MUTED).text(label, x + 14, rowY, { width: 120 });
      doc.font('Helvetica-Bold').fontSize(9.5).fillColor(INK).text(value, x + 70, rowY, { width: boxWidth - 84, align: 'right' });
    });
    y += breakdownHeight;
  }

  const count = order.items.length;
  doc
    .font('Helvetica')
    .fontSize(9.5)
    .fillColor(MUTED)
    .text(`${count} ${count === 1 ? 'item' : 'itens'}`, MARGIN, y + 17, { width: x - MARGIN - 12 });

  doc.roundedRect(x, y, boxWidth, boxHeight, 4).fill(TAG);
  doc.font('Helvetica-Bold').fontSize(10).fillColor(INK).text('Total', x + 14, y + 17, { width: 60 });
  doc
    .font('Helvetica-Bold')
    .fontSize(18)
    .fillColor(INK)
    .text(formatMoney(order.total_amount), x + 70, y + 13, { width: boxWidth - 84, align: 'right' });
  return y + boxHeight;
}

/** Quadro de texto livre (endereço de entrega, observações). Devolve onde ele termina. */
function drawTextBox(doc: Doc, title: string, content: string, startY: number): number {
  const width = doc.page.width - MARGIN * 2;
  const pad = 10;
  const text = pdfSafe(content);
  doc.font('Helvetica').fontSize(9.5);
  const textHeight = doc.heightOfString(text, { width: width - pad * 2 });
  const boxHeight = textHeight + pad * 2 + 16;
  let y = startY;
  if (y + boxHeight > contentBottom(doc)) {
    doc.addPage();
    y = MARGIN;
  }
  doc.lineWidth(1).strokeColor(RULE).roundedRect(MARGIN, y, width, boxHeight, 4).stroke();
  doc.font('Helvetica-Bold').fontSize(9).fillColor(MUTED).text(title, MARGIN + pad, y + pad, { width: width - pad * 2 });
  doc
    .font('Helvetica')
    .fontSize(9.5)
    .fillColor(INK)
    .text(text, MARGIN + pad, doc.y + 4, { width: width - pad * 2 });
  return y + boxHeight;
}

function drawFooters(doc: Doc, timeZone: string) {
  const range = doc.bufferedPageRange();
  const generatedAt = formatDateTime(new Date(), timeZone);
  for (let i = range.start; i < range.start + range.count; i++) {
    doc.switchToPage(i);
    const width = doc.page.width - MARGIN * 2;
    const y = doc.page.height - MARGIN - 14;
    // Sem margem inferior durante o rodapé; senão o pdfkit abre uma página nova.
    const bottomMargin = doc.page.margins.bottom;
    doc.page.margins.bottom = 0;
    doc.moveTo(MARGIN, y - 8).lineTo(MARGIN + width, y - 8).lineWidth(0.5).strokeColor(RULE).stroke();
    doc
      .font('Helvetica')
      .fontSize(8)
      .fillColor(MUTED)
      .text(`Documento sem valor fiscal. Gerado em ${generatedAt}.`, MARGIN, y, { width: width * 0.75, lineBreak: false });
    doc.text(`Página ${i - range.start + 1} de ${range.count}`, MARGIN + width * 0.75, y, {
      width: width * 0.25,
      align: 'right',
      lineBreak: false,
    });
    doc.page.margins.bottom = bottomMargin;
  }
}
