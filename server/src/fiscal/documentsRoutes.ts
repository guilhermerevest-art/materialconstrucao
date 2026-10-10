import { Router, type Request, type Response } from 'express';
import type pg from 'pg';
import { z } from 'zod';
import { currentUser, requireAdmin, type AuthUser } from '../auth.js';
import type { AppContext } from '../context.js';
import { withSession } from '../db/session.js';
import { HttpError } from '../errors.js';
import { likePattern, optionalQuery, optionalQueryId, pagination, parseId } from '../lib/validation.js';
import { describeAcbrError, type AcbrClient } from './acbr.js';
import {
  acbrClientFor,
  invalidFiscalData,
  loadFiscalSettings,
  modelLabel,
  modelPath,
  readinessProblems,
  requireCnpj,
  type FiscalSettingsRow,
} from './common.js';
import { buildInvoice, type FiscalClient, type FiscalItem, type FiscalOrder, type InvoiceModel } from './invoice.js';

/** Documento como a ACBr API devolve (POST /nfe, GET /nfe/{id}). */
type Dfe = {
  id?: string;
  status?: string;
  chave?: string;
  data_emissao?: string;
  autorizacao?: {
    status?: string;
    codigo_status?: number;
    motivo_status?: string;
    mensagem?: string;
    numero_protocolo?: string;
    data_recebimento?: string;
  };
};

/** Evento (cancelamento, inutilização) como a ACBr API devolve. */
type DfeEvent = { id?: string; status?: string; codigo_status?: number; motivo_status?: string; mensagem?: string };

type DocumentStatus = 'pendente' | 'autorizado' | 'rejeitado' | 'denegado' | 'cancelado' | 'erro' | 'inutilizado';

type DocumentRow = {
  id: number;
  tenant_id: number;
  store_id: number;
  order_id: number;
  model: InvoiceModel;
  environment: 'homologacao' | 'producao';
  series: number;
  number: number;
  status: DocumentStatus;
  attempts: number;
  reference: string | null;
  acbr_id: string | null;
};

const emitSchema = z.object({
  order_id: z.number('Informe o pedido.').int().positive('Informe o pedido.'),
  model: z.union([z.literal(55), z.literal(65)], 'Escolha entre NF-e (55) e NFC-e (65).'),
});

const reasonSchema = z.object({
  reason: z
    .string('Informe a justificativa.')
    .trim()
    .min(15, 'A justificativa precisa ter pelo menos 15 caracteres (exigência da SEFAZ).')
    .max(255, 'Use no máximo 255 caracteres.'),
});

const dateParam = z.preprocess(
  (v) => (v === '' ? undefined : v),
  z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'Data inválida.')
    .optional(),
);

const listSchema = z.object({
  status: z.preprocess(
    (v) => (v === '' ? undefined : v),
    z.enum(['pendente', 'autorizado', 'rejeitado', 'denegado', 'cancelado', 'erro', 'inutilizado']).optional(),
  ),
  model: z.preprocess((v) => (v === '' ? undefined : v), z.enum(['55', '65']).optional()),
  order_id: optionalQueryId,
  store_id: optionalQueryId,
  from: dateParam,
  to: dateParam,
  q: optionalQuery,
  ...pagination,
});

const NOT_FOUND = 'Nota fiscal não encontrada.';
const RETRYABLE: DocumentStatus[] = ['rejeitado', 'erro'];

const PUBLIC_COLUMNS = `d.id, d.store_id, s.name as store_name, d.order_id, d.user_id, u.name as user_name,
  o.client_id, c.name as client_name, d.model, d.environment, d.series, d.number, d.status, d.attempts,
  d.access_key, d.protocol, d.status_code, d.status_message, d.total_amount, d.recipient_name,
  d.recipient_document, d.issued_at, d.authorized_at, d.cancelled_at, d.cancel_reason, d.created_at, d.updated_at,
  (d.acbr_id is not null and d.status in ('autorizado', 'cancelado')) as has_files`;

const PUBLIC_FROM = `fiscal_documents d
  join stores s on s.id = d.store_id
  join users u on u.id = d.user_id
  join orders o on o.id = d.order_id
  join clients c on c.id = o.client_id`;

const STATUSES = new Set<DocumentStatus>(['pendente', 'autorizado', 'rejeitado', 'denegado', 'cancelado', 'erro']);

function mapStatus(status: string | undefined): DocumentStatus {
  if (status === 'encerrado') return 'autorizado';
  return status && STATUSES.has(status as DocumentStatus) ? (status as DocumentStatus) : 'pendente';
}

/** Referência única do envio na ACBr API: identifica a tentativa e evita envio em dobro. */
const referenceFor = (tenantId: number, documentId: number, attempt: number) => `gl-${tenantId}-${documentId}-${attempt}`;

/** Ano com dois dígitos, como pede a inutilização. */
function shortYear(timeZone: string) {
  return Number(new Intl.DateTimeFormat('en-US', { timeZone, year: '2-digit' }).format(new Date()));
}

async function loadDocument(db: pg.PoolClient, id: number) {
  const { rows } = await db.query(`select ${PUBLIC_COLUMNS} from ${PUBLIC_FROM} where d.id = $1`, [id]);
  return rows[0] ?? null;
}

async function loadDocumentRow(db: pg.PoolClient, id: number, lock = false): Promise<DocumentRow | null> {
  const { rows } = await db.query<DocumentRow>(
    `select id, tenant_id, store_id, order_id, model, environment, series, number, status, attempts, reference, acbr_id
       from fiscal_documents where id = $1 ${lock ? 'for update' : ''}`,
    [id],
  );
  return rows[0] ?? null;
}

/** Pedido, itens com os dados fiscais do produto e cadastro completo do cliente. Respeita o RLS de pedidos. */
async function loadInvoiceData(db: pg.PoolClient, orderId: number) {
  const { rows } = await db.query<FiscalOrder & { status: string; store_id: number; client_id: number }>(
    `select id, status, store_id, client_id, subtotal_amount, discount_amount, total_amount, notes, delivery_address,
            payment_method_name
       from orders where id = $1`,
    [orderId],
  );
  const order = rows[0];
  if (!order) return null;
  const items = await db.query<FiscalItem>(
    `select oi.position, oi.product_id, oi.product_code, oi.product_name, oi.unit, oi.quantity, oi.unit_price, oi.subtotal,
            p.gtin, p.ncm, p.cest, p.cfop, p.tax_origin, p.icms_cst, p.icms_rate, p.icms_base_reduction,
            p.pis_cst, p.pis_rate, p.cofins_cst, p.cofins_rate, p.ibscbs_cst, p.ibscbs_class, p.tax_benefit_code,
            p.fiscal_notes
       from order_items oi
       join products p on p.id = oi.product_id
      where oi.order_id = $1
      order by oi.position`,
    [orderId],
  );
  const client = await db.query<FiscalClient>(
    `select name, whatsapp, person_type, document, trade_name, state_registration, ie_indicator, final_consumer, email,
            phone, address_zip, address_street, address_number, address_complement, address_district, address_city,
            address_city_code, address_state
       from clients where id = $1`,
    [order.client_id],
  );
  return { order: { ...order, items: items.rows }, client: client.rows[0]! };
}

async function applyDfe(db: pg.PoolClient, id: number, dfe: Dfe) {
  const status = mapStatus(dfe.status);
  const auth = dfe.autorizacao;
  const message =
    auth?.motivo_status ?? auth?.mensagem ?? (status === 'pendente' ? 'Em processamento na SEFAZ.' : null);
  await db.query(
    `update fiscal_documents
        set status = $2,
            acbr_id = coalesce($3, acbr_id),
            access_key = coalesce($4, access_key),
            protocol = coalesce($5, protocol),
            status_code = $6,
            status_message = $7,
            authorized_at = case when $2 in ('autorizado', 'cancelado')
                                 then coalesce(authorized_at, $8::timestamptz, now()) else authorized_at end,
            cancelled_at = case when $2 = 'cancelado' then coalesce(cancelled_at, now()) else cancelled_at end,
            updated_at = now()
      where id = $1`,
    [id, status, dfe.id ?? null, dfe.chave ?? null, auth?.numero_protocolo ?? null, auth?.codigo_status ?? null, message, auth?.data_recebimento ?? null],
  );
}

/** Situação atual na ACBr API: pelo id, ou pela referência quando o envio não teve resposta. */
async function fetchDfe(acbr: AcbrClient, doc: DocumentRow, cnpj: string): Promise<Dfe | null> {
  const path = modelPath(doc.model);
  try {
    if (doc.acbr_id) return await acbr.request<Dfe>('GET', `/${path}/${encodeURIComponent(doc.acbr_id)}`);
    if (!doc.reference) return null;
    const list = await acbr.request<{ data?: Dfe[] }>('GET', `/${path}`, {
      query: { cpf_cnpj: cnpj, ambiente: doc.environment, referencia: doc.reference, $top: 1 },
    });
    return list?.data?.[0] ?? null;
  } catch (err) {
    throw new HttpError(502, describeAcbrError(err), 'ACBR_FAILED');
  }
}

/**
 * Notas fiscais dos pedidos. As mesmas regras dos pedidos valem aqui (RLS):
 * o vendedor emite e consulta as notas da própria loja; cancelar e inutilizar
 * são do administrador.
 */
export function fiscalDocumentsRouter(ctx: AppContext) {
  const router = Router();
  const { pool, config } = ctx;

  async function settingsFor(user: AuthUser) {
    const settings = await withSession(pool, user, (db) => loadFiscalSettings(db, user.tenant_id));
    const isAdmin = user.role === 'admin';
    const company = requireCnpj(settings, isAdmin);
    return { settings: company, acbr: acbrClientFor(ctx, company, isAdmin) };
  }

  /** Envia e grava o resultado. Falha de rede ou recusa da ACBr API deixa a nota em "erro" com o motivo. */
  async function transmit(user: AuthUser, acbr: AcbrClient, id: number, model: InvoiceModel, payload: unknown) {
    let dfe: Dfe | null = null;
    let failure: string | null = null;
    try {
      dfe = await acbr.request<Dfe>('POST', `/${modelPath(model)}`, { body: payload });
    } catch (err) {
      console.error(`Falha ao enviar a nota ${id} para a ACBr API:`, err);
      failure = describeAcbrError(err);
    }
    return withSession(pool, user, async (db) => {
      if (dfe) await applyDfe(db, id, dfe);
      else {
        await db.query(
          `update fiscal_documents set status = 'erro', status_code = null, status_message = $2, updated_at = now()
            where id = $1`,
          [id, failure],
        );
      }
      return loadDocument(db, id);
    });
  }

  /** Monta a nota a partir do pedido. Problemas de cadastro cancelam a transação (o número não é gasto). */
  function build(
    settings: FiscalSettingsRow,
    data: NonNullable<Awaited<ReturnType<typeof loadInvoiceData>>>,
    doc: { model: InvoiceModel; environment: FiscalSettingsRow['environment']; series: number; number: number },
    reference: string,
    issuedAt: Date,
  ) {
    const built = buildInvoice({
      model: doc.model,
      company: { ...settings, environment: doc.environment },
      client: data.client,
      order: data.order,
      series: doc.series,
      number: doc.number,
      reference,
      issuedAt,
      timeZone: config.timeZone,
    });
    if (!built.ok) throw invalidFiscalData(built.problems);
    return built;
  }

  router.get('/', async (req, res) => {
    const user = currentUser(req);
    const query = listSchema.parse(req.query);
    const where: string[] = [];
    const params: unknown[] = [];
    const param = (value: unknown) => {
      params.push(value);
      return `$${params.length}`;
    };
    if (user.role === 'seller') where.push(`d.store_id = ${param(user.store_id)}`);
    else if (query.store_id) where.push(`d.store_id = ${param(query.store_id)}`);
    if (query.status) where.push(`d.status = ${param(query.status)}`);
    if (query.model) where.push(`d.model = ${param(Number(query.model))}`);
    if (query.order_id) where.push(`d.order_id = ${param(query.order_id)}`);
    if (query.from) where.push(`d.created_at >= (${param(query.from)}::date)::timestamp at time zone ${param(config.timeZone)}`);
    if (query.to) where.push(`d.created_at < (${param(query.to)}::date + 1)::timestamp at time zone ${param(config.timeZone)}`);
    if (query.q) {
      const conditions = [`search_norm(c.name) like search_norm(${param(likePattern(query.q))})`];
      const digits = query.q.replace(/\D/g, '');
      if (/^\d{1,9}$/.test(query.q)) conditions.push(`d.number = ${param(Number(query.q))}`, `d.order_id = ${param(Number(query.q))}`);
      if (digits.length >= 6) conditions.push(`d.access_key like ${param(likePattern(digits))}`);
      where.push(`(${conditions.join(' or ')})`);
    }
    const limit = param(query.page_size);
    const offset = param((query.page - 1) * query.page_size);
    const rows = await withSession(pool, user, async (db) => {
      const result = await db.query(
        `select ${PUBLIC_COLUMNS}, count(*) over () as total_count
           from ${PUBLIC_FROM}
          ${where.length ? `where ${where.join(' and ')}` : ''}
          order by d.created_at desc, d.id desc
          limit ${limit} offset ${offset}`,
        params,
      );
      return result.rows;
    });
    res.json({
      items: rows.map(({ total_count: _, ...row }) => row),
      total: rows[0]?.total_count ?? 0,
      page: query.page,
      page_size: query.page_size,
    });
  });

  router.get('/:id', async (req, res) => {
    const id = parseId(req.params.id, NOT_FOUND);
    const document = await withSession(pool, currentUser(req), (db) => loadDocument(db, id));
    if (!document) throw new HttpError(404, NOT_FOUND);
    res.json({ document });
  });

  /** Emite a NF-e ou a NFC-e de um pedido confirmado. */
  router.post('/', async (req, res) => {
    const user = currentUser(req);
    const body = emitSchema.parse(req.body);
    const isAdmin = user.role === 'admin';
    const label = modelLabel(body.model);

    const prepared = await withSession(pool, user, async (db) => {
      const settings = requireCnpj(await loadFiscalSettings(db, user.tenant_id), isAdmin);
      const acbr = acbrClientFor(ctx, settings, isAdmin);
      const ready = readinessProblems(settings, body.model);
      if (ready.length) throw invalidFiscalData(ready);

      const data = await loadInvoiceData(db, body.order_id);
      if (!data) throw new HttpError(404, 'Pedido não encontrado.');
      if (data.order.status !== 'order') {
        throw new HttpError(409, 'Só pedidos confirmados têm nota fiscal. Converta o orçamento em pedido antes.');
      }
      const open = await db.query<{ model: InvoiceModel; number: number; status: DocumentStatus }>(
        `select model, number, status from fiscal_documents
          where order_id = $1 and status in ('pendente', 'autorizado', 'rejeitado', 'erro')`,
        [body.order_id],
      );
      const current = open.rows[0];
      if (current) {
        const name = `${modelLabel(current.model)} nº ${current.number}`;
        throw new HttpError(
          409,
          current.status === 'autorizado'
            ? `Este pedido já tem a ${name} autorizada.`
            : current.status === 'pendente'
              ? `A ${name} deste pedido ainda está em processamento. Atualize a situação dela.`
              : `A ${name} deste pedido foi recusada. Corrija e reenvie, ou inutilize o número antes de emitir outra.`,
          'FISCAL_OPEN_DOCUMENT',
        );
      }

      // Reserva o número na mesma transação da nota: concorrência não repete número.
      const prefix = body.model === 55 ? 'nfe' : 'nfce';
      const reserved = await db.query<{ series: number; number: number }>(
        `update fiscal_settings
            set ${prefix}_next_number = ${prefix}_next_number + 1, updated_at = now()
          where tenant_id = $1
         returning ${prefix}_series as series, ${prefix}_next_number - 1 as number`,
        [user.tenant_id],
      );
      const { series, number } = reserved.rows[0]!;
      const issuedAt = new Date();
      const inserted = await db.query<{ id: number }>(
        `insert into fiscal_documents
           (tenant_id, store_id, order_id, user_id, model, environment, series, number, total_amount, issued_at)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
         returning id`,
        [user.tenant_id, data.order.store_id, data.order.id, user.id, body.model, settings.environment, series, number, data.order.total_amount, issuedAt],
      );
      const id = inserted.rows[0]!.id;
      const reference = referenceFor(user.tenant_id, id, 1);
      const built = build(settings, data, { model: body.model, environment: settings.environment, series, number }, reference, issuedAt);
      await db.query(
        'update fiscal_documents set reference = $2, recipient_name = $3, recipient_document = $4 where id = $1',
        [id, reference, built.recipient.name, built.recipient.document],
      );
      return { id, acbr, payload: built.payload };
    });

    const document = await transmit(user, prepared.acbr, prepared.id, body.model, prepared.payload);
    console.info(`${label} ${prepared.id} do pedido ${body.order_id}: ${document?.status}`);
    res.status(201).json({ document });
  });

  /** Consulta a situação na ACBr API (nota em processamento ou envio sem resposta). */
  router.post('/:id/sync', async (req, res) => {
    const user = currentUser(req);
    const id = parseId(req.params.id, NOT_FOUND);
    const doc = await withSession(pool, user, (db) => loadDocumentRow(db, id));
    if (!doc) throw new HttpError(404, NOT_FOUND);
    const { settings, acbr } = await settingsFor(user);
    const dfe = await fetchDfe(acbr, doc, settings.cnpj);
    const document = await withSession(pool, user, async (db) => {
      if (dfe) await applyDfe(db, id, dfe);
      else if (doc.status === 'erro' && !doc.acbr_id) {
        await db.query(
          `update fiscal_documents set status_message = $2, updated_at = now() where id = $1`,
          [id, 'A ACBr API não recebeu esta nota. Reenvie para tentar de novo com o mesmo número.'],
        );
      }
      return loadDocument(db, id);
    });
    res.json({ document });
  });

  /**
   * Reenvia uma nota rejeitada ou com erro, com o mesmo número: a SEFAZ não
   * consome o número de uma nota rejeitada. A nota é montada de novo com o
   * cadastro atual (é aqui que entra a correção do NCM, do endereço etc.).
   */
  router.post('/:id/retry', async (req, res) => {
    const user = currentUser(req);
    const id = parseId(req.params.id, NOT_FOUND);
    const first = await withSession(pool, user, (db) => loadDocumentRow(db, id));
    if (!first) throw new HttpError(404, NOT_FOUND);
    if (!RETRYABLE.includes(first.status)) throw new HttpError(409, 'Só notas rejeitadas ou com erro podem ser reenviadas.');
    const { acbr, settings: current } = await settingsFor(user);

    // Envio que ficou sem resposta pode ter sido autorizado: confere antes para não mandar em dobro.
    if (first.status === 'erro' && !first.acbr_id && first.reference) {
      const dfe = await fetchDfe(acbr, first, current.cnpj);
      if (dfe && !RETRYABLE.includes(mapStatus(dfe.status))) {
        const document = await withSession(pool, user, async (db) => {
          await applyDfe(db, id, dfe);
          return loadDocument(db, id);
        });
        res.json({ document });
        return;
      }
    }

    const prepared = await withSession(pool, user, async (db) => {
      const doc = await loadDocumentRow(db, id, true);
      if (!doc) throw new HttpError(404, NOT_FOUND);
      if (!RETRYABLE.includes(doc.status)) throw new HttpError(409, 'Só notas rejeitadas ou com erro podem ser reenviadas.');
      const settings = requireCnpj(await loadFiscalSettings(db, user.tenant_id), user.role === 'admin');
      const ready = readinessProblems(settings, doc.model);
      if (ready.length) throw invalidFiscalData(ready);
      const data = await loadInvoiceData(db, doc.order_id);
      if (!data) throw new HttpError(404, 'Pedido não encontrado.');
      const attempts = doc.attempts + 1;
      const reference = referenceFor(user.tenant_id, id, attempts);
      const issuedAt = new Date();
      const built = build(settings, data, doc, reference, issuedAt);
      await db.query(
        `update fiscal_documents
            set status = 'pendente', attempts = $2, reference = $3, acbr_id = null, access_key = null, protocol = null,
                status_code = null, status_message = null, issued_at = $4, total_amount = $5,
                recipient_name = $6, recipient_document = $7, updated_at = now()
          where id = $1`,
        [id, attempts, reference, issuedAt, data.order.total_amount, built.recipient.name, built.recipient.document],
      );
      return { model: doc.model, payload: built.payload };
    });

    const document = await transmit(user, acbr, id, prepared.model, prepared.payload);
    res.json({ document });
  });

  /** Cancela uma nota autorizada (a SEFAZ aceita até 24 h na NF-e e 30 min na NFC-e, conforme a UF). */
  router.post('/:id/cancel', requireAdmin, async (req, res) => {
    const user = currentUser(req);
    const id = parseId(req.params.id, NOT_FOUND);
    const { reason } = reasonSchema.parse(req.body);
    const doc = await withSession(pool, user, (db) => loadDocumentRow(db, id));
    if (!doc) throw new HttpError(404, NOT_FOUND);
    if (doc.status !== 'autorizado' || !doc.acbr_id) throw new HttpError(409, 'Só notas autorizadas podem ser canceladas.');
    const { acbr } = await settingsFor(user);

    let event: DfeEvent;
    try {
      event = await acbr.request<DfeEvent>('POST', `/${modelPath(doc.model)}/${encodeURIComponent(doc.acbr_id)}/cancelamento`, {
        body: { justificativa: reason },
      });
    } catch (err) {
      throw new HttpError(502, describeAcbrError(err), 'ACBR_FAILED');
    }
    if (event?.status === 'rejeitado' || event?.status === 'erro') {
      throw new HttpError(422, `A SEFAZ recusou o cancelamento: ${event.motivo_status ?? event.mensagem ?? 'sem motivo informado'}.`);
    }
    const document = await withSession(pool, user, async (db) => {
      if (event?.status === 'registrado') {
        await db.query(
          `update fiscal_documents
              set status = 'cancelado', cancelled_at = now(), cancel_reason = $2, status_message = $3, updated_at = now()
            where id = $1`,
          [id, reason, event.motivo_status ?? 'Cancelamento homologado.'],
        );
      } else {
        await db.query(
          `update fiscal_documents set cancel_reason = $2, status_message = $3, updated_at = now() where id = $1`,
          [id, reason, 'Cancelamento em processamento. Atualize a situação em instantes.'],
        );
      }
      return loadDocument(db, id);
    });
    res.json({ document });
  });

  /**
   * Inutiliza o número de uma nota que nunca foi autorizada, para a sequência não
   * ficar com buraco. Depois disso o pedido pode ter outra nota.
   */
  router.post('/:id/discard', requireAdmin, async (req, res) => {
    const user = currentUser(req);
    const id = parseId(req.params.id, NOT_FOUND);
    const { reason } = reasonSchema.parse(req.body);
    const doc = await withSession(pool, user, (db) => loadDocumentRow(db, id));
    if (!doc) throw new HttpError(404, NOT_FOUND);
    if (!RETRYABLE.includes(doc.status)) throw new HttpError(409, 'Só o número de notas rejeitadas ou com erro pode ser inutilizado.');
    const { acbr, settings } = await settingsFor(user);

    if (doc.status === 'erro' && !doc.acbr_id && doc.reference) {
      const dfe = await fetchDfe(acbr, doc, settings.cnpj);
      if (dfe && !RETRYABLE.includes(mapStatus(dfe.status))) {
        await withSession(pool, user, (db) => applyDfe(db, id, dfe));
        throw new HttpError(409, 'A SEFAZ já tinha recebido esta nota. Atualize a página: se ela foi autorizada, cancele em vez de inutilizar.');
      }
    }

    let event: DfeEvent;
    try {
      event = await acbr.request<DfeEvent>('POST', `/${modelPath(doc.model)}/inutilizacoes`, {
        body: {
          ambiente: doc.environment,
          cnpj: settings.cnpj,
          ano: shortYear(config.timeZone),
          serie: doc.series,
          numero_inicial: doc.number,
          numero_final: doc.number,
          justificativa: reason,
        },
      });
    } catch (err) {
      throw new HttpError(502, describeAcbrError(err), 'ACBR_FAILED');
    }
    if (event?.status === 'rejeitado' || event?.status === 'erro') {
      throw new HttpError(422, `A SEFAZ recusou a inutilização: ${event.motivo_status ?? event.mensagem ?? 'sem motivo informado'}.`);
    }
    const document = await withSession(pool, user, async (db) => {
      await db.query(
        `update fiscal_documents
            set status = 'inutilizado', cancel_reason = $2, cancelled_at = now(), status_message = $3, updated_at = now()
          where id = $1`,
        [id, reason, event?.motivo_status ?? 'Numeração inutilizada.'],
      );
      return loadDocument(db, id);
    });
    res.json({ document });
  });

  async function sendFile(req: Request, res: Response, kind: 'pdf' | 'xml') {
    const user = currentUser(req);
    const id = parseId(req.params.id, NOT_FOUND);
    const doc = await withSession(pool, user, (db) => loadDocumentRow(db, id));
    if (!doc) throw new HttpError(404, NOT_FOUND);
    if (!doc.acbr_id || (doc.status !== 'autorizado' && doc.status !== 'cancelado')) {
      throw new HttpError(409, kind === 'pdf' ? 'O DANFE fica disponível depois da autorização.' : 'O XML fica disponível depois da autorização.');
    }
    let file: { data: Buffer; contentType: string };
    const cached =
      kind === 'xml'
        ? await withSession(pool, user, (db) => db.query<{ xml: string | null }>('select xml from fiscal_documents where id = $1', [id]))
        : null;
    if (cached?.rows[0]?.xml) {
      file = { data: Buffer.from(cached.rows[0].xml, 'utf8'), contentType: 'application/xml' };
    } else {
      const { acbr } = await settingsFor(user);
      try {
        file = await acbr.download(`/${modelPath(doc.model)}/${encodeURIComponent(doc.acbr_id)}/${kind}`);
      } catch (err) {
        throw new HttpError(502, describeAcbrError(err), 'ACBR_FAILED');
      }
      // O XML autorizado não muda: fica guardado para o pacote do contador.
      if (kind === 'xml') {
        const xml = file.data.toString('utf8');
        await withSession(pool, user, (db) => db.query('update fiscal_documents set xml = $2 where id = $1 and xml is null', [id, xml]));
      }
    }
    const name = `${modelPath(doc.model)}-${doc.series}-${doc.number}.${kind}`;
    const disposition = req.query.download === '1' ? 'attachment' : 'inline';
    res.setHeader('Content-Type', kind === 'pdf' ? 'application/pdf' : 'application/xml');
    res.setHeader('Content-Disposition', `${disposition}; filename="${name}"`);
    res.setHeader('Cache-Control', 'no-store');
    res.send(file.data);
  }

  router.get('/:id/pdf', (req, res) => sendFile(req, res, 'pdf'));
  router.get('/:id/xml', (req, res) => sendFile(req, res, 'xml'));

  return router;
}
