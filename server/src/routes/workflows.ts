import { Router } from 'express';
import type pg from 'pg';
import { z } from 'zod';
import { currentUser } from '../auth.js';
import type { AppContext } from '../context.js';
import { withSession } from '../db/session.js';
import { HttpError } from '../errors.js';
import { optionalText, parseId } from '../lib/validation.js';
import type { DeliveryType } from '../workflow/queries.js';
import { assertSectorsExist } from './sectors.js';

const deliveryTypeSchema = z.enum(['pickup', 'delivery'], 'Tipo de entrega inválido.');

const stageSchema = z.object({
  id: z.number().int().positive().optional(),
  name: z.string().trim().min(2, 'Informe o nome de cada etapa.').max(40, 'Use no máximo 40 caracteres no nome da etapa.'),
  sector_id: z.number().int().positive().nullable().default(null),
  sla_minutes: z
    .number('Informe o tempo esperado em minutos.')
    .int('Informe o tempo esperado em minutos inteiros.')
    .positive('O tempo esperado precisa ser maior que zero.')
    .max(43_200, 'Tempo esperado alto demais (máximo de 30 dias).')
    .nullable()
    .default(null),
  whatsapp_message: optionalText(500),
});

const workflowSchema = z.object({
  store_id: z.number().int().positive().nullable(),
  delivery_type: deliveryTypeSchema,
  stages: z
    .array(stageSchema)
    .min(2, 'O fluxo precisa de pelo menos duas etapas: uma de trabalho e a final.')
    .max(15, 'Um fluxo pode ter no máximo 15 etapas.')
    .superRefine((stages, ctx) => {
      const seen = new Set<string>();
      for (const stage of stages) {
        const key = stage.name.toLowerCase();
        if (seen.has(key)) ctx.addIssue({ code: 'custom', message: `A etapa "${stage.name}" aparece duas vezes no fluxo.` });
        seen.add(key);
      }
    }),
});

const importSchema = z.object({
  store_id: z.number('Selecione a loja.').int().positive('Selecione a loja.'),
  delivery_type: deliveryTypeSchema,
});

export const DELIVERY_TYPE_LABEL: Record<DeliveryType, string> = { pickup: 'retirada na loja', delivery: 'entrega' };

type SuggestedStage = { name: string; sector: string | null; sla_minutes: number | null; whatsapp_message: string | null };

const SUGGESTED_SECTORS = ['Faturamento', 'Separação', 'Expedição'];

/** Ponto de partida para a lojamestre que ainda não tem fluxo. */
const SUGGESTED: Record<DeliveryType, SuggestedStage[]> = {
  pickup: [
    { name: 'Aguardando faturamento', sector: 'Faturamento', sla_minutes: 15, whatsapp_message: null },
    { name: 'Em separação', sector: 'Separação', sla_minutes: 30, whatsapp_message: null },
    {
      name: 'Pronto para retirada',
      sector: 'Expedição',
      sla_minutes: null,
      whatsapp_message: 'Olá, {cliente}! Seu pedido nº {pedido} está pronto para retirada na {loja}.',
    },
    { name: 'Retirado', sector: null, sla_minutes: null, whatsapp_message: null },
  ],
  delivery: [
    { name: 'Aguardando faturamento', sector: 'Faturamento', sla_minutes: 15, whatsapp_message: null },
    { name: 'Em separação', sector: 'Separação', sla_minutes: 60, whatsapp_message: null },
    { name: 'Aguardando carregamento', sector: 'Expedição', sla_minutes: 120, whatsapp_message: null },
    {
      name: 'Saiu para entrega',
      sector: 'Expedição',
      sla_minutes: null,
      whatsapp_message: 'Olá, {cliente}! Seu pedido nº {pedido} saiu para entrega.',
    },
    { name: 'Entregue', sector: null, sla_minutes: null, whatsapp_message: null },
  ],
};

type StageInput = z.infer<typeof stageSchema>;

/** Fluxos da lojamestre com as etapas e quantos pedidos estão em cada uma agora. */
async function loadWorkflows(db: pg.PoolClient, id?: number) {
  const { rows } = await db.query(
    `select w.id, w.store_id, w.delivery_type, w.updated_at,
            coalesce(json_agg(json_build_object(
              'id', ws.id, 'position', ws.position, 'name', ws.name, 'sector_id', ws.sector_id,
              'sla_minutes', ws.sla_minutes, 'whatsapp_message', ws.whatsapp_message,
              'orders_count', (select count(*) from orders o where o.stage_id = ws.id)
            ) order by ws.position) filter (where ws.id is not null), '[]') as stages
       from workflows w
       left join workflow_stages ws on ws.workflow_id = w.id
      where $1::bigint is null or w.id = $1
      group by w.id
      order by w.store_id nulls first, w.delivery_type`,
    [id ?? null],
  );
  return rows;
}

async function loadWorkflow(db: pg.PoolClient, id: number) {
  const [workflow] = await loadWorkflows(db, id);
  if (!workflow) throw new HttpError(404, 'Fluxo não encontrado.');
  return workflow;
}

async function assertStoreExists(db: pg.PoolClient, storeId: number | null) {
  if (storeId === null) return;
  const { rowCount } = await db.query('select 1 from stores where id = $1', [storeId]);
  if (!rowCount) throw new HttpError(400, 'Loja não encontrada.');
}

async function findWorkflowId(db: pg.PoolClient, storeId: number | null, type: DeliveryType): Promise<number | null> {
  const { rows } = await db.query<{ id: number }>(
    'select id from workflows where coalesce(store_id, 0) = coalesce($1::bigint, 0) and delivery_type = $2 for update',
    [storeId, type],
  );
  return rows[0]?.id ?? null;
}

/**
 * Etapas com pedido não saem do fluxo: o pedido ficaria sem rumo. A FK também
 * barra, mas aqui a mensagem diz qual etapa e quantos pedidos.
 */
async function assertStagesEmpty(db: pg.PoolClient, stageIds: number[]) {
  if (!stageIds.length) return;
  const { rows } = await db.query<{ name: string; orders_count: number }>(
    `select ws.name, count(o.id) as orders_count
       from workflow_stages ws
       join orders o on o.stage_id = ws.id
      where ws.id = any($1::bigint[])
      group by ws.id, ws.name, ws.position
      order by ws.position
      limit 1`,
    [stageIds],
  );
  const busy = rows[0];
  if (busy) {
    const count = busy.orders_count === 1 ? '1 pedido' : `${busy.orders_count} pedidos`;
    throw new HttpError(
      409,
      `A etapa "${busy.name}" tem ${count} agora e não pode ser removida. Avance ou devolva esses pedidos antes.`,
    );
  }
}

async function deleteWorkflow(db: pg.PoolClient, id: number) {
  const { rows } = await db.query<{ id: number }>('select id from workflow_stages where workflow_id = $1', [id]);
  await assertStagesEmpty(
    db,
    rows.map((r) => r.id),
  );
  await db.query('delete from workflows where id = $1', [id]);
}

async function insertWorkflow(db: pg.PoolClient, tenantId: number, storeId: number | null, type: DeliveryType) {
  const { rows } = await db.query<{ id: number }>(
    'insert into workflows (tenant_id, store_id, delivery_type) values ($1, $2, $3) returning id',
    [tenantId, storeId, type],
  );
  return rows[0]!.id;
}

async function insertStages(
  db: pg.PoolClient,
  tenantId: number,
  workflowId: number,
  stages: { position: number; name: string; sector_id: number | null; sla_minutes: number | null; whatsapp_message: string | null }[],
) {
  if (!stages.length) return;
  await db.query(
    `insert into workflow_stages (tenant_id, workflow_id, position, name, sector_id, sla_minutes, whatsapp_message)
     select $1, $2, s.position, s.name, s.sector_id, s.sla_minutes, s.whatsapp_message
       from unnest($3::int[], $4::text[], $5::bigint[], $6::int[], $7::text[])
         as s(position, name, sector_id, sla_minutes, whatsapp_message)`,
    [
      tenantId,
      workflowId,
      stages.map((s) => s.position),
      stages.map((s) => s.name),
      stages.map((s) => s.sector_id),
      stages.map((s) => s.sla_minutes),
      stages.map((s) => s.whatsapp_message),
    ],
  );
}

/**
 * Configuração do fluxo do pedido. Montado só para administradores.
 * Cada lojamestre tem um modelo por tipo de entrega (store_id nulo), e cada loja
 * pode ter o próprio fluxo; sem fluxo próprio, a loja usa o modelo.
 */
export function workflowsRouter(ctx: AppContext) {
  const router = Router();

  router.get('/', async (req, res) => {
    const workflows = await withSession(ctx.pool, currentUser(req), (db) => loadWorkflows(db));
    res.json({ items: workflows });
  });

  /** Cria ou substitui as etapas de um fluxo. Etapas com id são atualizadas; as que ficaram de fora, removidas. */
  router.put('/', async (req, res) => {
    const me = currentUser(req);
    const body = workflowSchema.parse(req.body);
    const workflow = await withSession(ctx.pool, me, async (db) => {
      await assertStoreExists(db, body.store_id);
      await assertSectorsExist(
        db,
        body.stages.map((s) => s.sector_id),
      );
      const workflowId =
        (await findWorkflowId(db, body.store_id, body.delivery_type)) ??
        (await insertWorkflow(db, me.tenant_id, body.store_id, body.delivery_type));

      const { rows: existing } = await db.query<{ id: number }>('select id from workflow_stages where workflow_id = $1', [
        workflowId,
      ]);
      const existingIds = new Set(existing.map((r) => r.id));
      const keptIds = new Set(body.stages.flatMap((s) => (s.id === undefined ? [] : [s.id])));
      for (const id of keptIds) {
        if (!existingIds.has(id)) throw new HttpError(400, 'Uma das etapas não existe mais. Atualize a página e tente de novo.');
      }
      const removed = [...existingIds].filter((id) => !keptIds.has(id));
      await assertStagesEmpty(db, removed);
      if (removed.length) await db.query('delete from workflow_stages where id = any($1::bigint[])', [removed]);

      const positioned = body.stages.map((stage, index) => ({ ...stage, position: index + 1 }));
      const updates = positioned.filter((s): s is StageInput & { id: number; position: number } => s.id !== undefined);
      if (updates.length) {
        await db.query(
          `update workflow_stages ws
              set position = s.position, name = s.name, sector_id = s.sector_id,
                  sla_minutes = s.sla_minutes, whatsapp_message = s.whatsapp_message
             from unnest($1::bigint[], $2::int[], $3::text[], $4::bigint[], $5::int[], $6::text[])
               as s(id, position, name, sector_id, sla_minutes, whatsapp_message)
            where ws.id = s.id`,
          [
            updates.map((s) => s.id),
            updates.map((s) => s.position),
            updates.map((s) => s.name),
            updates.map((s) => s.sector_id),
            updates.map((s) => s.sla_minutes),
            updates.map((s) => s.whatsapp_message),
          ],
        );
      }
      await insertStages(
        db,
        me.tenant_id,
        workflowId,
        positioned.filter((s) => s.id === undefined),
      );
      await db.query('update workflows set updated_at = now() where id = $1', [workflowId]);
      return loadWorkflow(db, workflowId);
    });
    res.json({ workflow });
  });

  /** Copia o modelo da lojamestre para a loja, substituindo o fluxo próprio que ela tiver. */
  router.post('/import', async (req, res) => {
    const me = currentUser(req);
    const body = importSchema.parse(req.body);
    const workflow = await withSession(ctx.pool, me, async (db) => {
      await assertStoreExists(db, body.store_id);
      const templateId = await findWorkflowId(db, null, body.delivery_type);
      if (templateId === null) {
        throw new HttpError(
          400,
          `A lojamestre ainda não tem fluxo de ${DELIVERY_TYPE_LABEL[body.delivery_type]} para importar. Monte o modelo primeiro.`,
        );
      }
      const currentId = await findWorkflowId(db, body.store_id, body.delivery_type);
      if (currentId !== null) await deleteWorkflow(db, currentId);
      const workflowId = await insertWorkflow(db, me.tenant_id, body.store_id, body.delivery_type);
      await db.query(
        `insert into workflow_stages (tenant_id, workflow_id, position, name, sector_id, sla_minutes, whatsapp_message)
         select tenant_id, $2, position, name, sector_id, sla_minutes, whatsapp_message
           from workflow_stages where workflow_id = $1`,
        [templateId, workflowId],
      );
      return loadWorkflow(db, workflowId);
    });
    res.status(201).json({ workflow });
  });

  /**
   * Cria os setores e os modelos sugeridos que ainda não existem. Não mexe em fluxo já
   * montado: serve para quem está começando.
   */
  router.post('/suggested', async (req, res) => {
    const me = currentUser(req);
    const workflows = await withSession(ctx.pool, me, async (db) => {
      await db.query(
        `insert into sectors (tenant_id, name) select $1, unnest($2::text[])
         on conflict (tenant_id, lower(name)) do nothing`,
        [me.tenant_id, SUGGESTED_SECTORS],
      );
      const { rows: sectors } = await db.query<{ id: number; name: string }>('select id, name from sectors');
      const sectorId = (name: string | null) =>
        name === null ? null : (sectors.find((s) => s.name.toLowerCase() === name.toLowerCase())?.id ?? null);

      for (const type of ['pickup', 'delivery'] as const) {
        if ((await findWorkflowId(db, null, type)) !== null) continue;
        const workflowId = await insertWorkflow(db, me.tenant_id, null, type);
        await insertStages(
          db,
          me.tenant_id,
          workflowId,
          SUGGESTED[type].map((stage, index) => ({ ...stage, position: index + 1, sector_id: sectorId(stage.sector) })),
        );
      }
      return loadWorkflows(db);
    });
    res.status(201).json({ items: workflows });
  });

  /** Remove o fluxo. Para uma loja, ela volta a usar o modelo da lojamestre. */
  router.delete('/:id', async (req, res) => {
    const id = parseId(req.params.id, 'Fluxo não encontrado.');
    await withSession(ctx.pool, currentUser(req), async (db) => {
      const { rowCount } = await db.query('select 1 from workflows where id = $1 for update', [id]);
      if (!rowCount) throw new HttpError(404, 'Fluxo não encontrado.');
      await deleteWorkflow(db, id);
    });
    res.status(204).end();
  });

  return router;
}
