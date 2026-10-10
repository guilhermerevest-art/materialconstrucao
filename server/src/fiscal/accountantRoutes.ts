import { Router } from 'express';
import type pg from 'pg';
import { z } from 'zod';
import { currentUser, requireAdmin, type AuthUser } from '../auth.js';
import type { AppContext } from '../context.js';
import { withSession } from '../db/session.js';
import { HttpError } from '../errors.js';
import { createZip, type ZipFile } from '../lib/zip.js';
import { describeAcbrError, type AcbrClient } from './acbr.js';
import { acbrClientFor, loadFiscalSettings, modelPath, requireCnpj, type FiscalSettingsRow } from './common.js';
import type { InvoiceModel } from './invoice.js';

const monthSchema = z.object({
  month: z.string('Escolha o mês.').regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'Mês inválido. Use AAAA-MM.'),
});

/** XMLs baixados da ACBr API por chamada: cabe no tempo de uma requisição. */
const BATCH = 25;

type Issued = {
  id: number;
  model: InvoiceModel;
  series: number;
  number: number;
  status: string;
  access_key: string | null;
  acbr_id: string | null;
  total_amount: number;
  recipient_name: string | null;
  recipient_document: string | null;
  issued_at: Date | null;
  cancel_reason: string | null;
  has_xml: boolean;
};

type Received = {
  source: 'entry' | 'inbound';
  id: number;
  access_key: string;
  number: string | null;
  series: string | null;
  issuer_name: string | null;
  issuer_document: string | null;
  amount: number | null;
  issued_at: Date | null;
  entered_at: Date | null;
  cancelled: boolean;
  /** XML guardado: o da entrada ou, sem ele, o da nota do monitor com a mesma chave. */
  has_xml: boolean;
  /** Dá para baixar da ACBr API (nota completa do monitor ainda sem XML guardado). */
  fetchable_inbound_id: number | null;
};

/** Primeiro dia do mês e do mês seguinte. */
function monthRange(month: string) {
  const [year, m] = month.split('-').map(Number) as [number, number];
  const next = m === 12 ? `${year + 1}-01-01` : `${year}-${String(m + 1).padStart(2, '0')}-01`;
  return { from: `${month}-01`, to: next };
}

/**
 * Notas do mês no ambiente atual da empresa: as emitidas (autorizadas, canceladas,
 * denegadas e inutilizadas, pela data de emissão) e as recebidas (as que deram entrada
 * no estoque no mês, mais as do monitor emitidas no mês que ainda não deram entrada).
 */
async function loadMonth(db: pg.PoolClient, environment: string, month: string, timeZone: string) {
  const { from, to } = monthRange(month);
  const inMonth = (column: string) =>
    `${column} >= ($2::date)::timestamp at time zone $4 and ${column} < ($3::date)::timestamp at time zone $4`;
  const issued = await db.query<Issued>(
    `select id, model, series, number, status, access_key, acbr_id, total_amount, recipient_name, recipient_document,
            coalesce(issued_at, authorized_at, created_at) as issued_at, cancel_reason, (xml is not null) as has_xml
       from fiscal_documents
      where environment = $1 and status in ('autorizado', 'cancelado', 'denegado', 'inutilizado')
        and ${inMonth('coalesce(issued_at, authorized_at, created_at)')}
      order by model, series, number`,
    [environment, from, to, timeZone],
  );
  const received = await db.query<Received>(
    `select 'entry' as source, e.id, e.access_key, e.invoice_number as number, e.invoice_series as series,
            e.supplier_name as issuer_name, e.supplier_document as issuer_document, e.total_amount as amount,
            e.issued_at, e.created_at as entered_at, coalesce(i.cancelled, false) as cancelled,
            (e.xml is not null or i.xml is not null) as has_xml,
            case when e.xml is null and i.xml is null and not i.summary then i.id end as fetchable_inbound_id
       from stock_entries e
       left join fiscal_inbound_documents i on i.access_key = e.access_key and i.environment = $1
      where e.access_key is not null and ${inMonth('e.created_at')}
     union all
     select 'inbound', i.id, i.access_key, null, null, i.issuer_name, i.issuer_document, i.amount,
            i.issued_at, null, i.cancelled, (i.xml is not null),
            case when i.xml is null and not i.summary then i.id end
       from fiscal_inbound_documents i
      where i.environment = $1 and ${inMonth('coalesce(i.issued_at, i.created_at)')}
        and not exists (select 1 from stock_entries e where e.access_key = i.access_key)
      order by issued_at nulls last, access_key`,
    [environment, from, to, timeZone],
  );
  return { issued: issued.rows, received: received.rows };
}

function summarize(data: Awaited<ReturnType<typeof loadMonth>>) {
  const fetchableIssued = data.issued.filter((d) => !d.has_xml && d.acbr_id && (d.status === 'autorizado' || d.status === 'cancelado'));
  return {
    issued: {
      authorized: data.issued.filter((d) => d.status === 'autorizado').length,
      cancelled: data.issued.filter((d) => d.status === 'cancelado').length,
      other: data.issued.filter((d) => d.status === 'denegado' || d.status === 'inutilizado').length,
      authorized_amount: Math.round(data.issued.filter((d) => d.status === 'autorizado').reduce((s, d) => s + d.total_amount, 0) * 100) / 100,
    },
    received: {
      count: data.received.length,
      amount: Math.round(data.received.reduce((s, d) => s + (d.amount ?? 0), 0) * 100) / 100,
    },
    // Ainda dá para baixar da ACBr API (o "Preparar" baixa) e o que não tem como (entrada à mão de nota sem XML).
    to_download: fetchableIssued.length + data.received.filter((d) => d.fetchable_inbound_id !== null).length,
    without_xml: data.received.filter((d) => !d.has_xml && d.fetchable_inbound_id === null).length,
  };
}

const formatDocument = (digits: string | null) => {
  if (!digits) return '';
  if (digits.length === 14) return digits.replace(/^(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})$/, '$1.$2.$3/$4-$5');
  if (digits.length === 11) return digits.replace(/^(\d{3})(\d{3})(\d{3})(\d{2})$/, '$1.$2.$3-$4');
  return digits;
};

const STATUS_LABEL: Record<string, string> = {
  autorizado: 'Autorizada',
  cancelado: 'Cancelada',
  denegado: 'Denegada',
  inutilizado: 'Inutilizada',
};

/** Baixa o XML da nota emitida e guarda. Falha não interrompe o lote. */
async function fetchIssuedXml(acbr: AcbrClient, doc: Issued) {
  const file = await acbr.download(`/${modelPath(doc.model)}/${encodeURIComponent(doc.acbr_id!)}/xml`);
  return file.data.toString('utf8');
}

/**
 * Pacote do mês para o contador: os XMLs das notas emitidas e recebidas e um resumo em
 * planilha. É o que o escritório importa para fazer a escrituração e o SPED. Só o admin.
 */
export function fiscalAccountantRouter(ctx: AppContext) {
  const router = Router();
  const { pool, config } = ctx;
  router.use(requireAdmin);

  async function company(user: AuthUser): Promise<FiscalSettingsRow & { cnpj: string }> {
    return requireCnpj(await withSession(pool, user, (db) => loadFiscalSettings(db, user.tenant_id)), true);
  }

  router.get('/summary', async (req, res) => {
    const user = currentUser(req);
    const { month } = monthSchema.parse(req.query);
    const settings = await company(user);
    const data = await withSession(pool, user, (db) => loadMonth(db, settings.environment, month, config.timeZone));
    res.json({ month, environment: settings.environment, ...summarize(data) });
  });

  /** Baixa da ACBr API um lote dos XMLs que faltam. A tela chama até não sobrar nada. */
  router.post('/prepare', async (req, res) => {
    const user = currentUser(req);
    const { month } = monthSchema.parse(req.body);
    const settings = await company(user);
    const acbr = acbrClientFor(ctx, settings, true);
    const data = await withSession(pool, user, (db) => loadMonth(db, settings.environment, month, config.timeZone));
    const issued = data.issued.filter((d) => !d.has_xml && d.acbr_id && (d.status === 'autorizado' || d.status === 'cancelado'));
    const inbound = [...new Set(data.received.flatMap((d) => (d.fetchable_inbound_id === null ? [] : [d.fetchable_inbound_id])))];
    const failures: string[] = [];
    const saved: { table: 'fiscal_documents' | 'fiscal_inbound_documents'; id: number; xml: string }[] = [];
    for (const doc of issued.slice(0, BATCH)) {
      try {
        saved.push({ table: 'fiscal_documents', id: doc.id, xml: await fetchIssuedXml(acbr, doc) });
      } catch (err) {
        failures.push(`${doc.model === 55 ? 'NF-e' : 'NFC-e'} ${doc.number}: ${describeAcbrError(err)}`);
      }
    }
    if (saved.length + failures.length < BATCH) {
      const ids = inbound.slice(0, BATCH - saved.length - failures.length);
      const { rows } = await withSession(pool, user, (db) =>
        db.query<{ id: number; acbr_id: string }>('select id, acbr_id from fiscal_inbound_documents where id = any($1::bigint[])', [ids]),
      );
      for (const doc of rows) {
        try {
          const file = await acbr.download(`/distribuicao/nfe/documentos/${encodeURIComponent(doc.acbr_id)}/xml`);
          saved.push({ table: 'fiscal_inbound_documents', id: doc.id, xml: file.data.toString('utf8') });
        } catch (err) {
          failures.push(`Nota recebida ${doc.id}: ${describeAcbrError(err)}`);
        }
      }
    }
    if (saved.length) {
      await withSession(pool, user, async (db) => {
        for (const item of saved) await db.query(`update ${item.table} set xml = $2 where id = $1`, [item.id, item.xml]);
      });
    }
    // Erro em todos do lote: para, senão a tela tentaria para sempre.
    if (!saved.length && failures.length) throw new HttpError(502, failures[0]!, 'ACBR_FAILED');
    const after = await withSession(pool, user, (db) => loadMonth(db, settings.environment, month, config.timeZone));
    res.json({ saved: saved.length, failures, ...summarize(after) });
  });

  router.get('/package', async (req, res) => {
    const user = currentUser(req);
    const { month } = monthSchema.parse(req.query);
    const settings = await company(user);
    const { data, xmls } = await withSession(pool, user, async (db) => {
      const loaded = await loadMonth(db, settings.environment, month, config.timeZone);
      const issuedXml = await db.query<{ id: number; xml: string }>(
        'select id, xml from fiscal_documents where id = any($1::bigint[]) and xml is not null',
        [loaded.issued.map((d) => d.id)],
      );
      const keys = loaded.received.map((d) => d.access_key);
      // O XML da entrada vale mais (é o que a loja lançou); sem ele, o do monitor.
      const receivedXml = await db.query<{ access_key: string; xml: string }>(
        `select distinct on (access_key) access_key, xml from (
           select access_key, xml, 0 as priority from stock_entries where access_key = any($1::text[]) and xml is not null
           union all
           select access_key, xml, 1 from fiscal_inbound_documents where access_key = any($1::text[]) and environment = $2 and xml is not null
         ) x
         order by access_key, priority`,
        [keys, settings.environment],
      );
      return {
        data: loaded,
        xmls: {
          issued: new Map(issuedXml.rows.map((r) => [r.id, r.xml])),
          received: new Map(receivedXml.rows.map((r) => [r.access_key, r.xml])),
        },
      };
    });

    const files: ZipFile[] = [];
    const lines = [['Tipo', 'Modelo', 'Número', 'Série', 'Chave de acesso', 'Emissão', 'Entrada', 'CNPJ/CPF', 'Nome', 'Valor', 'Situação', 'XML']];
    const day = (date: Date | null) =>
      date ? new Intl.DateTimeFormat('pt-BR', { timeZone: config.timeZone, day: '2-digit', month: '2-digit', year: 'numeric' }).format(date) : '';
    const money = (value: number | null) => (value === null ? '' : value.toFixed(2).replace('.', ','));

    for (const doc of data.issued) {
      const label = doc.model === 55 ? 'NF-e' : 'NFC-e';
      const xml = xmls.issued.get(doc.id);
      if (xml && doc.access_key) {
        const folder = doc.status === 'cancelado' ? 'emitidas/canceladas' : 'emitidas/autorizadas';
        files.push({ name: `${folder}/${label.replace('-', '')}-${doc.access_key}.xml`, data: Buffer.from(xml, 'utf8'), date: doc.issued_at ?? undefined });
      }
      lines.push([
        'Saída',
        label,
        String(doc.number),
        String(doc.series),
        doc.access_key ?? '',
        day(doc.issued_at),
        '',
        formatDocument(doc.recipient_document),
        doc.recipient_name ?? (doc.model === 65 ? 'Consumidor' : ''),
        money(doc.total_amount),
        STATUS_LABEL[doc.status] ?? doc.status,
        xml ? 'sim' : doc.status === 'inutilizado' || doc.status === 'denegado' ? '' : 'não',
      ]);
    }
    for (const doc of data.received) {
      const xml = xmls.received.get(doc.access_key);
      if (xml) files.push({ name: `recebidas/NFe-${doc.access_key}.xml`, data: Buffer.from(xml, 'utf8'), date: doc.issued_at ?? undefined });
      lines.push([
        'Entrada',
        doc.access_key.slice(20, 22) === '65' ? 'NFC-e' : 'NF-e',
        doc.number ?? String(Number(doc.access_key.slice(25, 34))),
        doc.series ?? String(Number(doc.access_key.slice(22, 25))),
        doc.access_key,
        day(doc.issued_at),
        doc.entered_at ? day(doc.entered_at) : 'sem entrada no estoque',
        formatDocument(doc.issuer_document),
        doc.issuer_name ?? '',
        money(doc.amount),
        doc.cancelled ? 'Cancelada pelo emitente' : 'Autorizada',
        xml ? 'sim' : 'não',
      ]);
    }

    const escape = (value: string) => (/[";\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value);
    const csv = `﻿${lines.map((l) => l.map(escape).join(';')).join('\r\n')}\r\n`;
    files.push({ name: 'resumo.csv', data: Buffer.from(csv, 'utf8') });
    const summary = summarize(data);
    const readme = [
      `Pacote do contador - ${month.slice(5)}/${month.slice(0, 4)}`,
      `${settings.legal_name ?? ''} - CNPJ ${formatDocument(settings.cnpj)}`,
      settings.environment === 'homologacao' ? 'ATENÇÃO: ambiente de HOMOLOGAÇÃO (notas de teste, sem valor fiscal).' : 'Ambiente de produção.',
      '',
      `Emitidas: ${summary.issued.authorized} autorizadas (R$ ${money(summary.issued.authorized_amount)}), ${summary.issued.cancelled} canceladas, ${summary.issued.other} denegadas ou inutilizadas.`,
      `Recebidas: ${summary.received.count} (as que deram entrada no estoque no mês e as do monitor emitidas no mês).`,
      summary.to_download + summary.without_xml > 0
        ? `Sem XML no pacote: ${summary.to_download + summary.without_xml} (veja a coluna XML do resumo.csv).`
        : 'Todos os XMLs estão no pacote.',
      '',
      'Pastas: emitidas/autorizadas, emitidas/canceladas (XML da autorização) e recebidas.',
    ].join('\r\n');
    files.push({ name: 'LEIA-ME.txt', data: Buffer.from(readme, 'utf8') });

    const zip = createZip(files);
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="contador-${settings.cnpj}-${month}.zip"`);
    res.setHeader('Cache-Control', 'no-store');
    res.send(zip);
  });

  return router;
}
