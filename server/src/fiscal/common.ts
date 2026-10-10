import type { AppContext } from '../context.js';
import type { Db } from '../db/pool.js';
import { HttpError } from '../errors.js';
import { AcbrClient, resolveCredentials } from './acbr.js';
import type { FiscalCompany, InvoiceModel } from './invoice.js';

export type FiscalSettingsRow = FiscalCompany & {
  tenant_id: number;
  acbr_client_id: string | null;
  acbr_client_secret: string | null;
  email: string | null;
  nfe_series: number;
  nfe_next_number: number;
  nfce_series: number;
  nfce_next_number: number;
  nfce_csc_id: string | null;
  nfce_csc: string | null;
  inbound_auto_distribution: boolean;
  inbound_auto_acknowledge: boolean;
  inbound_last_nsu: number;
  inbound_synced_at: Date | null;
  certificate_subject: string | null;
  certificate_valid_until: Date | null;
  certificate_uploaded_at: Date | null;
  company_synced_at: Date | null;
  updated_at: Date;
};

export const FISCAL_SETTINGS_COLUMNS = `tenant_id, environment, acbr_client_id, acbr_client_secret, cnpj, legal_name,
  trade_name, state_registration, municipal_registration, cnae, tax_regime, email, phone, address_zip,
  address_street, address_number, address_complement, address_district, address_city, address_city_code,
  address_state, operation_nature, additional_info, nfe_series, nfe_next_number, nfce_series, nfce_next_number,
  nfce_csc_id, nfce_csc, ibs_uf_rate, ibs_mun_rate, cbs_rate, inbound_auto_distribution, inbound_auto_acknowledge,
  inbound_last_nsu, inbound_synced_at, certificate_subject, certificate_valid_until, certificate_uploaded_at,
  company_synced_at, updated_at`;

/** Precisa rodar no contexto da lojamestre: fiscal_settings tem RLS. */
export async function loadFiscalSettings(db: Db, tenantId: number): Promise<FiscalSettingsRow | null> {
  const { rows } = await db.query<FiscalSettingsRow>(
    `select ${FISCAL_SETTINGS_COLUMNS} from fiscal_settings where tenant_id = $1`,
    [tenantId],
  );
  return rows[0] ?? null;
}

export const modelPath = (model: InvoiceModel) => (model === 55 ? 'nfe' : 'nfce');
export const modelLabel = (model: InvoiceModel) => (model === 55 ? 'NF-e' : 'NFC-e');

/** Cliente da ACBr API com a conta da lojamestre (ou a da plataforma). */
export function acbrClientFor(ctx: AppContext, settings: FiscalSettingsRow | null, isAdmin: boolean): AcbrClient {
  const credentials = resolveCredentials(ctx.config.acbr, settings);
  if (!credentials) {
    throw new HttpError(
      422,
      isAdmin
        ? 'A ACBr API ainda não está configurada. Informe o client_id e o client_secret em Configurações → Fiscal.'
        : 'A emissão fiscal ainda não foi configurada. Peça ao administrador para preencher Configurações → Fiscal.',
      'FISCAL_NOT_CONFIGURED',
    );
  }
  return new AcbrClient(ctx.config.acbr, credentials);
}

/** O CNPJ identifica a empresa na ACBr API: sem ele não há o que consultar. */
export function requireCnpj(settings: FiscalSettingsRow | null, isAdmin: boolean): FiscalSettingsRow & { cnpj: string } {
  if (!settings?.cnpj) {
    throw new HttpError(
      422,
      isAdmin
        ? 'Cadastre os dados da empresa em Configurações → Fiscal antes de continuar.'
        : 'A emissão fiscal ainda não foi configurada. Peça ao administrador para preencher Configurações → Fiscal.',
      'FISCAL_NOT_CONFIGURED',
    );
  }
  return settings as FiscalSettingsRow & { cnpj: string };
}

/**
 * Antes de reservar um número: a empresa precisa estar na ACBr API com o
 * certificado, e a NFC-e precisa do CSC. O que falta é dito de uma vez.
 */
export function readinessProblems(settings: FiscalSettingsRow, model: InvoiceModel): string[] {
  const problems: string[] = [];
  if (!settings.company_synced_at) {
    problems.push('Os dados da empresa ainda não foram enviados para a ACBr API. Salve em Configurações → Fiscal.');
  }
  if (!settings.certificate_valid_until) {
    problems.push('Envie o certificado digital A1 da empresa em Configurações → Fiscal.');
  } else if (settings.certificate_valid_until.getTime() < Date.now()) {
    problems.push('O certificado digital da empresa venceu. Envie o novo certificado em Configurações → Fiscal.');
  }
  if (model === 65 && (!settings.nfce_csc_id || !settings.nfce_csc)) {
    problems.push('A NFC-e precisa do CSC (identificador e código) cadastrado em Configurações → Fiscal.');
  }
  return problems;
}

export function invalidFiscalData(problems: string[]): HttpError {
  return new HttpError(422, 'A nota não pode ser emitida. Corrija o que falta e tente de novo.', 'FISCAL_INVALID', {
    problems,
  });
}
