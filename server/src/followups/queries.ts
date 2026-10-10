import type pg from 'pg';
import { formatMoney, formatOrderNumber } from '../lib/format.js';

/** Sem configurar nada, a retomada sai assim. */
export const DEFAULT_FOLLOWUP_DAYS = 3;
export const DEFAULT_FOLLOWUP_MESSAGE =
  'Olá, {cliente}! Aqui é {vendedor}, da {loja}. Passando para saber se ficou alguma dúvida no orçamento nº {pedido} ({total}). Posso ajudar a fechar?';

/** Placeholders aceitos na mensagem da retomada. */
export const FOLLOWUP_PLACEHOLDERS = ['{cliente}', '{vendedor}', '{loja}', '{pedido}', '{total}'] as const;

/**
 * Orçamento sem nenhum contato há mais que isso sai da lista de retomada (continua na
 * aba Orçamentos). Evita que a lista comece lotada de orçamentos antigos. Com um próximo
 * contato combinado, ele aparece no dia, por mais antigo que seja.
 */
export const FOLLOWUP_WINDOW_DAYS = 60;

/** Último contato com o cliente sobre o orçamento: criação, envio do PDF ou retomada. */
export const LAST_CONTACT_SQL = 'greatest(o.created_at, o.sent_at, o.last_followup_at)';

/**
 * Dia da próxima retomada: o combinado com o cliente ou os dias configurados depois do
 * último contato. $tz e $days são os parâmetros com o fuso da loja e followup_days.
 */
export function dueOnSql(tz: string, days: string) {
  return `coalesce(o.followup_on, (${LAST_CONTACT_SQL} at time zone ${tz})::date + ${days}::int)`;
}

/** Orçamento que ainda entra na retomada (ver FOLLOWUP_WINDOW_DAYS). */
export const IN_FOLLOWUP_SQL = `o.status = 'quote' and (o.followup_on is not null or ${LAST_CONTACT_SQL} >= now() - interval '${FOLLOWUP_WINDOW_DAYS} days')`;

export type FollowupSettings = { days: number; message: string | null };

/** Configuração da retomada da lojamestre. Precisa do contexto da lojamestre. */
export async function loadFollowupSettings(db: pg.PoolClient): Promise<FollowupSettings> {
  const { rows } = await db.query<{ followup_days: number; followup_message: string | null }>(
    'select followup_days, followup_message from settings limit 1',
  );
  return { days: rows[0]?.followup_days ?? DEFAULT_FOLLOWUP_DAYS, message: rows[0]?.followup_message ?? null };
}

const firstName = (name: string) => name.trim().split(/\s+/)[0] ?? '';

/** Troca os placeholders. {cliente} é como o cliente é chamado (ver greetingName); {vendedor}, o primeiro nome. */
export function renderFollowupMessage(
  template: string,
  values: { clientGreeting: string; sellerName: string; storeName: string; orderId: number; total: number },
) {
  const replacements: Record<string, string> = {
    '{cliente}': values.clientGreeting,
    '{vendedor}': firstName(values.sellerName),
    '{loja}': values.storeName,
    '{pedido}': formatOrderNumber(values.orderId),
    '{total}': formatMoney(values.total),
  };
  return template.replace(/\{(cliente|vendedor|loja|pedido|total)\}/gi, (match) => replacements[match.toLowerCase()] ?? match);
}

/** Quantos orçamentos estão para retomar hoje (do vendedor, quando informado). */
export async function countFollowupsDue(db: pg.PoolClient, timeZone: string, userId: number | null) {
  const { days } = await loadFollowupSettings(db);
  const { rows } = await db.query<{ count: number }>(
    `select count(*)::int as count
       from orders o
      where ${IN_FOLLOWUP_SQL}
        and ($3::bigint is null or o.user_id = $3)
        and ${dueOnSql('$1', '$2')} <= (now() at time zone $1)::date`,
    [timeZone, days, userId],
  );
  return rows[0]?.count ?? 0;
}
