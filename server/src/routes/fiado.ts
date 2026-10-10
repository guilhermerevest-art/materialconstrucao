import { Router } from 'express';
import type pg from 'pg';
import { z } from 'zod';
import { currentUser, requireAdmin, type AuthUser } from '../auth.js';
import type { AppContext } from '../context.js';
import { queryAs, withSession } from '../db/session.js';
import { HttpError } from '../errors.js';
import {
  DEFAULT_FIADO_MESSAGE,
  loadAccount,
  loadFiadoSettings,
  receiveFiado,
  reverseFiadoPayment,
  type FiadoAccount,
} from '../fiado/queries.js';
import { describeEvolutionError, keySourceOf, loadEvolutionSettings, sendPdfDocument, sendTextMessage } from '../lib/evolution.js';
import { formatDay, formatMoney, todayIn } from '../lib/format.js';
import { greetingName } from '../lib/greeting.js';
import { normalizeWhatsapp } from '../lib/phone.js';
import { likePattern, optionalQuery, optionalText, pagination, parseId } from '../lib/validation.js';
import { renderFiadoPdf } from '../pdf/fiadoPdf.js';

const percent = (max: number) =>
  z
    .number('Informe o percentual.')
    .min(0, `Use de 0 a ${max}%.`)
    .max(max, `Use de 0 a ${max}%.`)
    .transform((v) => Math.round(v * 100) / 100);

const settingsSchema = z.object({
  enabled: z.boolean(),
  due_day: z.number('Informe o dia do vencimento.').int().min(1, 'Use um dia de 1 a 28.').max(28, 'Use um dia de 1 a 28.'),
  block_days: z.number('Informe a tolerância.').int().min(0).max(365, 'Use até 365 dias.'),
  late_fee_percent: percent(20),
  interest_percent: percent(20),
  message: optionalText(1000),
});

const listSchema = z.object({
  status: z.enum(['open', 'overdue', 'all']).default('open'),
  q: optionalQuery,
  ...pagination,
});

const money = z
  .number('Informe o valor.')
  .positive('O valor precisa ser maior que zero.')
  .max(99_999_999)
  .transform((v) => Math.round(v * 100) / 100);

const paymentSchema = z.object({
  amount: money,
  payment_method_id: z.number('Escolha a forma de pagamento.').int().positive('Escolha a forma de pagamento.'),
  waive_charges: z.boolean().default(false),
  note: optionalText(200),
});

const reverseSchema = z.object({
  reason: z.string('Informe o motivo.').trim().min(3, 'Informe o motivo.').max(300),
});

const adjustmentSchema = z.object({
  // Positivo: o cliente passa a dever mais; negativo: abate.
  amount: z
    .number('Informe o valor.')
    .refine((v) => v !== 0, 'O ajuste não pode ser zero.')
    .refine((v) => Math.abs(v) <= 99_999_999, 'Valor alto demais.')
    .transform((v) => Math.round(v * 100) / 100),
  description: z.string('Informe o motivo.').trim().min(3, 'Informe o motivo do ajuste.').max(200),
});

const dueDaySchema = z.object({
  due_day: z.number().int().min(1, 'Use um dia de 1 a 28.').max(28, 'Use um dia de 1 a 28.').nullable(),
});

const whatsappSchema = z.object({
  message: optionalText(1000),
  with_pdf: z.boolean().default(true),
});

const CLIENT_NOT_FOUND = 'Cliente não encontrado.';

type ClientRow = {
  id: number;
  name: string;
  whatsapp: string;
  contact_name: string | null;
  person_type: string | null;
  credit_limit: number | null;
  fiado_due_day: number | null;
};

async function loadClient(db: pg.PoolClient, id: number): Promise<ClientRow> {
  const { rows } = await db.query<ClientRow>(
    'select id, name, whatsapp, contact_name, person_type, credit_limit, fiado_due_day from clients where id = $1',
    [id],
  );
  if (!rows[0]) throw new HttpError(404, CLIENT_NOT_FOUND);
  return rows[0];
}

/** Lançamentos com o saldo depois de cada um (os cancelados aparecem, sem mexer no saldo). */
async function loadStatement(db: pg.PoolClient, clientId: number) {
  const { rows } = await db.query<{
    id: number;
    kind: string;
    amount: number;
    due_date: string | null;
    description: string | null;
    order_id: number | null;
    payment_method_name: string | null;
    cash_session_id: number | null;
    created_at: Date;
    user_name: string;
    cancelled_at: Date | null;
    cancel_reason: string | null;
  }>(
    `select e.id, e.kind, e.amount, e.due_date::text as due_date, e.description, e.order_id, e.payment_method_name,
            e.cash_session_id, e.created_at, u.name as user_name, e.cancelled_at, e.cancel_reason
       from fiado_entries e join users u on u.id = e.user_id
      where e.client_id = $1
      order by e.created_at, e.id`,
    [clientId],
  );
  let balance = 0;
  return rows.map((entry) => {
    if (!entry.cancelled_at) balance = Math.round((balance + entry.amount) * 100) / 100;
    return { ...entry, balance_after: entry.cancelled_at ? null : balance };
  });
}

/** Parcelas do crediário em aberto: o limite vale para crediário e fiado juntos. */
async function openStoreCredit(db: pg.PoolClient, clientId: number) {
  const { rows } = await db.query<{ open: number }>(
    `select coalesce(sum(amount - paid_amount), 0) as open from receivables
      where client_id = $1 and status = 'open' and kind = 'store_credit'`,
    [clientId],
  );
  return rows[0]?.open ?? 0;
}

function renderMessage(template: string, client: ClientRow, storeName: string, account: FiadoAccount) {
  const overdue = account.overdue > 0 ? `, com ${formatMoney(account.overdue)} vencido desde ${formatDay(account.oldest_overdue!)}` : '';
  const replacements: Record<string, string> = {
    '{cliente}': greetingName(client),
    '{loja}': storeName,
    '{saldo}': formatMoney(Math.max(0, account.balance)),
    '{vencido}': overdue,
    '{vencimento}': account.next_due ? formatDay(account.next_due) : '',
  };
  return template.replace(/\{(cliente|loja|saldo|vencido|vencimento)\}/gi, (m) => replacements[m.toLowerCase()] ?? m);
}

/** Loja que aparece no extrato e na mensagem: a de quem está usando, ou a primeira. */
async function storeName(db: pg.PoolClient, user: AuthUser) {
  const { rows } = await db.query<{ name: string }>(
    'select name from stores where ($1::bigint is null or id = $1) order by id limit 1',
    [user.store_id],
  );
  return rows[0]?.name ?? '';
}

/** Fiado (caderneta): contas, recebimento, estorno, ajuste, extrato e cobrança. */
export function fiadoRouter(ctx: AppContext) {
  const router = Router();
  const { pool, config } = ctx;
  const tz = config.timeZone;

  async function assertEnabled(db: pg.PoolClient) {
    if (!(await loadFiadoSettings(db)).enabled) {
      throw new HttpError(409, 'O fiado está desligado. O administrador liga em Configurações → Fiado.', 'FIADO_DISABLED');
    }
  }

  // ---- Configuração

  router.get('/fiado/settings', requireAdmin, async (req, res) => {
    const settings = await withSession(pool, currentUser(req), loadFiadoSettings);
    res.json({ settings: { ...settings, default_message: DEFAULT_FIADO_MESSAGE } });
  });

  router.put('/fiado/settings', requireAdmin, async (req, res) => {
    const me = currentUser(req);
    const body = settingsSchema.parse(req.body);
    const settings = await withSession(pool, me, async (db) => {
      await db.query(
        `insert into settings (tenant_id, fiado_enabled, fiado_due_day, fiado_block_days, fiado_late_fee_percent,
                               fiado_interest_percent, fiado_message)
         values ($1, $2, $3, $4, $5, $6, $7)
         on conflict (tenant_id) do update
            set fiado_enabled = excluded.fiado_enabled, fiado_due_day = excluded.fiado_due_day,
                fiado_block_days = excluded.fiado_block_days, fiado_late_fee_percent = excluded.fiado_late_fee_percent,
                fiado_interest_percent = excluded.fiado_interest_percent, fiado_message = excluded.fiado_message,
                updated_at = now()`,
        [me.tenant_id, body.enabled, body.due_day, body.block_days, body.late_fee_percent, body.interest_percent, body.message],
      );
      // Ligado, o PDV precisa da forma "Fiado" para vender na caderneta.
      if (body.enabled) {
        const { rowCount } = await db.query("select 1 from payment_methods where kind = 'fiado'");
        if (!rowCount) {
          await db.query(
            `insert into payment_methods (tenant_id, name, kind, installments, first_due_days, interval_days)
             values ($1, 'Fiado', 'fiado', 1, 0, 30)
             on conflict (tenant_id, lower(name)) do update set kind = 'fiado', active = true`,
            [me.tenant_id],
          );
        }
      }
      return loadFiadoSettings(db);
    });
    res.json({ settings: { ...settings, default_message: DEFAULT_FIADO_MESSAGE } });
  });

  // ---- Contas

  /** Clientes com fiado: saldo, vencido (abatendo das compras mais antigas) e o próximo vencimento. */
  router.get('/fiado/accounts', async (req, res) => {
    const user = currentUser(req);
    const query = listSchema.parse(req.query);
    const data = await withSession(pool, user, async (db) => {
      await assertEnabled(db);
      const { rows } = await db.query(
        `with e as (
           select client_id, id, amount, due_date from fiado_entries where cancelled_at is null
         ), totals as (
           select client_id, sum(amount) as balance, coalesce(-sum(amount) filter (where amount < 0), 0) as credits
             from e group by client_id
         ), deb as (
           select e.client_id, e.due_date, e.amount,
                  sum(e.amount) over (partition by e.client_id order by e.due_date, e.id) as cum
             from e where e.amount > 0
         ), open_debits as (
           select d.client_id, d.due_date, least(d.amount, d.cum - t.credits) as remaining
             from deb d join totals t using (client_id)
            where d.cum > t.credits
         ), accounts as (
           select c.id as client_id, c.name as client_name, c.whatsapp as client_whatsapp, c.credit_limit,
                  t.balance,
                  coalesce(sum(o.remaining) filter (where o.due_date < $1::date), 0) as overdue,
                  min(o.due_date) filter (where o.due_date < $1::date) as oldest_overdue,
                  min(o.due_date) filter (where o.due_date >= $1::date) as next_due,
                  (select max(p.created_at) from fiado_entries p
                    where p.client_id = c.id and p.kind = 'payment' and p.cancelled_at is null) as last_payment_at
             from totals t
             join clients c on c.id = t.client_id
             left join open_debits o on o.client_id = t.client_id
            group by c.id, t.balance
         )
         select a.*, a.oldest_overdue::text as oldest_overdue, a.next_due::text as next_due,
                case when a.oldest_overdue is null then 0 else $1::date - a.oldest_overdue end as days_late,
                count(*) over () as total_count,
                sum(greatest(a.balance, 0)) over () as total_balance,
                sum(a.overdue) over () as total_overdue,
                count(*) filter (where a.overdue > 0) over () as overdue_clients
           from accounts a
          where ($2::text = 'all' or ($2::text = 'open' and a.balance > 0) or ($2::text = 'overdue' and a.overdue > 0))
            and ($3::text is null or search_norm(a.client_name) like search_norm($3))
          order by a.overdue desc, a.oldest_overdue nulls last, a.balance desc, a.client_name
          limit $4 offset $5`,
        [todayIn(tz), query.status, query.q ? likePattern(query.q) : null, query.page_size, (query.page - 1) * query.page_size],
      );
      const first = rows[0];
      return {
        items: rows.map(({ total_count: _, total_balance: _b, total_overdue: _o, overdue_clients: _c, ...row }) => row),
        total: first?.total_count ?? 0,
        totals: {
          balance: first?.total_balance ?? 0,
          overdue: first?.total_overdue ?? 0,
          overdue_clients: first?.overdue_clients ?? 0,
        },
      };
    });
    res.json({ ...data, page: query.page, page_size: query.page_size });
  });

  /** Conta do cliente: situação, extrato, limite e a mensagem de cobrança pronta. */
  router.get('/fiado/accounts/:clientId', async (req, res) => {
    const user = currentUser(req);
    const clientId = parseId(req.params.clientId, CLIENT_NOT_FOUND);
    const data = await withSession(pool, user, async (db) => {
      await assertEnabled(db);
      const settings = await loadFiadoSettings(db);
      const client = await loadClient(db, clientId);
      const account = await loadAccount(db, clientId, tz, settings);
      const otherDebt = await openStoreCredit(db, clientId);
      const debt = Math.max(0, account.balance) + otherDebt;
      return {
        client: { id: client.id, name: client.name, whatsapp: client.whatsapp, credit_limit: client.credit_limit, fiado_due_day: client.fiado_due_day },
        account,
        due_day: client.fiado_due_day ?? settings.due_day,
        store_credit_open: otherDebt,
        available: client.credit_limit === null ? null : Math.max(0, Math.round((client.credit_limit - debt) * 100) / 100),
        blocked: account.days_late > settings.block_days,
        entries: await loadStatement(db, clientId),
        message: renderMessage(settings.message ?? DEFAULT_FIADO_MESSAGE, client, await storeName(db, user), account),
      };
    });
    res.json(data);
  });

  router.post('/fiado/accounts/:clientId/payments', async (req, res) => {
    const user = currentUser(req);
    const clientId = parseId(req.params.clientId, CLIENT_NOT_FOUND);
    const body = paymentSchema.parse(req.body);
    const receipt = await withSession(pool, user, async (db) => {
      await loadClient(db, clientId);
      return receiveFiado(db, user, clientId, body, tz);
    });
    res.status(201).json({ receipt });
  });

  router.post('/fiado/entries/:id/reverse', async (req, res) => {
    const user = currentUser(req);
    const id = parseId(req.params.id, 'Recebimento não encontrado.');
    const body = reverseSchema.parse(req.body);
    await withSession(pool, user, (db) => reverseFiadoPayment(db, id, user, body.reason));
    res.status(204).end();
  });

  /** Ajuste manual (só o admin): saldo de caderneta antiga, acerto, perdão de dívida. */
  router.post('/fiado/accounts/:clientId/adjustments', requireAdmin, async (req, res) => {
    const user = currentUser(req);
    const clientId = parseId(req.params.clientId, CLIENT_NOT_FOUND);
    const body = adjustmentSchema.parse(req.body);
    await withSession(pool, user, async (db) => {
      await assertEnabled(db);
      await loadClient(db, clientId);
      await db.query(
        `insert into fiado_entries (tenant_id, store_id, client_id, kind, amount, due_date, description, user_id)
         values ($1, $2, $3, 'adjustment', $4, $5, $6, $7)`,
        [user.tenant_id, user.store_id, clientId, body.amount, body.amount > 0 ? todayIn(tz) : null, body.description, user.id],
      );
    });
    res.status(201).json({ ok: true });
  });

  /** Dia de vencimento próprio do cliente (nulo = o da loja). Vale para as próximas compras. */
  router.put('/fiado/accounts/:clientId/due-day', requireAdmin, async (req, res) => {
    const clientId = parseId(req.params.clientId, CLIENT_NOT_FOUND);
    const body = dueDaySchema.parse(req.body);
    const { rowCount } = await queryAs(pool, currentUser(req), 'update clients set fiado_due_day = $2 where id = $1', [
      clientId,
      body.due_day,
    ]);
    if (!rowCount) throw new HttpError(404, CLIENT_NOT_FOUND);
    res.status(204).end();
  });

  async function statementPdf(db: pg.PoolClient, user: AuthUser, clientId: number) {
    const settings = await loadFiadoSettings(db);
    const client = await loadClient(db, clientId);
    const account = await loadAccount(db, clientId, tz, settings);
    const entries = (await loadStatement(db, clientId)).filter((e) => !e.cancelled_at);
    const pdf = await renderFiadoPdf(
      {
        storeName: await storeName(db, user),
        client,
        balance: account.balance,
        overdue: account.overdue,
        oldestOverdue: account.oldest_overdue,
        nextDue: account.next_due,
        nextDueAmount: account.next_due_amount,
        charges: account.charges,
        entries: entries.map((e) => ({ ...e, balance_after: e.balance_after ?? 0 })),
      },
      tz,
    );
    return { client, account, settings, pdf };
  }

  router.get('/fiado/accounts/:clientId/pdf', async (req, res) => {
    const user = currentUser(req);
    const clientId = parseId(req.params.clientId, CLIENT_NOT_FOUND);
    const { client, pdf } = await withSession(pool, user, async (db) => {
      await assertEnabled(db);
      return statementPdf(db, user, clientId);
    });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `${req.query.download === '1' ? 'attachment' : 'inline'}; filename="extrato-fiado-${client.id}.pdf"`);
    res.setHeader('Cache-Control', 'no-store');
    res.send(pdf);
  });

  /** Cobrança pelo WhatsApp da loja: a mensagem (editável) e, se quiser, o extrato em PDF. */
  router.post('/fiado/accounts/:clientId/whatsapp', async (req, res) => {
    const user = currentUser(req);
    const clientId = parseId(req.params.clientId, CLIENT_NOT_FOUND);
    const body = whatsappSchema.parse(req.body);
    const prepared = await withSession(pool, user, async (db) => {
      await assertEnabled(db);
      const evolution = await loadEvolutionSettings(db, user.tenant_id);
      const data = await statementPdf(db, user, clientId);
      const message = body.message ?? renderMessage(data.settings.message ?? DEFAULT_FIADO_MESSAGE, data.client, await storeName(db, user), data.account);
      return { ...data, evolution, message };
    });
    if (!prepared.evolution) {
      throw new HttpError(422, 'O envio por WhatsApp ainda não foi configurado. Baixe o extrato em PDF e mande pelo celular.', 'WHATSAPP_NOT_CONFIGURED');
    }
    const number = /^\d{8,15}$/.test(prepared.client.whatsapp) ? prepared.client.whatsapp : normalizeWhatsapp(prepared.client.whatsapp);
    if (!number) throw new HttpError(422, 'O WhatsApp do cliente é inválido. Corrija o cadastro do cliente.', 'WHATSAPP_INVALID_NUMBER');
    try {
      if (body.with_pdf) {
        await sendPdfDocument(
          prepared.evolution,
          { number, pdf: prepared.pdf, fileName: `extrato-fiado-${prepared.client.id}.pdf`, caption: prepared.message },
          config.evolutionTimeoutMs,
        );
      } else {
        await sendTextMessage(prepared.evolution, { number, text: prepared.message }, config.evolutionTimeoutMs);
      }
    } catch (err) {
      console.error(`Falha ao mandar o extrato do fiado do cliente ${clientId} pela EvolutionAPI:`, err);
      throw new HttpError(502, describeEvolutionError(err, keySourceOf(prepared.evolution, config.evolutionServer)), 'WHATSAPP_FAILED');
    }
    res.json({ sent: true });
  });

  return router;
}
