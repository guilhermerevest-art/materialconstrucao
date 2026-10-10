import { Router, type Request, type Response } from 'express';
import type pg from 'pg';
import { z } from 'zod';
import { currentUser, requireAdmin, type AuthUser } from '../auth.js';
import type { AppContext } from '../context.js';
import { withSession } from '../db/session.js';
import { HttpError } from '../errors.js';
import { likePattern, optionalQuery, pagination, parseId } from '../lib/validation.js';
import { describeAcbrError, type AcbrClient } from './acbr.js';
import { acbrClientFor, loadFiscalSettings, requireCnpj } from './common.js';

/** Documento distribuído pela SEFAZ, como a ACBr API devolve. */
type DistDocument = {
  id: string;
  nsu?: number;
  tipo_documento?: 'nota' | 'evento';
  chave_acesso?: string;
  resumo?: boolean;
  tipo_evento?: string;
  data_evento?: string;
  data_recebimento?: string;
  numero_protocolo?: string;
  tipo_nfe?: number;
  valor_nfe?: number;
  emitente_cpf_cnpj?: string;
  emitente_nome_razao_social?: string;
  emitente_inscricao_estadual?: string;
};

type Distribution = {
  status?: 'processando' | 'concluido' | 'erro';
  codigo_status?: number;
  motivo_status?: string;
  ultimo_nsu?: number;
  max_nsu?: number;
  documentos?: DistDocument[];
};

type ManifestEvent = { id?: string; status?: string; codigo_status?: number; motivo_status?: string };

export const MANIFESTATIONS = {
  '210200': 'Confirmação da operação',
  '210210': 'Ciência da operação',
  '210220': 'Desconhecimento da operação',
  '210240': 'Operação não realizada',
} as const;

type ManifestationCode = keyof typeof MANIFESTATIONS;

const listSchema = z.object({
  q: optionalQuery,
  status: z.preprocess(
    (v) => (v === '' ? undefined : v),
    z.enum(['pending', 'acknowledged', 'confirmed', 'refused', 'cancelled', 'all']).default('all'),
  ),
  ...pagination,
});

const manifestSchema = z
  .object({
    event: z.enum(Object.keys(MANIFESTATIONS) as [ManifestationCode, ...ManifestationCode[]], 'Escolha a manifestação.'),
    reason: z.preprocess(
      (v) => (typeof v === 'string' && v.trim() === '' ? undefined : v),
      z.string().trim().max(255, 'Use no máximo 255 caracteres.').optional(),
    ),
  })
  .superRefine((value, ctx) => {
    if (value.event === '210240' && (!value.reason || value.reason.length < 15)) {
      ctx.addIssue({
        code: 'custom',
        message: 'Para "operação não realizada" a SEFAZ exige justificativa de pelo menos 15 caracteres.',
        path: ['reason'],
      });
    }
  });

const keySchema = z.object({
  access_key: z
    .string('Informe a chave de acesso.')
    .transform((v) => v.replace(/\D/g, ''))
    .pipe(z.string().regex(/^\d{44}$/, 'A chave de acesso tem 44 dígitos.')),
});

const NOT_FOUND = 'Nota recebida não encontrada.';
/** A distribuição devolve até 50 documentos por consulta; páginas da listagem da ACBr API vão de 100 em 100. */
const PAGE = 100;
const MAX_PAGES = 20;

// stock_entry_id: a nota já deu entrada no estoque (pela chave de acesso).
const COLUMNS = `id, environment, access_key, nsu, summary, issuer_document, issuer_name, issuer_state_registration,
  nfe_type, amount, protocol, issued_at, authorized_at, cancelled, manifestation, manifestation_status,
  manifestation_message, manifested_at, created_at, updated_at,
  (select e.id from stock_entries e where e.access_key = fiscal_inbound_documents.access_key limit 1) as stock_entry_id`;

type InboundRow = {
  id: number;
  environment: 'homologacao' | 'producao';
  access_key: string;
  acbr_id: string;
  summary: boolean;
  manifestation_acbr_id: string | null;
  manifestation_status: string | null;
};

/** Grava notas e eventos distribuídos. Devolve quantas notas são novas. */
async function store(db: pg.PoolClient, tenantId: number, environment: string, docs: DistDocument[]) {
  let created = 0;
  const notes = docs.filter((d) => d.tipo_documento !== 'evento' && d.chave_acesso);
  const events = docs
    .filter((d) => d.tipo_documento === 'evento' && d.chave_acesso)
    .sort((a, b) => (a.nsu ?? 0) - (b.nsu ?? 0));

  for (const doc of notes) {
    const { rows } = await db.query<{ inserted: boolean }>(
      `insert into fiscal_inbound_documents
         (tenant_id, environment, access_key, acbr_id, nsu, summary, issuer_document, issuer_name,
          issuer_state_registration, nfe_type, amount, protocol, issued_at, authorized_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
       on conflict (tenant_id, environment, access_key) do update
          set acbr_id = case when not excluded.summary or fiscal_inbound_documents.summary
                             then excluded.acbr_id else fiscal_inbound_documents.acbr_id end,
              summary = fiscal_inbound_documents.summary and excluded.summary,
              nsu = greatest(fiscal_inbound_documents.nsu, excluded.nsu),
              issuer_document = coalesce(excluded.issuer_document, fiscal_inbound_documents.issuer_document),
              issuer_name = coalesce(excluded.issuer_name, fiscal_inbound_documents.issuer_name),
              issuer_state_registration = coalesce(excluded.issuer_state_registration, fiscal_inbound_documents.issuer_state_registration),
              nfe_type = coalesce(excluded.nfe_type, fiscal_inbound_documents.nfe_type),
              amount = coalesce(excluded.amount, fiscal_inbound_documents.amount),
              protocol = coalesce(excluded.protocol, fiscal_inbound_documents.protocol),
              issued_at = coalesce(fiscal_inbound_documents.issued_at, excluded.issued_at),
              authorized_at = coalesce(fiscal_inbound_documents.authorized_at, excluded.authorized_at),
              updated_at = now()
       returning (xmax = 0) as inserted`,
      [
        tenantId,
        environment,
        doc.chave_acesso,
        doc.id,
        doc.nsu ?? null,
        doc.resumo ?? true,
        doc.emitente_cpf_cnpj ?? null,
        doc.emitente_nome_razao_social ?? null,
        doc.emitente_inscricao_estadual ?? null,
        doc.tipo_nfe ?? null,
        doc.valor_nfe ?? null,
        doc.numero_protocolo ?? null,
        doc.data_evento ?? null,
        doc.data_recebimento ?? null,
      ],
    );
    if (rows[0]?.inserted) created += 1;
  }

  for (const event of events) {
    const type = event.tipo_evento ?? '';
    if (type === '110111' || type === '110112') {
      // O emitente cancelou a nota.
      await db.query(
        `update fiscal_inbound_documents set cancelled = true, updated_at = now()
          where environment = $1 and access_key = $2`,
        [environment, event.chave_acesso],
      );
    } else if (type in MANIFESTATIONS) {
      // A manifestação feita (aqui ou automática pela ACBr API) voltou registrada.
      await db.query(
        `update fiscal_inbound_documents
            set manifestation = $3, manifestation_status = 'registrado', manifestation_message = null,
                manifested_at = coalesce($4::timestamptz, now()), updated_at = now()
          where environment = $1 and access_key = $2
            and (manifested_at is null or manifested_at <= coalesce($4::timestamptz, now()))`,
        [environment, event.chave_acesso, type, event.data_evento ?? null],
      );
    }
  }
  return created;
}

const maxNsu = (docs: DistDocument[]) => docs.reduce((max, d) => Math.max(max, d.nsu ?? 0), 0);

/**
 * Monitor de notas recebidas: NF-e emitidas contra o CNPJ da empresa, trazidas
 * da SEFAZ pela distribuição DF-e da ACBr API, e a manifestação do destinatário.
 * Só administradores.
 */
export function fiscalInboundRouter(ctx: AppContext) {
  const router = Router();
  router.use(requireAdmin);
  const { pool } = ctx;

  async function settingsFor(user: AuthUser) {
    const settings = requireCnpj(await withSession(pool, user, (db) => loadFiscalSettings(db, user.tenant_id)), true);
    return { settings, acbr: acbrClientFor(ctx, settings, true) };
  }

  /** Lê da ACBr API tudo o que foi distribuído desde o último NSU guardado. */
  async function fetchDistributed(acbr: AcbrClient, cnpj: string, environment: string, fromNsu: number) {
    const docs: DistDocument[] = [];
    for (let page = 0; page < MAX_PAGES; page++) {
      const list = await acbr.request<{ data?: DistDocument[] }>('GET', '/distribuicao/nfe/documentos', {
        query: { cpf_cnpj: cnpj, ambiente: environment, dist_nsu: fromNsu || undefined, $top: PAGE, $skip: page * PAGE },
      });
      const data = list?.data ?? [];
      docs.push(...data);
      if (data.length < PAGE) break;
    }
    return docs;
  }

  router.get('/', async (req, res) => {
    const me = currentUser(req);
    const query = listSchema.parse(req.query);
    const result = await withSession(pool, me, async (db) => {
      const settings = await loadFiscalSettings(db, me.tenant_id);
      const environment = settings?.environment ?? 'homologacao';
      const where = ['environment = $1'];
      const params: unknown[] = [environment];
      const param = (value: unknown) => {
        params.push(value);
        return `$${params.length}`;
      };
      if (query.status === 'pending') where.push('manifestation is null and not cancelled');
      if (query.status === 'acknowledged') where.push(`manifestation = '210210'`);
      if (query.status === 'confirmed') where.push(`manifestation = '210200'`);
      if (query.status === 'refused') where.push(`manifestation in ('210220', '210240')`);
      if (query.status === 'cancelled') where.push('cancelled');
      if (query.q) {
        const digits = query.q.replace(/\D/g, '');
        const conditions = [`search_norm(issuer_name) like search_norm(${param(likePattern(query.q))})`];
        if (digits.length >= 4) {
          const pattern = param(likePattern(digits));
          conditions.push(`issuer_document like ${pattern}`, `access_key like ${pattern}`);
        }
        where.push(`(${conditions.join(' or ')})`);
      }
      const limit = param(query.page_size);
      const offset = param((query.page - 1) * query.page_size);
      const { rows } = await db.query(
        `select ${COLUMNS}, count(*) over () as total_count
           from fiscal_inbound_documents
          where ${where.join(' and ')}
          order by coalesce(issued_at, authorized_at, created_at) desc, id desc
          limit ${limit} offset ${offset}`,
        params,
      );
      const pending = await db.query<{ count: number }>(
        `select count(*) as count from fiscal_inbound_documents
          where environment = $1 and manifestation is null and not cancelled`,
        [environment],
      );
      return {
        rows,
        meta: {
          environment,
          configured: Boolean(settings?.cnpj),
          synced_at: settings?.inbound_synced_at ?? null,
          last_nsu: settings?.inbound_last_nsu ?? 0,
          auto_distribution: settings?.inbound_auto_distribution ?? true,
          auto_acknowledge: settings?.inbound_auto_acknowledge ?? false,
          pending_count: pending.rows[0]?.count ?? 0,
        },
      };
    });
    res.json({
      items: result.rows.map(({ total_count: _, ...row }) => row),
      total: result.rows[0]?.total_count ?? 0,
      page: query.page,
      page_size: query.page_size,
      meta: result.meta,
    });
  });

  /**
   * Busca notas novas. Com `sefaz`, pede antes uma distribuição à SEFAZ (a SEFAZ
   * limita a uma consulta por hora quando não há nada novo); sem ele, só lê o que
   * a distribuição automática da ACBr API já trouxe.
   */
  router.post('/sync', async (req, res) => {
    const me = currentUser(req);
    const { sefaz } = z.object({ sefaz: z.boolean().default(false) }).parse(req.body ?? {});
    const { settings, acbr } = await settingsFor(me);
    const environment = settings.environment;
    let notice: string | null = null;
    const docs: DistDocument[] = [];

    if (sefaz) {
      try {
        const dist = await acbr.request<Distribution>('POST', '/distribuicao/nfe', {
          body: { cpf_cnpj: settings.cnpj, ambiente: environment, tipo_consulta: 'dist-nsu', dist_nsu: settings.inbound_last_nsu },
        });
        docs.push(...(dist?.documentos ?? []));
        if (dist?.motivo_status) notice = `SEFAZ: ${dist.motivo_status}`;
      } catch (err) {
        // A recusa (ex.: consulta antes do intervalo mínimo) não impede ler o que já foi distribuído.
        notice = describeAcbrError(err);
      }
    }

    try {
      docs.push(...(await fetchDistributed(acbr, settings.cnpj, environment, settings.inbound_last_nsu)));
    } catch (err) {
      throw new HttpError(502, describeAcbrError(err), 'ACBR_FAILED');
    }

    // Manifestações que ficaram em processamento: confere se já foram registradas.
    const pendingManifestations = await withSession(pool, me, (db) =>
      db
        .query<InboundRow>(
          `select id, environment, access_key, acbr_id, summary, manifestation_acbr_id, manifestation_status
             from fiscal_inbound_documents
            where environment = $1 and manifestation_status = 'pendente' and manifestation_acbr_id is not null
            limit 20`,
          [environment],
        )
        .then((r) => r.rows),
    );
    const manifestUpdates: { id: number; event: ManifestEvent }[] = [];
    for (const row of pendingManifestations) {
      try {
        const event = await acbr.request<ManifestEvent>(
          'GET',
          `/distribuicao/nfe/manifestacoes/${encodeURIComponent(row.manifestation_acbr_id!)}`,
        );
        if (event) manifestUpdates.push({ id: row.id, event });
      } catch (err) {
        console.error(`Falha ao consultar a manifestação ${row.manifestation_acbr_id}:`, err);
      }
    }

    const created = await withSession(pool, me, async (db) => {
      const count = await store(db, me.tenant_id, environment, docs);
      for (const { id, event } of manifestUpdates) {
        await db.query(
          `update fiscal_inbound_documents
              set manifestation_status = $2, manifestation_message = $3, updated_at = now()
            where id = $1 and manifestation_status = 'pendente'`,
          [id, event.status ?? 'pendente', event.motivo_status ?? null],
        );
      }
      await db.query(
        `update fiscal_settings
            set inbound_last_nsu = greatest(inbound_last_nsu, $2), inbound_synced_at = now()
          where tenant_id = $1`,
        [me.tenant_id, maxNsu(docs)],
      );
      return count;
    });
    res.json({ created, notice });
  });

  /** Consulta uma nota pela chave de acesso (a nota que o fornecedor mandou e ainda não apareceu). */
  router.post('/by-key', async (req, res) => {
    const me = currentUser(req);
    const { access_key } = keySchema.parse(req.body);
    const { settings, acbr } = await settingsFor(me);
    let dist: Distribution;
    try {
      dist = await acbr.request<Distribution>('POST', '/distribuicao/nfe', {
        body: { cpf_cnpj: settings.cnpj, ambiente: settings.environment, tipo_consulta: 'cons-chave', cons_chave: access_key },
      });
    } catch (err) {
      throw new HttpError(502, describeAcbrError(err), 'ACBR_FAILED');
    }
    const created = await withSession(pool, me, (db) => store(db, me.tenant_id, settings.environment, dist?.documentos ?? []));
    const found = (dist?.documentos ?? []).some((d) => d.chave_acesso === access_key && d.tipo_documento !== 'evento');
    res.json({
      created,
      found,
      notice: dist?.motivo_status ? `SEFAZ: ${dist.motivo_status}` : null,
    });
  });

  /** Manifestação do destinatário. A ciência libera o XML completo na próxima busca. */
  router.post('/:id/manifest', async (req, res) => {
    const me = currentUser(req);
    const id = parseId(req.params.id, NOT_FOUND);
    const body = manifestSchema.parse(req.body);
    const doc = await withSession(pool, me, async (db) => {
      const { rows } = await db.query<InboundRow>(
        `select id, environment, access_key, acbr_id, summary, manifestation_acbr_id, manifestation_status
           from fiscal_inbound_documents where id = $1`,
        [id],
      );
      return rows[0];
    });
    if (!doc) throw new HttpError(404, NOT_FOUND);
    const { settings, acbr } = await settingsFor(me);

    let event: ManifestEvent;
    try {
      event = await acbr.request<ManifestEvent>('POST', '/distribuicao/nfe/manifestacoes', {
        body: {
          cpf_cnpj: settings.cnpj,
          ambiente: doc.environment,
          chave_acesso: doc.access_key,
          tipo_evento: body.event,
          justificativa: body.reason,
        },
      });
    } catch (err) {
      throw new HttpError(502, describeAcbrError(err), 'ACBR_FAILED');
    }
    if (event?.status === 'rejeitado' || event?.status === 'erro') {
      throw new HttpError(422, `A SEFAZ recusou a manifestação: ${event.motivo_status ?? 'sem motivo informado'}.`);
    }
    const document = await withSession(pool, me, async (db) => {
      const { rows } = await db.query(
        `update fiscal_inbound_documents
            set manifestation = $2, manifestation_status = $3, manifestation_message = $4,
                manifestation_acbr_id = $5, manifested_at = now(), updated_at = now()
          where id = $1
         returning ${COLUMNS}`,
        [id, body.event, event?.status ?? 'pendente', event?.motivo_status ?? null, event?.id ?? null],
      );
      return rows[0];
    });
    res.json({ document });
  });

  async function sendFile(req: Request, res: Response, kind: 'pdf' | 'xml') {
    const me = currentUser(req);
    const id = parseId(req.params.id, NOT_FOUND);
    const doc = await withSession(pool, me, async (db) => {
      const { rows } = await db.query<InboundRow>(
        `select id, environment, access_key, acbr_id, summary, manifestation_acbr_id, manifestation_status
           from fiscal_inbound_documents where id = $1`,
        [id],
      );
      return rows[0];
    });
    if (!doc) throw new HttpError(404, NOT_FOUND);
    if (kind === 'pdf' && doc.summary) {
      throw new HttpError(409, 'Por enquanto só chegou o resumo da nota. Dê ciência da operação e busque as notas de novo para baixar o DANFE.');
    }
    const { acbr } = await settingsFor(me);
    let file: { data: Buffer };
    try {
      file = await acbr.download(`/distribuicao/nfe/documentos/${encodeURIComponent(doc.acbr_id)}/${kind}`);
    } catch (err) {
      throw new HttpError(502, describeAcbrError(err), 'ACBR_FAILED');
    }
    res.setHeader('Content-Type', kind === 'pdf' ? 'application/pdf' : 'application/xml');
    res.setHeader('Content-Disposition', `${req.query.download === '1' ? 'attachment' : 'inline'}; filename="nfe-${doc.access_key}.${kind}"`);
    res.setHeader('Cache-Control', 'no-store');
    res.send(file.data);
  }

  router.get('/:id/pdf', (req, res) => sendFile(req, res, 'pdf'));
  router.get('/:id/xml', (req, res) => sendFile(req, res, 'xml'));

  return router;
}
