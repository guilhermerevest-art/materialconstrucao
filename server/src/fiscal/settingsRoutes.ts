import { Router, type Request } from 'express';
import { z } from 'zod';
import { currentUser, requireAdmin } from '../auth.js';
import type { AppContext } from '../context.js';
import { withSession } from '../db/session.js';
import { HttpError } from '../errors.js';
import { isValidCnpj, stripDocument } from '../lib/document.js';
import { optionalText } from '../lib/validation.js';
import { AcbrError, describeAcbrError, resolveCredentials, type AcbrClient } from './acbr.js';
import {
  acbrClientFor,
  FISCAL_SETTINGS_COLUMNS,
  loadFiscalSettings,
  requireCnpj,
  type FiscalSettingsRow,
} from './common.js';
import { addressFields, cnpjField, digitsField, emailField, refineAddress } from './validation.js';

/** Vazio mantém o segredo já salvo. */
const keepSecret = (max: number) =>
  z.preprocess(
    (v) => (typeof v === 'string' && v.trim() === '' ? undefined : v),
    z.string().trim().max(max).optional(),
  );

const series = (label: string) =>
  z.number(`Informe a série da ${label}.`).int().min(0, 'Série inválida.').max(889, 'A série vai de 0 a 889.');
const nextNumber = (label: string) =>
  z
    .number(`Informe o próximo número da ${label}.`)
    .int()
    .min(1, 'O número começa em 1.')
    .max(999_999_999, 'Número alto demais.');
const rate = z.number().min(0).max(100);

const settingsSchema = z
  .object({
    environment: z.enum(['homologacao', 'producao'], 'Escolha o ambiente: homologação ou produção.'),
    acbr_client_id: optionalText(200),
    acbr_client_secret: keepSecret(500),
    cnpj: cnpjField,
    legal_name: optionalText(60),
    trade_name: optionalText(60),
    state_registration: digitsField(/^\d{2,14}$/, 'Inscrição estadual inválida: use só os números.'),
    municipal_registration: optionalText(15),
    cnae: digitsField(/^\d{7}$/, 'O CNAE tem 7 dígitos.'),
    tax_regime: z.preprocess(
      (v) => (v === '' || v === undefined ? null : v),
      z
        .number()
        .int()
        .refine((v) => [1, 2, 3, 4].includes(v), 'Regime tributário inválido.')
        .nullable(),
    ),
    email: emailField,
    phone: optionalText(20),
    ...addressFields,
    operation_nature: z.string().trim().min(1, 'Informe a natureza da operação.').max(60).default('Venda de mercadoria'),
    additional_info: optionalText(2000),
    nfe_series: series('NF-e'),
    nfe_next_number: nextNumber('NF-e'),
    nfce_series: series('NFC-e'),
    nfce_next_number: nextNumber('NFC-e'),
    nfce_csc_id: digitsField(/^\d{1,6}$/, 'O identificador do CSC é numérico (ex.: 1).'),
    nfce_csc: keepSecret(50),
    ibs_uf_rate: rate.default(0.1),
    ibs_mun_rate: rate.default(0),
    cbs_rate: rate.default(0.9),
    inbound_auto_distribution: z.boolean().default(true),
    inbound_auto_acknowledge: z.boolean().default(false),
  })
  .superRefine(refineAddress);

const certificateSchema = z.object({
  certificate: z.string('Envie o arquivo do certificado.').trim().min(1, 'Envie o arquivo do certificado.'),
  password: z.string('Informe a senha do certificado.').min(1, 'Informe a senha do certificado.').max(200),
});

const BASE64_PATTERN = /^[A-Za-z0-9+/]+={0,2}$/;
const MAX_CERTIFICATE_BYTES = 100 * 1024;

type EmpresaCertificado = { subject_name?: string; not_valid_after?: string; cpf_cnpj?: string };

const hint = (secret: string | null) => (secret ? `••••${secret.slice(-4)}` : null);

const EMPTY_SETTINGS: Omit<FiscalSettingsRow, 'tenant_id' | 'updated_at'> = {
  environment: 'homologacao',
  acbr_client_id: null,
  acbr_client_secret: null,
  cnpj: null,
  legal_name: null,
  trade_name: null,
  state_registration: null,
  municipal_registration: null,
  cnae: null,
  tax_regime: null,
  email: null,
  phone: null,
  address_zip: null,
  address_street: null,
  address_number: null,
  address_complement: null,
  address_district: null,
  address_city: null,
  address_city_code: null,
  address_state: null,
  operation_nature: 'Venda de mercadoria',
  additional_info: null,
  nfe_series: 1,
  nfe_next_number: 1,
  nfce_series: 1,
  nfce_next_number: 1,
  nfce_csc_id: null,
  nfce_csc: null,
  ibs_uf_rate: 0.1,
  ibs_mun_rate: 0,
  cbs_rate: 0.9,
  inbound_auto_distribution: true,
  inbound_auto_acknowledge: false,
  inbound_last_nsu: 0,
  inbound_synced_at: null,
  certificate_subject: null,
  certificate_valid_until: null,
  certificate_uploaded_at: null,
  company_synced_at: null,
};

/** Dados que a ACBr API exige para cadastrar a empresa. */
function companyMissing(s: FiscalSettingsRow): string[] {
  const missing: [keyof FiscalSettingsRow, string][] = [
    ['cnpj', 'CNPJ'],
    ['legal_name', 'razão social'],
    ['email', 'e-mail'],
    ['address_street', 'logradouro'],
    ['address_number', 'número'],
    ['address_district', 'bairro'],
    ['address_city_code', 'código IBGE do município'],
    ['address_state', 'UF'],
    ['address_zip', 'CEP'],
  ];
  return missing.filter(([key]) => !s[key]).map(([, label]) => label);
}

/**
 * Cadastra (ou atualiza) a empresa na ACBr API e as configurações de NF-e, NFC-e
 * e distribuição. A ACBr completa a nota com estes dados quando algum falta.
 */
async function pushCompany(client: AcbrClient, s: FiscalSettingsRow & { cnpj: string }) {
  const empresa = {
    cpf_cnpj: s.cnpj,
    inscricao_estadual: s.state_registration ?? undefined,
    inscricao_municipal: s.municipal_registration ?? undefined,
    nome_razao_social: s.legal_name,
    nome_fantasia: s.trade_name ?? undefined,
    fone: s.phone ?? undefined,
    email: s.email,
    endereco: {
      logradouro: s.address_street,
      numero: s.address_number,
      complemento: s.address_complement ?? undefined,
      bairro: s.address_district,
      codigo_municipio: s.address_city_code,
      cidade: s.address_city ?? undefined,
      uf: s.address_state,
      codigo_pais: '1058',
      pais: 'Brasil',
      cep: s.address_zip,
    },
  };
  const cnpj = encodeURIComponent(s.cnpj);
  try {
    await client.request('PUT', `/empresas/${cnpj}`, { body: empresa });
  } catch (err) {
    if (!(err instanceof AcbrError && err.status === 404)) throw err;
    await client.request('POST', '/empresas', { body: empresa });
  }
  const crt = s.tax_regime ?? undefined;
  await client.request('PUT', `/empresas/${cnpj}/nfe`, { body: { CRT: crt, ambiente: s.environment } });
  if (s.nfce_csc_id && s.nfce_csc) {
    await client.request('PUT', `/empresas/${cnpj}/nfce`, {
      body: { CRT: crt, ambiente: s.environment, sefaz: { id_csc: Number(s.nfce_csc_id), csc: s.nfce_csc } },
    });
  }
  await client.request('PUT', `/empresas/${cnpj}/distnfe`, {
    body: {
      ambiente: s.environment,
      distribuicao_automatica: s.inbound_auto_distribution,
      ciencia_automatica: s.inbound_auto_acknowledge,
    },
  });
}

/** Dados da empresa para emissão e conta da ACBr API. Rotas de configuração: só administradores. */
export function fiscalSettingsRouter(ctx: AppContext) {
  const router = Router();
  router.use(requireAdmin);
  const platform = Boolean(ctx.config.acbr.platform);

  function toPublic(row: FiscalSettingsRow | null) {
    const s = row ?? { ...EMPTY_SETTINGS, tenant_id: 0, updated_at: null };
    const { acbr_client_secret, nfce_csc, tenant_id: _, ...rest } = s;
    return {
      ...rest,
      acbr_client_secret_hint: hint(acbr_client_secret),
      nfce_csc_hint: hint(nfce_csc),
      has_nfce_csc: Boolean(nfce_csc),
      /** Há conta da ACBr API na plataforma: a loja não precisa ter a sua. */
      acbr_platform_available: platform,
      /** Tem credenciais (próprias ou da plataforma) para falar com a ACBr API. */
      acbr_configured: Boolean(resolveCredentials(ctx.config.acbr, row)),
    };
  }

  router.get('/', async (req, res) => {
    const me = currentUser(req);
    const row = await withSession(ctx.pool, me, (db) => loadFiscalSettings(db, me.tenant_id));
    res.json({ settings: toPublic(row) });
  });

  router.put('/', async (req, res) => {
    const me = currentUser(req);
    const body = settingsSchema.parse(req.body);
    const row = await withSession(ctx.pool, me, async (db) => {
      const current = await loadFiscalSettings(db, me.tenant_id);
      // Conta própria: o segredo em branco mantém o salvo; sem client_id, volta para a conta da plataforma.
      const clientSecret = body.acbr_client_id ? (body.acbr_client_secret ?? current?.acbr_client_secret ?? null) : null;
      if (body.acbr_client_id && !clientSecret) throw new HttpError(400, 'Informe o client_secret da ACBr API.');
      const csc = body.nfce_csc_id ? (body.nfce_csc ?? current?.nfce_csc ?? null) : null;
      if (body.nfce_csc_id && !csc) throw new HttpError(400, 'Informe o código do CSC da NFC-e.');

      // O próximo número não pode voltar para um já usado (a SEFAZ recusa nota duplicada).
      const { rows: used } = await db.query<{ model: number; series: number; max: number }>(
        `select model, series, max(number) as max from fiscal_documents
          where environment = $1 group by model, series`,
        [body.environment],
      );
      for (const [model, label, seriesValue, next] of [
        [55, 'NF-e', body.nfe_series, body.nfe_next_number],
        [65, 'NFC-e', body.nfce_series, body.nfce_next_number],
      ] as const) {
        const last = used.find((u) => u.model === model && u.series === seriesValue)?.max;
        if (last && next <= last) {
          throw new HttpError(
            400,
            `O próximo número da ${label} (série ${seriesValue}) precisa ser maior que ${last}, o da última nota emitida.`,
          );
        }
      }

      // Outro ambiente ou outro CNPJ: a sequência de NSU da distribuição recomeça.
      const resetInbound = current && (current.environment !== body.environment || current.cnpj !== body.cnpj);
      const values = {
        ...body,
        acbr_client_secret: clientSecret,
        nfce_csc: csc,
      };
      const columns = Object.keys(values) as (keyof typeof values)[];
      const { rows } = await db.query<FiscalSettingsRow>(
        `insert into fiscal_settings (tenant_id, ${columns.join(', ')})
         values ($1, ${columns.map((_, i) => `$${i + 2}`).join(', ')})
         on conflict (tenant_id) do update
            set ${columns.map((c) => `${c} = excluded.${c}`).join(', ')},
                ${resetInbound ? 'inbound_last_nsu = 0, inbound_synced_at = null,' : ''}
                ${current && current.cnpj !== body.cnpj ? 'company_synced_at = null, certificate_subject = null, certificate_valid_until = null, certificate_uploaded_at = null,' : ''}
                updated_at = now()
         returning ${FISCAL_SETTINGS_COLUMNS}`,
        [me.tenant_id, ...columns.map((c) => values[c])],
      );
      return rows[0]!;
    });
    res.json({ settings: toPublic(row) });
  });

  /** Envia o cadastro para a ACBr API. A tela chama logo depois de salvar. */
  router.post('/sync', async (req, res) => {
    const me = currentUser(req);
    const settings = requireCnpj(await withSession(ctx.pool, me, (db) => loadFiscalSettings(db, me.tenant_id)), true);
    const missing = companyMissing(settings);
    if (missing.length) {
      throw new HttpError(422, `Para enviar à ACBr API, complete: ${missing.join(', ')}.`, 'FISCAL_INCOMPLETE');
    }
    const client = acbrClientFor(ctx, settings, true);
    try {
      await pushCompany(client, settings);
    } catch (err) {
      console.error('Falha ao cadastrar a empresa na ACBr API:', err);
      throw new HttpError(502, describeAcbrError(err), 'ACBR_FAILED');
    }
    const row = await withSession(ctx.pool, me, async (db) => {
      const { rows } = await db.query<FiscalSettingsRow>(
        `update fiscal_settings set company_synced_at = now() where tenant_id = $1 returning ${FISCAL_SETTINGS_COLUMNS}`,
        [me.tenant_id],
      );
      return rows[0]!;
    });
    res.json({ settings: toPublic(row) });
  });

  /**
   * Certificado A1 (.pfx/.p12) em base64. Vai direto para a ACBr API, que assina
   * as notas; o arquivo e a senha não ficam guardados aqui.
   */
  router.put('/certificate', async (req, res) => {
    const me = currentUser(req);
    const body = certificateSchema.parse(req.body);
    const base64 = body.certificate.replace(/^data:[^,]*;base64,/i, '').replace(/\s/g, '');
    if (!BASE64_PATTERN.test(base64) || base64.length % 4 !== 0) {
      throw new HttpError(400, 'O arquivo do certificado não está em base64 válido.');
    }
    const bytes = Buffer.from(base64, 'base64').byteLength;
    if (bytes === 0) throw new HttpError(400, 'O arquivo do certificado está vazio.');
    if (bytes > MAX_CERTIFICATE_BYTES) throw new HttpError(400, 'Arquivo grande demais para um certificado A1 (.pfx).');

    const settings = requireCnpj(await withSession(ctx.pool, me, (db) => loadFiscalSettings(db, me.tenant_id)), true);
    if (!settings.company_synced_at) {
      throw new HttpError(422, 'Salve os dados da empresa (e envie para a ACBr API) antes de enviar o certificado.');
    }
    const client = acbrClientFor(ctx, settings, true);
    let cert: EmpresaCertificado;
    try {
      cert = await client.request<EmpresaCertificado>('PUT', `/empresas/${encodeURIComponent(settings.cnpj)}/certificado`, {
        body: { certificado: base64, password: body.password },
      });
    } catch (err) {
      console.error('Falha ao enviar o certificado para a ACBr API:', err);
      // Senha errada ou arquivo que não é certificado chegam como 400 com a mensagem da ACBr.
      throw new HttpError(err instanceof AcbrError && err.status === 400 ? 400 : 502, describeAcbrError(err), 'ACBR_FAILED');
    }
    const row = await withSession(ctx.pool, me, async (db) => {
      const { rows } = await db.query<FiscalSettingsRow>(
        `update fiscal_settings
            set certificate_subject = $2, certificate_valid_until = $3, certificate_uploaded_at = now(), updated_at = now()
          where tenant_id = $1
         returning ${FISCAL_SETTINGS_COLUMNS}`,
        [me.tenant_id, cert?.subject_name ?? null, cert?.not_valid_after ?? null],
      );
      return rows[0]!;
    });
    res.json({ settings: toPublic(row) });
  });

  router.delete('/certificate', async (req, res) => {
    const me = currentUser(req);
    const settings = requireCnpj(await withSession(ctx.pool, me, (db) => loadFiscalSettings(db, me.tenant_id)), true);
    const client = acbrClientFor(ctx, settings, true);
    try {
      await client.request('DELETE', `/empresas/${encodeURIComponent(settings.cnpj)}/certificado`);
    } catch (err) {
      if (!(err instanceof AcbrError && err.status === 404)) {
        throw new HttpError(502, describeAcbrError(err), 'ACBR_FAILED');
      }
    }
    const row = await withSession(ctx.pool, me, async (db) => {
      const { rows } = await db.query<FiscalSettingsRow>(
        `update fiscal_settings
            set certificate_subject = null, certificate_valid_until = null, certificate_uploaded_at = null, updated_at = now()
          where tenant_id = $1
         returning ${FISCAL_SETTINGS_COLUMNS}`,
        [me.tenant_id],
      );
      return rows[0]!;
    });
    res.json({ settings: toPublic(row) });
  });

  /** Situação do serviço de autorização da SEFAZ da UF da empresa. */
  router.get('/sefaz-status', async (req, res) => {
    const me = currentUser(req);
    const model = req.query.model === '65' ? 'nfce' : 'nfe';
    const settings = requireCnpj(await withSession(ctx.pool, me, (db) => loadFiscalSettings(db, me.tenant_id)), true);
    const client = acbrClientFor(ctx, settings, true);
    try {
      const status = await client.request<{ codigo_status?: number; motivo_status?: string; tempo_medio_resposta?: number }>(
        'GET',
        `/${model}/sefaz/status`,
        { query: { cpf_cnpj: settings.cnpj } },
      );
      res.json({
        status: {
          code: status?.codigo_status ?? null,
          message: status?.motivo_status ?? null,
          average_seconds: status?.tempo_medio_resposta ?? null,
          // 107 = serviço em operação.
          online: status?.codigo_status === 107,
        },
      });
    } catch (err) {
      throw new HttpError(502, describeAcbrError(err), 'ACBR_FAILED');
    }
  });

  return router;
}

type CnpjResponse = {
  razao_social?: string;
  nome_fantasia?: string;
  email?: string;
  telefones?: { ddd?: string; numero?: string }[];
  situacao_cadastral?: { descricao?: string };
  endereco?: {
    tipo_logradouro?: string;
    logradouro?: string;
    numero?: string;
    complemento?: string;
    bairro?: string;
    cep?: string;
    uf?: string;
    municipio?: { codigo_ibge?: string; descricao?: string };
  };
};

type CepResponse = {
  logradouro?: string;
  tipo_logradouro?: string;
  complemento?: string;
  bairro?: string;
  municipio?: string;
  codigo_ibge?: string;
  uf?: string;
  cep?: string;
};

const street = (type?: string, name?: string) => [type, name].filter(Boolean).join(' ').trim() || null;

/**
 * Consulta de CNPJ e CEP pela ACBr API para preencher cadastros. Todos os
 * usuários usam (o vendedor completa o cadastro do cliente no balcão).
 */
export function fiscalLookupRouter(ctx: AppContext) {
  const router = Router();

  async function client(req: Request) {
    const me = currentUser(req);
    const settings = await withSession(ctx.pool, me, (db) => loadFiscalSettings(db, me.tenant_id));
    return acbrClientFor(ctx, settings, me.role === 'admin');
  }

  router.get('/cnpj/:cnpj', async (req, res) => {
    const cnpj = stripDocument(String(req.params.cnpj));
    if (!isValidCnpj(cnpj)) throw new HttpError(400, 'CNPJ inválido. Confira os números.');
    const acbr = await client(req);
    let data: CnpjResponse;
    try {
      data = await acbr.request<CnpjResponse>('GET', `/cnpj/${cnpj}`);
    } catch (err) {
      if (err instanceof AcbrError && err.status === 404) throw new HttpError(404, 'CNPJ não encontrado na Receita Federal.');
      throw new HttpError(502, describeAcbrError(err), 'ACBR_FAILED');
    }
    const phone = data.telefones?.find((t) => t.numero);
    const address = data.endereco;
    res.json({
      company: {
        cnpj,
        legal_name: data.razao_social ?? null,
        trade_name: data.nome_fantasia ?? null,
        email: data.email?.toLowerCase() ?? null,
        phone: phone ? `${phone.ddd ?? ''}${phone.numero}`.replace(/\D/g, '') : null,
        situation: data.situacao_cadastral?.descricao ?? null,
        address_zip: address?.cep?.replace(/\D/g, '') || null,
        address_street: street(address?.tipo_logradouro, address?.logradouro),
        address_number: address?.numero ?? null,
        address_complement: address?.complemento ?? null,
        address_district: address?.bairro ?? null,
        address_city: address?.municipio?.descricao ?? null,
        address_city_code: address?.municipio?.codigo_ibge ?? null,
        address_state: address?.uf ?? null,
      },
    });
  });

  router.get('/cep/:cep', async (req, res) => {
    const cep = String(req.params.cep).replace(/\D/g, '');
    if (!/^\d{8}$/.test(cep)) throw new HttpError(400, 'O CEP tem 8 dígitos.');
    const acbr = await client(req);
    let data: CepResponse;
    try {
      data = await acbr.request<CepResponse>('GET', `/cep/${cep}`);
    } catch (err) {
      if (err instanceof AcbrError && err.status === 404) throw new HttpError(404, 'CEP não encontrado.');
      throw new HttpError(502, describeAcbrError(err), 'ACBR_FAILED');
    }
    res.json({
      address: {
        address_zip: cep,
        address_street: street(data.tipo_logradouro, data.logradouro),
        address_complement: data.complemento || null,
        address_district: data.bairro ?? null,
        address_city: data.municipio ?? null,
        address_city_code: data.codigo_ibge ?? null,
        address_state: data.uf ?? null,
      },
    });
  });

  return router;
}
