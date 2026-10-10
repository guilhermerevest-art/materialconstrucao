import { Router } from 'express';
import { z } from 'zod';
import { currentUser, requireAdmin } from '../auth.js';
import type { AppContext } from '../context.js';
import { queryAs, withSession } from '../db/session.js';
import { HttpError } from '../errors.js';
import {
  DEFAULT_FOLLOWUP_DAYS,
  DEFAULT_FOLLOWUP_MESSAGE,
  dueOnSql,
  IN_FOLLOWUP_SQL,
  LAST_CONTACT_SQL,
  loadFollowupSettings,
  renderFollowupMessage,
} from '../followups/queries.js';
import { describeEvolutionError, keySourceOf, loadEvolutionSettings, sendPdfDocument, sendTextMessage } from '../lib/evolution.js';
import { todayIn } from '../lib/format.js';
import { likePattern, optionalQuery, optionalQueryId, optionalText, pagination, parseId } from '../lib/validation.js';
import { greetingName } from '../lib/greeting.js';
import { loadOrderDetail, orderGreeting } from '../orders/queries.js';
import { orderFileName, renderOrderPdf } from '../pdf/orderPdf.js';
import { clientNumber } from './orders.js';

const settingsSchema = z.object({
  followup_days: z
    .number('Informe em quantos dias.')
    .int('Use um número inteiro de dias.')
    .min(1, 'Use de 1 a 60 dias.')
    .max(60, 'Use de 1 a 60 dias.'),
  // Vazio volta para a mensagem padrão.
  followup_message: optionalText(1000),
});

const listSchema = z.object({
  scope: z.enum(['due', 'upcoming', 'all']).default('due'),
  q: optionalQuery,
  store_id: optionalQueryId,
  mine: z.enum(['true', 'false']).optional(),
  ...pagination,
});

const followupSchema = z
  .object({
    channel: z.enum(['whatsapp', 'call', 'visit', 'other'], 'Escolha como foi o contato.'),
    note: optionalText(300),
    // Só no WhatsApp: o texto enviado. Vazio usa a mensagem configurada.
    message: optionalText(1000),
    with_pdf: z.boolean().default(false),
    next_on: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/, 'Data inválida.')
      .nullable()
      .default(null),
  })
  .superRefine((body, ctx) => {
    if (body.channel !== 'whatsapp' && !body.note) {
      ctx.addIssue({ code: 'custom', message: 'Conte em poucas palavras como foi a conversa.', path: ['note'] });
    }
  });

const NOT_FOUND = 'Orçamento não encontrado.';
const MAX_NEXT_DAYS = 365;

function addDaysIso(iso: string, days: number) {
  const date = new Date(`${iso}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

/**
 * Retomada de orçamentos: a lista do que está para retomar, o histórico de contatos e o
 * registro de cada contato (WhatsApp enviado daqui, ligação, visita).
 */
export function followupsRouter(ctx: AppContext) {
  const router = Router();
  const { pool, config } = ctx;
  const tz = config.timeZone;

  router.get('/followups/settings', requireAdmin, async (req, res) => {
    const { rows } = await queryAs(pool, currentUser(req), 'select followup_days, followup_message from settings limit 1');
    res.json({
      settings: {
        followup_days: rows[0]?.followup_days ?? DEFAULT_FOLLOWUP_DAYS,
        followup_message: rows[0]?.followup_message ?? null,
        default_message: DEFAULT_FOLLOWUP_MESSAGE,
      },
    });
  });

  router.put('/followups/settings', requireAdmin, async (req, res) => {
    const me = currentUser(req);
    const body = settingsSchema.parse(req.body);
    const { rows } = await queryAs(
      pool,
      me,
      `insert into settings (tenant_id, followup_days, followup_message)
       values ($1, $2, $3)
       on conflict (tenant_id) do update
          set followup_days = excluded.followup_days, followup_message = excluded.followup_message, updated_at = now()
       returning followup_days, followup_message`,
      [me.tenant_id, body.followup_days, body.followup_message],
    );
    res.json({ settings: { ...rows[0], default_message: DEFAULT_FOLLOWUP_MESSAGE } });
  });

  /** Orçamentos para retomar: hoje e atrasados (due), os próximos (upcoming) ou todos. */
  router.get('/followups', async (req, res) => {
    const user = currentUser(req);
    const query = listSchema.parse(req.query);

    const data = await withSession(pool, user, async (db) => {
      const { days } = await loadFollowupSettings(db);
      const params: unknown[] = [tz, days];
      const param = (value: unknown) => {
        params.push(value);
        return `$${params.length}`;
      };
      const dueOn = dueOnSql('$1', '$2');
      const today = '(now() at time zone $1)::date';

      const where = [IN_FOLLOWUP_SQL];
      if (query.scope === 'due') where.push(`${dueOn} <= ${today}`);
      if (query.scope === 'upcoming') where.push(`${dueOn} > ${today}`);
      if (user.role === 'seller') where.push(`o.store_id = ${param(user.store_id)}`);
      else if (query.store_id) where.push(`o.store_id = ${param(query.store_id)}`);
      if (query.mine === 'true') where.push(`o.user_id = ${param(user.id)}`);
      if (query.q) {
        const conditions = [`search_norm(c.name) like search_norm(${param(likePattern(query.q))})`];
        if (/^\d{1,12}$/.test(query.q)) conditions.push(`o.id = ${param(Number(query.q))}`);
        where.push(`(${conditions.join(' or ')})`);
      }

      const limit = param(query.page_size);
      const offset = param((query.page - 1) * query.page_size);
      const { rows } = await db.query(
        `select o.id, o.total_amount, o.created_at, o.sent_at, o.followup_count, o.followup_on,
                ${LAST_CONTACT_SQL} as last_contact_at,
                ${dueOn}::text as due_on,
                (${today} - ${dueOn})::int as days_late,
                o.store_id, s.name as store_name, o.user_id, u.name as user_name,
                o.client_id, c.name as client_name, c.whatsapp as client_whatsapp,
                last.channel as last_channel, last.note as last_note,
                count(*) over () as total_count
           from orders o
           join clients c on c.id = o.client_id
           join stores s on s.id = o.store_id
           join users u on u.id = o.user_id
           left join lateral (
             select f.channel, f.note from order_followups f where f.order_id = o.id order by f.created_at desc, f.id desc limit 1
           ) last on true
          where ${where.join(' and ')}
          order by ${dueOn}, ${LAST_CONTACT_SQL}, o.id
          limit ${limit} offset ${offset}`,
        params,
      );
      return { rows, days };
    });

    res.json({
      items: data.rows.map(({ total_count: _, ...row }) => row),
      total: data.rows[0]?.total_count ?? 0,
      page: query.page,
      page_size: query.page_size,
      days: data.days,
    });
  });

  /** Histórico de contatos do orçamento e a mensagem sugerida para a próxima retomada. */
  router.get('/orders/:id/followups', async (req, res) => {
    const user = currentUser(req);
    const id = parseId(req.params.id, NOT_FOUND);
    const data = await withSession(pool, user, async (db) => {
      const settings = await loadFollowupSettings(db);
      const { rows: orders } = await db.query(
        `select o.id, o.status, o.total_amount, o.followup_count, o.followup_on,
                ${LAST_CONTACT_SQL} as last_contact_at, ${dueOnSql('$2', '$3')}::text as due_on,
                c.name as client_name, c.contact_name, c.person_type, s.name as store_name
           from orders o
           join clients c on c.id = o.client_id
           join stores s on s.id = o.store_id
          where o.id = $1`,
        [id, tz, settings.days],
      );
      const order = orders[0];
      if (!order) return null;
      const { rows: history } = await db.query(
        `select f.id, f.channel, f.note, f.message, f.with_pdf, f.next_on::text as next_on, f.created_at,
                f.user_id, u.name as user_name
           from order_followups f
           join users u on u.id = f.user_id
          where f.order_id = $1
          order by f.created_at desc, f.id desc`,
        [id],
      );
      const message = renderFollowupMessage(settings.message ?? DEFAULT_FOLLOWUP_MESSAGE, {
        clientGreeting: greetingName({ name: order.client_name, contact_name: order.contact_name, person_type: order.person_type }),
        sellerName: user.name,
        storeName: order.store_name,
        orderId: order.id,
        total: order.total_amount,
      });
      return {
        status: order.status as string,
        followup_count: order.followup_count as number,
        followup_on: order.followup_on as string | null,
        last_contact_at: order.last_contact_at as Date,
        due_on: order.due_on as string,
        days: settings.days,
        message,
        items: history,
      };
    });
    if (!data) throw new HttpError(404, NOT_FOUND);
    res.json(data);
  });

  /**
   * Registra um contato de retomada. No WhatsApp, a mensagem (com o PDF, se pedido) sai
   * daqui antes de registrar; se o envio falhar, nada é gravado.
   */
  router.post('/orders/:id/followups', async (req, res) => {
    const user = currentUser(req);
    const id = parseId(req.params.id, NOT_FOUND);
    const body = followupSchema.parse(req.body);

    const today = todayIn(tz);
    if (body.next_on && body.next_on <= today) {
      throw new HttpError(422, 'O próximo contato precisa ser a partir de amanhã.');
    }
    if (body.next_on && body.next_on > addDaysIso(today, MAX_NEXT_DAYS)) {
      throw new HttpError(422, 'Marque o próximo contato para até um ano.');
    }

    const { order, settings } = await withSession(pool, user, async (db) => ({
      order: await loadOrderDetail(db, id),
      settings: await loadFollowupSettings(db),
    }));
    if (!order) throw new HttpError(404, NOT_FOUND);
    if (order.status !== 'quote') {
      throw new HttpError(409, 'Só orçamento em aberto tem retomada. Pedido confirmado ou perdido sai da lista.');
    }

    let message: string | null = null;
    let withPdf = false;
    if (body.channel === 'whatsapp') {
      const evolution = await withSession(pool, user, (db) => loadEvolutionSettings(db, user.tenant_id));
      if (!evolution) {
        throw new HttpError(
          422,
          'O envio por WhatsApp ainda não foi configurado. Registre o contato como ligação ou peça ao administrador para conectar o WhatsApp.',
          'WHATSAPP_NOT_CONFIGURED',
        );
      }
      const number = clientNumber(order);
      if (!number) {
        throw new HttpError(422, 'O WhatsApp do cliente é inválido. Corrija o cadastro do cliente e tente de novo.', 'WHATSAPP_INVALID_NUMBER');
      }
      message =
        body.message ??
        renderFollowupMessage(settings.message ?? DEFAULT_FOLLOWUP_MESSAGE, {
          clientGreeting: orderGreeting(order),
          sellerName: user.name,
          storeName: order.store_name,
          orderId: order.id,
          total: order.total_amount,
        });
      withPdf = body.with_pdf;
      try {
        if (withPdf) {
          const pdf = await renderOrderPdf(order, tz);
          await sendPdfDocument(evolution, { number, pdf, fileName: orderFileName(order), caption: message }, config.evolutionTimeoutMs);
        } else {
          await sendTextMessage(evolution, { number, text: message }, config.evolutionTimeoutMs);
        }
      } catch (err) {
        console.error(`Falha ao enviar a retomada do orçamento ${id} pela EvolutionAPI:`, err);
        throw new HttpError(502, describeEvolutionError(err, keySourceOf(evolution, config.evolutionServer)), 'WHATSAPP_FAILED');
      }
    }

    const followup = await withSession(pool, user, async (db) => {
      // O envio levou alguns segundos: confere de novo que continua orçamento.
      const { rows: locked } = await db.query<{ status: string }>('select status from orders where id = $1 for update', [id]);
      if (locked[0]?.status !== 'quote') {
        throw new HttpError(409, 'O orçamento mudou enquanto o contato era registrado. Abra de novo e confira.');
      }
      const { rows } = await db.query(
        `insert into order_followups (tenant_id, order_id, user_id, channel, note, message, with_pdf, next_on)
         values ($1, $2, $3, $4, $5, $6, $7, $8)
         returning id, channel, note, message, with_pdf, next_on::text as next_on, created_at, user_id`,
        [user.tenant_id, id, user.id, body.channel, body.note, message, withPdf, body.next_on],
      );
      await db.query(
        `update orders
            set last_followup_at = now(), followup_count = followup_count + 1, followup_on = $2,
                sent_at = case when $3 then now() else sent_at end
          where id = $1`,
        [id, body.next_on, withPdf],
      );
      return { ...rows[0], user_name: user.name };
    });

    res.status(201).json({ followup });
  });

  return router;
}
