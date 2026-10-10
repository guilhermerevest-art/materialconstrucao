import PDFDocument from 'pdfkit';
import { formatDateTime, formatDay, formatMoney } from '../lib/format.js';
import { formatWhatsapp } from '../lib/phone.js';
import { pdfSafe } from './orderPdf.js';
import { drawFooters } from './routePdf.js';

type Doc = PDFKit.PDFDocument;

const INK = '#1B2631';
const MUTED = '#5B6670';
const RULE = '#D8DDE1';
const ACCENT = '#C2410C';
const DANGER = '#B42318';
const ZEBRA = '#F3F5F6';
const MARGIN = 40;
const ROW = 20;

export type FiadoStatementEntry = {
  kind: string;
  amount: number;
  due_date: string | null;
  description: string | null;
  payment_method_name: string | null;
  created_at: Date;
  balance_after: number;
};

export type FiadoStatementData = {
  storeName: string;
  client: { name: string; whatsapp: string };
  balance: number;
  overdue: number;
  oldestOverdue: string | null;
  nextDue: string | null;
  nextDueAmount: number;
  charges: number;
  entries: FiadoStatementEntry[];
};

const KIND_LABEL: Record<string, string> = {
  purchase: 'Compra',
  charge: 'Encargos',
  payment: 'Pagamento',
  refund: 'Devolução',
  adjustment: 'Ajuste',
};

/** Extrato do fiado para entregar ou mandar ao cliente: o que comprou, pagou e quanto deve. */
export function renderFiadoPdf(data: FiadoStatementData, timeZone: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const title = `Extrato do fiado - ${pdfSafe(data.client.name)}`;
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

function draw(doc: Doc, data: FiadoStatementData, timeZone: string) {
  const width = doc.page.width - MARGIN * 2;
  doc.font('Helvetica-Bold').fontSize(17).fillColor(ACCENT).text('Extrato do fiado', MARGIN, MARGIN);
  doc.font('Helvetica-Bold').fontSize(12).fillColor(INK).text(pdfSafe(data.client.name));
  doc.font('Helvetica').fontSize(9.5).fillColor(MUTED).text(`${formatWhatsapp(data.client.whatsapp)} · ${pdfSafe(data.storeName)}`);
  doc.moveDown(0.8);

  // Resumo
  const boxY = doc.y;
  const boxW = width / 3;
  const summary: [string, string, string | null][] = [
    ['Saldo devedor', formatMoney(Math.max(0, data.balance)), data.balance < 0 ? `Crédito de ${formatMoney(-data.balance)}` : null],
    ['Vencido', formatMoney(data.overdue), data.oldestOverdue ? `desde ${formatDay(data.oldestOverdue)}` : null],
    ['Próximo vencimento', data.nextDue ? formatDay(data.nextDue) : '-', data.nextDue ? formatMoney(data.nextDueAmount) : null],
  ];
  summary.forEach(([label, value, note], i) => {
    const x = MARGIN + boxW * i;
    doc.rect(x + (i ? 4 : 0), boxY, boxW - 4, 52).strokeColor(RULE).lineWidth(0.8).stroke();
    doc.font('Helvetica').fontSize(8.5).fillColor(MUTED).text(label, x + 10, boxY + 8, { width: boxW - 20 });
    doc
      .font('Helvetica-Bold')
      .fontSize(13)
      .fillColor(i === 1 && data.overdue > 0 ? DANGER : INK)
      .text(value, x + 10, boxY + 21, { width: boxW - 20 });
    if (note) doc.font('Helvetica').fontSize(8).fillColor(MUTED).text(note, x + 10, boxY + 38, { width: boxW - 20 });
  });
  doc.y = boxY + 64;
  if (data.charges > 0) {
    doc
      .font('Helvetica')
      .fontSize(9)
      .fillColor(DANGER)
      .text(`Pagando hoje, entram ${formatMoney(data.charges)} de multa e juros pelo atraso.`, MARGIN, doc.y, { width });
    doc.moveDown(0.6);
  }

  // Lançamentos
  const cols = [
    { label: 'Data', width: 70, align: 'left' as const },
    { label: 'Lançamento', width: width - 70 - 75 - 85 - 85, align: 'left' as const },
    { label: 'Vencimento', width: 75, align: 'left' as const },
    { label: 'Valor', width: 85, align: 'right' as const },
    { label: 'Saldo', width: 85, align: 'right' as const },
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
  if (!data.entries.length) {
    doc.font('Helvetica').fontSize(9.5).fillColor(MUTED).text('Nenhum lançamento.', MARGIN + 6, doc.y + 6);
    return;
  }
  data.entries.forEach((entry) => {
    if (doc.y + ROW > doc.page.height - MARGIN - 24) {
      doc.addPage();
      header();
    }
    const y = doc.y;
    const label = [KIND_LABEL[entry.kind] ?? entry.kind, entry.description, entry.payment_method_name].filter(Boolean).join(' · ');
    const values = [
      formatDateTime(entry.created_at, timeZone).slice(0, 10),
      pdfSafe(label),
      entry.due_date && entry.amount > 0 ? formatDay(entry.due_date) : '',
      `${entry.amount < 0 ? '- ' : ''}${formatMoney(Math.abs(entry.amount))}`,
      formatMoney(entry.balance_after),
    ];
    let x = MARGIN;
    cols.forEach((col, i) => {
      doc
        .font(i === 3 ? 'Helvetica-Bold' : 'Helvetica')
        .fontSize(9)
        .fillColor(i === 3 && entry.amount < 0 ? '#15803D' : INK)
        .text(values[i]!, x + 6, y + 6, { width: col.width - 12, align: col.align, lineBreak: false, ellipsis: true });
      x += col.width;
    });
    doc.moveTo(MARGIN, y + ROW).lineTo(MARGIN + width, y + ROW).strokeColor(RULE).lineWidth(0.5).stroke();
    doc.y = y + ROW;
  });
}
