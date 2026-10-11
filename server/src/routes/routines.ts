import { Router } from 'express';
import type pg from 'pg';
import { z } from 'zod';
import { currentUser, requireAdmin, type AuthUser } from '../auth.js';
import type { AppContext } from '../context.js';
import { withSession } from '../db/session.js';
import { HttpError } from '../errors.js';
import { loadFinanceSettings } from '../finance/queries.js';
import { todayIn } from '../lib/format.js';
import { optionalQueryId, optionalText, parseId } from '../lib/validation.js';
import {
  actionSatisfied,
  cashState,
  createStockCount,
  cycleSelection,
  expectedShelf,
  isDue,
  nowTime,
  saveTemplate,
  seedTemplates,
  type Frequency,
} from '../routines/queries.js';
import { applyStockChanges } from '../stock/queries.js';

const settingsSchema = z.object({
  enabled: z.boolean(),
  count_items: z.number('Informe quantos produtos por contagem.').int().min(5, 'Use de 5 a 200.').max(200, 'Use de 5 a 200.'),
});

const templateSchema = z
  .object({
    name: z.string('Informe o nome.').trim().min(2, 'Informe o nome da rotina.').max(80),
    kind: z.enum(['checklist', 'stock_count']).default('checklist'),
    description: optionalText(300),
    frequency: z.enum(['weekly', 'monthly', 'on_demand']),
    weekdays: z.array(z.number().int().min(0).max(6)).max(7).default([]),
    month_day: z.number().int().min(1, 'Use um dia de 1 a 28.').max(28, 'Use um dia de 1 a 28.').nullable().default(null),
    due_time: z
      .string()
      .regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Horário inválido. Use HH:MM.')
      .nullable()
      .default(null),
    store_id: z.number().int().positive().nullable().default(null),
    active: z.boolean().default(true),
    items: z
      .array(
        z.object({
          label: z.string('Escreva o item.').trim().min(2, 'Escreva cada item do checklist.').max(160),
          hint: optionalText(200),
          kind: z.enum(['check', 'number', 'text', 'photo']),
          required: z.boolean(),
          action: z.enum(['cash_open', 'cash_closed']).nullable().default(null),
        }),
      )
      .max(50)
      .default([]),
  })
  .superRefine((t, ctx) => {
    if (t.frequency === 'weekly' && !t.weekdays.length) ctx.addIssue({ code: 'custom', message: 'Escolha os dias da semana.' });
    if (t.frequency === 'monthly' && t.month_day === null) ctx.addIssue({ code: 'custom', message: 'Escolha o dia do mês.' });
    if (t.kind === 'checklist' && !t.items.length) ctx.addIssue({ code: 'custom', message: 'O checklist precisa de pelo menos um item.' });
  });

const MAX_PHOTO_BYTES = 600 * 1024;
const photoSchema = z
  .string()
  .nullable()
  .refine((v) => v === null || /^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/]+={0,2}$/.test(v), 'Foto em formato inválido.')
  .refine((v) => v === null || Buffer.byteLength(v.split(',')[1] ?? '', 'base64') <= MAX_PHOTO_BYTES, 'Foto grande demais.');

const itemSchema = z.object({
  checked: z.boolean().optional(),
  value_number: z.number().min(-99_999_999).max(99_999_999).nullable().optional(),
  value_text: optionalText(1000).optional(),
  photo: photoSchema.optional(),
});

const countItemSchema = z.object({
  counted_quantity: z
    .number('Informe a quantidade contada.')
    .min(0, 'A quantidade não pode ser negativa.')
    .max(9_999_999)
    .transform((v) => Math.round(v * 1000) / 1000)
    .nullable(),
});

const reviewSchema = z.object({
  adjust_item_ids: z.array(z.number().int().positive()).max(1000),
  note: optionalText(300),
});

const historySchema = z.object({
  from: z.iso.date(),
  to: z.iso.date(),
  store_id: optionalQueryId,
});

const RUN_NOT_FOUND = 'Rotina não encontrada.';
const COUNT_NOT_FOUND = 'Contagem não encontrada.';

type TemplateRow = {
  id: number;
  name: string;
  kind: 'checklist' | 'stock_count';
  description: string | null;
  frequency: Frequency;
  weekdays: number[];
  month_day: number | null;
  due_time: string | null;
  store_id: number | null;
  active: boolean;
};

const TEMPLATE_COLUMNS = `t.id, t.name, t.kind, t.description, t.frequency, t.weekdays, t.month_day,
  to_char(t.due_time, 'HH24:MI') as due_time, t.store_id, t.active`;

async function loadSettings(db: pg.PoolClient) {
  const { rows } = await db.query<{ routines_enabled: boolean; count_items: number }>(
    'select routines_enabled, count_items from settings limit 1',
  );
  return { enabled: Boolean(rows[0]?.routines_enabled), count_items: rows[0]?.count_items ?? 20 };
}

async function assertEnabled(db: pg.PoolClient) {
  const settings = await loadSettings(db);
  if (!settings.enabled) {
    throw new HttpError(409, 'As rotinas estão desligadas. O administrador liga em Operação → Rotinas.', 'ROUTINES_DISABLED');
  }
  return settings;
}

/** Loja da rotina: a do vendedor; o admin escolhe (sem escolher, a primeira). */
async function resolveStore(db: pg.PoolClient, user: AuthUser, requested: number | null | undefined) {
  if (user.role !== 'admin') {
    if (!user.store_id) throw new HttpError(400, 'Seu usuário não tem loja.');
    return user.store_id;
  }
  const { rows } = await db.query<{ id: number }>(
    'select id from stores where ($1::bigint is null or id = $1) order by name, id limit 1',
    [requested ?? null],
  );
  if (!rows[0]) throw new HttpError(400, 'Loja não encontrada.');
  return rows[0].id;
}

/** O vendedor só mexe nas rotinas e contagens da própria loja. */
function assertStoreAccess(user: AuthUser, storeId: number, notFound: string) {
  if (user.role !== 'admin' && user.store_id !== storeId) throw new HttpError(404, notFound);
}

async function loadTemplates(db: pg.PoolClient, where = 'true', params: unknown[] = []) {
  const { rows } = await db.query<TemplateRow & { items: unknown[] }>(
    `select ${TEMPLATE_COLUMNS},
            coalesce((select json_agg(json_build_object('id', i.id, 'label', i.label, 'hint', i.hint, 'kind', i.kind,
                                                        'required', i.required, 'action', i.action) order by i.position)
                        from routine_template_items i where i.template_id = t.id), '[]') as items
       from routine_templates t
      where ${where}
      order by t.position, t.id`,
    params,
  );
  return rows;
}

async function loadRun(db: pg.PoolClient, id: number, timeZone: string) {
  const { rows } = await db.query(
    `select r.id, r.template_id, r.store_id, s.name as store_name, r.run_date::text as run_date, r.scheduled, r.name, r.status,
            r.started_at, r.finished_at, r.late, r.count_id, r.notes, u.name as user_name, fu.name as finished_by_name,
            t.kind, t.description, to_char(t.due_time, 'HH24:MI') as due_time
       from routine_runs r
       join routine_templates t on t.id = r.template_id
       join stores s on s.id = r.store_id
       join users u on u.id = r.user_id
       left join users fu on fu.id = r.finished_by
      where r.id = $1`,
    [id],
  );
  const run = rows[0] as
    | { id: number; store_id: number; run_date: string; status: string; count_id: number | null; due_time: string | null }
    | undefined;
  if (!run) throw new HttpError(404, RUN_NOT_FOUND);
  const { rows: items } = await db.query(
    `select i.id, i.label, i.hint, i.kind, i.required, i.action, i.checked, i.value_number, i.value_text, i.photo_data as photo,
            i.done_at, u.name as done_by_name
       from routine_run_items i left join users u on u.id = i.done_by
      where i.run_id = $1
      order by i.position, i.id`,
    [id],
  );
  const finance = (await loadFinanceSettings(db)).enabled;
  const cash = finance ? await cashState(db, run.store_id, run.run_date, timeZone) : null;
  let count = null;
  if (run.count_id) {
    const { rows: counts } = await db.query(
      `select c.id, c.status, count(i.id) as items, count(i.counted_quantity) as counted
         from stock_counts c left join stock_count_items i on i.count_id = c.id
        where c.id = $1 group by c.id`,
      [run.count_id],
    );
    count = counts[0] ?? null;
  }
  return {
    ...run,
    cash,
    count,
    items: items.map((item) => ({ ...item, satisfied: actionSatisfied(item.action, cash) })),
  };
}

/** Rotinas e checklists da loja, e a contagem cega do estoque. */
export function routinesRouter(ctx: AppContext) {
  const router = Router();
  const { pool, config } = ctx;
  const tz = config.timeZone;

  // ---- Configuração

  router.get('/routines/settings', async (req, res) => {
    const settings = await withSession(pool, currentUser(req), loadSettings);
    res.json({ settings });
  });

  router.put('/routines/settings', requireAdmin, async (req, res) => {
    const user = currentUser(req);
    const body = settingsSchema.parse(req.body);
    const settings = await withSession(pool, user, async (db) => {
      await db.query(
        `insert into settings (tenant_id, routines_enabled, count_items) values ($1, $2, $3)
         on conflict (tenant_id) do update
            set routines_enabled = excluded.routines_enabled, count_items = excluded.count_items, updated_at = now()`,
        [user.tenant_id, body.enabled, body.count_items],
      );
      if (body.enabled) await seedTemplates(db, user.tenant_id);
      return loadSettings(db);
    });
    res.json({ settings });
  });

  // ---- Modelos

  router.get('/routines/templates', requireAdmin, async (req, res) => {
    const items = await withSession(pool, currentUser(req), (db) => loadTemplates(db));
    res.json({ items });
  });

  router.post('/routines/templates', requireAdmin, async (req, res) => {
    const user = currentUser(req);
    const body = templateSchema.parse(req.body);
    const template = await withSession(pool, user, async (db) => {
      const id = await saveTemplate(db, user.tenant_id, body);
      return (await loadTemplates(db, 't.id = $1', [id]))[0];
    });
    res.status(201).json({ template });
  });

  router.put('/routines/templates/:id', requireAdmin, async (req, res) => {
    const user = currentUser(req);
    const id = parseId(req.params.id, 'Modelo não encontrado.');
    const body = templateSchema.parse(req.body);
    const template = await withSession(pool, user, async (db) => {
      const { rowCount } = await db.query('select 1 from routine_templates where id = $1 for update', [id]);
      if (!rowCount) throw new HttpError(404, 'Modelo não encontrado.');
      await saveTemplate(db, user.tenant_id, body, id);
      return (await loadTemplates(db, 't.id = $1', [id]))[0];
    });
    res.json({ template });
  });

  // ---- Hoje

  /**
   * O que a loja tem para fazer hoje: as rotinas da agenda (com a situação: pendente,
   * em andamento, feita, atrasada) e as sob demanda, mais as contagens em aberto.
   */
  router.get('/routines/today', async (req, res) => {
    const user = currentUser(req);
    const { store_id } = z.object({ store_id: optionalQueryId }).parse(req.query);
    const data = await withSession(pool, user, async (db) => {
      await assertEnabled(db);
      const today = todayIn(tz);
      const now = nowTime(tz);
      const { rows: stores } = await db.query<{ id: number; name: string }>(
        `select id, name from stores where ($1::bigint is null or id = $1) order by name`,
        [user.role === 'admin' ? (store_id ?? null) : user.store_id],
      );
      const templates = await loadTemplates(db, 't.active');
      const { rows: runs } = await db.query<{
        id: number;
        template_id: number;
        store_id: number;
        status: string;
        late: boolean;
        scheduled: boolean;
        started_at: Date;
        finished_at: Date | null;
        user_name: string;
      }>(
        `select r.id, r.template_id, r.store_id, r.status, r.late, r.scheduled, r.started_at, r.finished_at, u.name as user_name
           from routine_runs r join users u on u.id = r.user_id
          where r.store_id = any($1::bigint[]) and (r.run_date = $2::date or r.status = 'in_progress')
          order by r.started_at`,
        [stores.map((s) => s.id), today],
      );
      const items = stores.flatMap((store) =>
        templates
          .filter((t) => t.store_id === null || t.store_id === store.id)
          .map((t) => {
            const due = isDue(t, today);
            const own = runs.filter((r) => r.template_id === t.id && r.store_id === store.id);
            const scheduledRun = own.find((r) => r.scheduled);
            const status =
              scheduledRun?.status === 'done'
                ? 'done'
                : scheduledRun
                  ? 'in_progress'
                  : !due
                    ? 'not_due'
                    : t.due_time && now > t.due_time
                      ? 'overdue'
                      : 'pending';
            return {
              template_id: t.id,
              name: t.name,
              kind: t.kind,
              description: t.description,
              frequency: t.frequency,
              due_time: t.due_time,
              store_id: store.id,
              store_name: store.name,
              due_today: due,
              status,
              runs: own,
            };
          }),
      );
      const { rows: counts } = await db.query(
        `select c.id, c.store_id, s.name as store_name, c.mode, c.status, c.created_at, u.name as user_name,
                count(i.id) as items, count(i.counted_quantity) as counted
           from stock_counts c
           join stores s on s.id = c.store_id
           join users u on u.id = c.user_id
           left join stock_count_items i on i.count_id = c.id
          where c.store_id = any($1::bigint[]) and c.status in ('counting', 'submitted')
          group by c.id, s.name, u.name
          order by c.created_at desc`,
        [stores.map((s) => s.id)],
      );
      return { today, items, counts };
    });
    res.json(data);
  });

  // ---- Execução

  router.post('/routines/runs', async (req, res) => {
    const user = currentUser(req);
    const body = z.object({ template_id: z.number().int().positive(), store_id: z.number().int().positive().nullable().default(null) }).parse(req.body);
    const result = await withSession(pool, user, async (db) => {
      const settings = await assertEnabled(db);
      const storeId = await resolveStore(db, user, body.store_id);
      const template = (await loadTemplates(db, 't.id = $1 and t.active', [body.template_id]))[0];
      if (!template || (template.store_id !== null && template.store_id !== storeId)) throw new HttpError(404, 'Rotina não encontrada.');
      const today = todayIn(tz);
      const scheduled = template.frequency !== 'on_demand' && isDue(template, today);
      if (scheduled) {
        const { rows } = await db.query<{ id: number; count_id: number | null }>(
          'select id, count_id from routine_runs where template_id = $1 and store_id = $2 and run_date = $3 and scheduled',
          [template.id, storeId, today],
        );
        if (rows[0]) return { id: rows[0].id, count_id: rows[0].count_id, created: false };
      }
      let countId: number | null = null;
      if (template.kind === 'stock_count') {
        const products = await cycleSelection(db, storeId, settings.count_items);
        if (!products.length) throw new HttpError(409, 'Nada para contar hoje: os produtos desta loja estão com a contagem em dia.', 'NOTHING_TO_COUNT');
        countId = await createStockCount(db, user, storeId, 'cycle', products);
      }
      const { rows } = await db.query<{ id: number }>(
        `insert into routine_runs (tenant_id, template_id, store_id, run_date, scheduled, name, user_id, count_id)
         values ($1, $2, $3, $4, $5, $6, $7, $8) returning id`,
        [user.tenant_id, template.id, storeId, today, scheduled, template.name, user.id, countId],
      );
      const runId = rows[0]!.id;
      await db.query(
        `insert into routine_run_items (tenant_id, run_id, position, label, hint, kind, required, action)
         select $1, $2, i.position, i.label, i.hint, i.kind, i.required, i.action
           from routine_template_items i where i.template_id = $3`,
        [user.tenant_id, runId, template.id],
      );
      return { id: runId, count_id: countId, created: true };
    });
    res.status(result.created ? 201 : 200).json({ run: { id: result.id, count_id: result.count_id } });
  });

  router.get('/routines/runs/:id', async (req, res) => {
    const user = currentUser(req);
    const id = parseId(req.params.id, RUN_NOT_FOUND);
    const run = await withSession(pool, user, async (db) => {
      const loaded = await loadRun(db, id, tz);
      assertStoreAccess(user, loaded.store_id, RUN_NOT_FOUND);
      return loaded;
    });
    res.json({ run });
  });

  router.put('/routines/runs/:id/items/:itemId', async (req, res) => {
    const user = currentUser(req);
    const id = parseId(req.params.id, RUN_NOT_FOUND);
    const itemId = parseId(req.params.itemId, 'Item não encontrado.');
    const body = itemSchema.parse(req.body);
    await withSession(pool, user, async (db) => {
      const { rows } = await db.query<{ store_id: number; status: string }>(
        'select store_id, status from routine_runs where id = $1 for update',
        [id],
      );
      const run = rows[0];
      if (!run) throw new HttpError(404, RUN_NOT_FOUND);
      assertStoreAccess(user, run.store_id, RUN_NOT_FOUND);
      if (run.status !== 'in_progress') throw new HttpError(409, 'Rotina concluída não muda mais.');
      const { rowCount } = await db.query(
        `update routine_run_items
            set checked = coalesce($3, checked),
                value_number = case when $4 then $5 else value_number end,
                value_text = case when $6 then $7 else value_text end,
                photo_data = case when $8 then $9 else photo_data end,
                done_by = $10, done_at = now()
          where id = $2 and run_id = $1`,
        [
          id,
          itemId,
          body.checked ?? null,
          body.value_number !== undefined,
          body.value_number ?? null,
          body.value_text !== undefined,
          body.value_text ?? null,
          body.photo !== undefined,
          body.photo ?? null,
          user.id,
        ],
      );
      if (!rowCount) throw new HttpError(404, 'Item não encontrado.');
    });
    res.status(204).end();
  });

  /** Conclui a rotina: os itens obrigatórios precisam estar feitos (e o caixa, conferido pelo sistema). */
  router.post('/routines/runs/:id/finish', async (req, res) => {
    const user = currentUser(req);
    const id = parseId(req.params.id, RUN_NOT_FOUND);
    const { notes } = z.object({ notes: optionalText(500) }).parse(req.body ?? {});
    const run = await withSession(pool, user, async (db) => {
      await db.query('select 1 from routine_runs where id = $1 for update', [id]);
      const loaded = await loadRun(db, id, tz);
      assertStoreAccess(user, loaded.store_id, RUN_NOT_FOUND);
      if (loaded.status !== 'in_progress') throw new HttpError(409, 'Esta rotina já foi concluída.');
      if (loaded.count && !['submitted', 'reviewed'].includes(loaded.count.status)) {
        throw new HttpError(409, 'Envie a contagem para conferência antes de concluir.');
      }
      const missing = loaded.items.filter((item) => {
        if (!item.required) return false;
        if (item.action && item.satisfied !== null) return !item.satisfied;
        if (item.kind === 'check') return !item.checked;
        if (item.kind === 'number') return item.value_number === null;
        if (item.kind === 'text') return !item.value_text;
        return !item.photo;
      });
      if (missing.length) {
        const first = missing[0]!;
        const why =
          first.action === 'cash_open' && first.satisfied === false
            ? ' (nenhum caixa foi aberto hoje nesta loja)'
            : first.action === 'cash_closed' && first.satisfied === false
              ? ' (ainda há caixa aberto nesta loja)'
              : '';
        throw new HttpError(
          409,
          `Falta ${missing.length === 1 ? 'o item' : `${missing.length} itens, como`} "${first.label}"${why}.`,
          'ROUTINE_INCOMPLETE',
        );
      }
      const dueTime = loaded.due_time;
      const today = todayIn(tz);
      const late = Boolean(dueTime) && (loaded.run_date < today || nowTime(tz) > dueTime!);
      await db.query(
        `update routine_runs set status = 'done', finished_at = now(), finished_by = $2, late = $3, notes = coalesce($4, notes)
          where id = $1`,
        [id, user.id, late, notes],
      );
      return loadRun(db, id, tz);
    });
    res.json({ run });
  });

  // ---- Histórico

  /**
   * Cumprimento no período: para cada rotina da agenda e loja, os dias em que vencia, as
   * feitas, as atrasadas e as que não foram feitas (os dias). Sob demanda, quantas vezes.
   */
  router.get('/routines/history', async (req, res) => {
    const user = currentUser(req);
    const query = historySchema.parse(req.query);
    if (query.from > query.to) throw new HttpError(400, 'A data inicial precisa ser antes da final.');
    const data = await withSession(pool, user, async (db) => {
      await assertEnabled(db);
      const { rows: stores } = await db.query<{ id: number; name: string }>(
        'select id, name from stores where ($1::bigint is null or id = $1) order by name',
        [user.role === 'admin' ? (query.store_id ?? null) : user.store_id],
      );
      const templates = await loadTemplates(db);
      const { rows: runs } = await db.query<{ template_id: number; store_id: number; run_date: string; status: string; late: boolean; scheduled: boolean }>(
        `select template_id, store_id, run_date::text as run_date, status, late, scheduled
           from routine_runs where store_id = any($1::bigint[]) and run_date between $2 and $3`,
        [stores.map((s) => s.id), query.from, query.to],
      );
      const today = todayIn(tz);
      const days: string[] = [];
      for (let d = new Date(`${query.from}T12:00:00Z`); d.toISOString().slice(0, 10) <= query.to; d.setUTCDate(d.getUTCDate() + 1)) {
        days.push(d.toISOString().slice(0, 10));
      }
      const rows = stores.flatMap((store) =>
        templates
          .filter((t) => t.store_id === null || t.store_id === store.id)
          .map((t) => {
            const own = runs.filter((r) => r.template_id === t.id && r.store_id === store.id);
            if (t.frequency === 'on_demand') {
              return { template_id: t.id, name: t.name, store_id: store.id, store_name: store.name, frequency: t.frequency, due: 0, done: own.filter((r) => r.status === 'done').length, late: 0, missed: [] as string[] };
            }
            const dueDays = days.filter((d) => d <= today && isDue(t, d));
            const doneDays = new Set(own.filter((r) => r.scheduled && r.status === 'done').map((r) => r.run_date));
            return {
              template_id: t.id,
              name: t.name,
              store_id: store.id,
              store_name: store.name,
              frequency: t.frequency,
              due: dueDays.length,
              done: dueDays.filter((d) => doneDays.has(d)).length,
              late: own.filter((r) => r.scheduled && r.status === 'done' && r.late).length,
              // Hoje ainda dá tempo: não conta como perdida.
              missed: dueDays.filter((d) => !doneDays.has(d) && d < today),
            };
          })
          .filter((row) => row.due > 0 || row.done > 0),
      );
      return { rows };
    });
    res.json(data);
  });

  // ---- Contagem cega

  router.get('/stock-counts', async (req, res) => {
    const user = currentUser(req);
    const { status } = z.object({ status: z.enum(['open', 'reviewed', 'all']).default('open') }).parse(req.query);
    const { rows } = await withSession(pool, user, async (db) => {
      await assertEnabled(db);
      return db.query(
        `select c.id, c.store_id, s.name as store_name, c.mode, c.status, c.created_at, c.submitted_at, c.reviewed_at,
                u.name as user_name, count(i.id) as items, count(i.counted_quantity) as counted
           from stock_counts c
           join stores s on s.id = c.store_id
           join users u on u.id = c.user_id
           left join stock_count_items i on i.count_id = c.id
          where ($1::bigint is null or c.store_id = $1)
            and ($2 = 'all' or ($2 = 'open' and c.status in ('counting', 'submitted')) or ($2 = 'reviewed' and c.status = 'reviewed'))
          group by c.id, s.name, u.name
          order by c.created_at desc
          limit 100`,
        [user.role === 'admin' ? null : user.store_id, status],
      );
    });
    res.json({ items: rows });
  });

  /** Contagem avulsa: as escolhidas pelo sistema agora (sem produtos) ou os produtos informados. */
  router.post('/stock-counts', async (req, res) => {
    const user = currentUser(req);
    const body = z
      .object({
        store_id: z.number().int().positive().nullable().default(null),
        product_ids: z.array(z.number().int().positive()).max(500).default([]),
      })
      .parse(req.body);
    const id = await withSession(pool, user, async (db) => {
      const settings = await assertEnabled(db);
      const storeId = await resolveStore(db, user, body.store_id);
      if (body.product_ids.length) {
        const { rows } = await db.query<{ id: number }>(
          'select id from products where id = any($1::bigint[]) and track_stock',
          [body.product_ids],
        );
        if (rows.length !== new Set(body.product_ids).size) throw new HttpError(400, 'Um dos produtos não existe ou não controla estoque.');
        return createStockCount(db, user, storeId, 'manual', [...new Set(body.product_ids)].map((product_id) => ({ product_id, abc_class: null })));
      }
      const products = await cycleSelection(db, storeId, settings.count_items);
      if (!products.length) throw new HttpError(409, 'Nada para contar agora: os produtos desta loja estão com a contagem em dia.', 'NOTHING_TO_COUNT');
      return createStockCount(db, user, storeId, 'cycle', products);
    });
    res.status(201).json({ count: { id } });
  });

  /**
   * A contagem. Cega: enquanto conta, ninguém vê o saldo do sistema; depois de enviada,
   * só o administrador vê o esperado e a diferença.
   */
  router.get('/stock-counts/:id', async (req, res) => {
    const user = currentUser(req);
    const id = parseId(req.params.id, COUNT_NOT_FOUND);
    const data = await withSession(pool, user, async (db) => {
      const { rows } = await db.query(
        `select c.id, c.store_id, s.name as store_name, c.mode, c.status, c.notes, c.created_at, c.submitted_at, c.reviewed_at,
                c.review_note, u.name as user_name, su.name as submitted_by_name, ru.name as reviewed_by_name
           from stock_counts c
           join stores s on s.id = c.store_id
           join users u on u.id = c.user_id
           left join users su on su.id = c.submitted_by
           left join users ru on ru.id = c.reviewed_by
          where c.id = $1`,
        [id],
      );
      const count = rows[0] as { status: string; store_id: number } | undefined;
      if (!count) throw new HttpError(404, COUNT_NOT_FOUND);
      assertStoreAccess(user, count.store_id, COUNT_NOT_FOUND);
      const reveal = user.role === 'admin' && count.status !== 'counting';
      const { rows: items } = await db.query(
        `select i.id, i.product_id, i.product_name, i.product_code, i.unit, i.abc_class, i.counted_quantity, i.counted_at,
                u.name as counted_by_name, p.gtin,
                ${reveal ? 'i.expected_quantity, i.unit_cost, i.outcome' : 'null as expected_quantity, null as unit_cost, i.outcome'}
           from stock_count_items i
           join products p on p.id = i.product_id
           left join users u on u.id = i.counted_by
          where i.count_id = $1
          order by i.position, i.id`,
        [id],
      );
      return { count, items, reveal };
    });
    res.json(data);
  });

  /** Quantidade contada de um produto. O esperado é tirado do sistema na mesma hora, sem mostrar. */
  router.put('/stock-counts/:id/items/:itemId', async (req, res) => {
    const user = currentUser(req);
    const id = parseId(req.params.id, COUNT_NOT_FOUND);
    const itemId = parseId(req.params.itemId, 'Item não encontrado.');
    const body = countItemSchema.parse(req.body);
    await withSession(pool, user, async (db) => {
      const { rows } = await db.query<{ store_id: number; status: string }>('select store_id, status from stock_counts where id = $1', [id]);
      const count = rows[0];
      if (!count) throw new HttpError(404, COUNT_NOT_FOUND);
      assertStoreAccess(user, count.store_id, COUNT_NOT_FOUND);
      if (count.status !== 'counting') throw new HttpError(409, 'Esta contagem já foi enviada.');
      const { rows: items } = await db.query<{ product_id: number }>(
        'select product_id from stock_count_items where id = $1 and count_id = $2 for update',
        [itemId, id],
      );
      if (!items[0]) throw new HttpError(404, 'Item não encontrado.');
      const expected = body.counted_quantity === null ? null : (await expectedShelf(db, count.store_id, [items[0].product_id])).get(items[0].product_id) ?? 0;
      await db.query(
        `update stock_count_items
            set counted_quantity = $2, expected_quantity = $3,
                counted_by = case when $2::numeric is null then null else $4::bigint end,
                counted_at = case when $2::numeric is null then null else now() end
          where id = $1`,
        [itemId, body.counted_quantity, expected, user.id],
      );
    });
    res.status(204).end();
  });

  router.post('/stock-counts/:id/submit', async (req, res) => {
    const user = currentUser(req);
    const id = parseId(req.params.id, COUNT_NOT_FOUND);
    await withSession(pool, user, async (db) => {
      const { rows } = await db.query<{ store_id: number; status: string }>(
        'select store_id, status from stock_counts where id = $1 for update',
        [id],
      );
      const count = rows[0];
      if (!count) throw new HttpError(404, COUNT_NOT_FOUND);
      assertStoreAccess(user, count.store_id, COUNT_NOT_FOUND);
      if (count.status !== 'counting') throw new HttpError(409, 'Esta contagem já foi enviada.');
      const { rows: counted } = await db.query<{ n: number }>(
        'select count(counted_quantity) as n from stock_count_items where count_id = $1',
        [id],
      );
      if (!counted[0]!.n) throw new HttpError(409, 'Conte pelo menos um produto antes de enviar.');
      await db.query(`update stock_counts set status = 'submitted', submitted_at = now(), submitted_by = $2 where id = $1`, [id, user.id]);
      // A rotina de contagem fica feita quando a contagem é enviada.
      const today = todayIn(tz);
      const now = nowTime(tz);
      await db.query(
        `update routine_runs r
            set status = 'done', finished_at = now(), finished_by = $2,
                late = coalesce(r.run_date < $3::date or $4::text > to_char(t.due_time, 'HH24:MI'), false)
           from routine_templates t
          where t.id = r.template_id and r.count_id = $1 and r.status = 'in_progress'`,
        [id, user.id, today, now],
      );
    });
    res.status(204).end();
  });

  /** Conferência do administrador: as diferenças marcadas viram ajuste de estoque; o resto fica como está. */
  router.post('/stock-counts/:id/review', requireAdmin, async (req, res) => {
    const user = currentUser(req);
    const id = parseId(req.params.id, COUNT_NOT_FOUND);
    const body = reviewSchema.parse(req.body);
    const result = await withSession(pool, user, async (db) => {
      const { rows } = await db.query<{ store_id: number; status: string }>(
        'select store_id, status from stock_counts where id = $1 for update',
        [id],
      );
      const count = rows[0];
      if (!count) throw new HttpError(404, COUNT_NOT_FOUND);
      if (count.status !== 'submitted') {
        throw new HttpError(409, count.status === 'counting' ? 'A contagem ainda não foi enviada.' : 'Esta contagem já foi conferida.');
      }
      const { rows: items } = await db.query<{ id: number; product_id: number; counted_quantity: number; expected_quantity: number; unit_cost: number | null }>(
        `select id, product_id, counted_quantity, expected_quantity, unit_cost
           from stock_count_items where count_id = $1 and counted_quantity is not null`,
        [id],
      );
      const chosen = new Set(body.adjust_item_ids);
      const adjust = items.filter((i) => chosen.has(i.id) && Math.abs(i.counted_quantity - i.expected_quantity) > 0.0005);
      // Ajuste pela diferença (não "o saldo passa a ser"): uma venda depois da contagem continua valendo.
      await applyStockChanges(
        db,
        user,
        adjust.map((i) => ({
          store_id: count.store_id,
          product_id: i.product_id,
          quantity: Math.round((i.counted_quantity - i.expected_quantity) * 1000) / 1000,
          kind: 'adjustment',
          unit_cost: i.unit_cost,
          note: `Contagem nº ${id}`,
        })),
      );
      await db.query(
        `update stock_count_items set outcome = case when id = any($2::bigint[]) then 'adjusted' else 'ignored' end
          where count_id = $1 and counted_quantity is not null`,
        [id, adjust.map((i) => i.id)],
      );
      await db.query(
        `update stock_counts set status = 'reviewed', reviewed_at = now(), reviewed_by = $2, review_note = $3 where id = $1`,
        [id, user.id, body.note],
      );
      const value = adjust.reduce((sum, i) => sum + (i.counted_quantity - i.expected_quantity) * (i.unit_cost ?? 0), 0);
      return { adjusted: adjust.length, value: Math.round(value * 100) / 100 };
    });
    res.json(result);
  });

  router.post('/stock-counts/:id/cancel', async (req, res) => {
    const user = currentUser(req);
    const id = parseId(req.params.id, COUNT_NOT_FOUND);
    await withSession(pool, user, async (db) => {
      const { rows } = await db.query<{ store_id: number; status: string; user_id: number }>(
        'select store_id, status, user_id from stock_counts where id = $1 for update',
        [id],
      );
      const count = rows[0];
      if (!count) throw new HttpError(404, COUNT_NOT_FOUND);
      assertStoreAccess(user, count.store_id, COUNT_NOT_FOUND);
      if (user.role !== 'admin' && count.user_id !== user.id) throw new HttpError(403, 'Só quem abriu a contagem (ou o administrador) cancela.');
      if (count.status !== 'counting') throw new HttpError(409, 'Contagem enviada não é cancelada: o administrador confere e decide o que ajustar.');
      await db.query(`update stock_counts set status = 'cancelled' where id = $1`, [id]);
    });
    res.status(204).end();
  });

  return router;
}
