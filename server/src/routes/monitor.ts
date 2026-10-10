import { Router } from 'express';
import { z } from 'zod';
import { currentUser, keepMonitorSession } from '../auth.js';
import type { AppContext } from '../context.js';
import { withSession } from '../db/session.js';
import { optionalQueryId } from '../lib/validation.js';
import { canMoveFrom, userSectorIds } from '../workflow/queries.js';

const monitorSchema = z.object({
  sector_id: optionalQueryId,
  store_id: optionalQueryId,
  // "Manter conectado" ligado no aparelho: a TV do setor não cai a cada 12 horas.
  keep: z.enum(['1']).optional(),
});

// Um monitor com mais que isso numa tela não serve para ninguém; o limite só
// protege a consulta, que roda a cada poucos segundos em cada TV.
const MAX_ORDERS = 500;

type StageRow = { name: string; position: number };

type MonitorOrderRow = {
  id: number;
  store_id: number;
  store_name: string;
  client_name: string;
  user_name: string;
  total_amount: number;
  delivery_address: string | null;
  notes: string | null;
  confirmed_at: Date | null;
  stage_id: number;
  stage_name: string;
  sector_id: number | null;
  sla_minutes: number | null;
  stage_entered_at: Date;
  next_stage_name: string;
  items_count: number;
};

/** Colunas agrupam etapas de mesmo nome: "Em separação" da retirada e da entrega viram uma coluna só. */
const columnKey = (name: string) => name.trim().toLowerCase();

/**
 * Pedidos em andamento para o monitor de cada área. A etapa final fica de fora: o
 * pedido ali está concluído. O vendedor vê só a própria loja (o RLS garante); o admin
 * escolhe a loja ou vê todas. A tela consulta isto a cada poucos segundos.
 */
export function monitorRouter(ctx: AppContext) {
  const router = Router();

  router.get('/', async (req, res) => {
    const user = currentUser(req);
    const query = monitorSchema.parse(req.query);
    const storeId = user.role === 'admin' ? (query.store_id ?? null) : user.store_id;
    const sectorId = query.sector_id ?? null;
    if (query.keep) keepMonitorSession(req, res, ctx.config);

    const result = await withSession(ctx.pool, user, async (db) => {
      const sectors = await userSectorIds(db, user.id);

      // Etapas que a loja usa hoje (o fluxo próprio ou, sem ele, o modelo), para a
      // coluna aparecer mesmo vazia. Pedidos antigos num fluxo que a loja deixou de
      // usar entram pelas linhas dos pedidos logo abaixo.
      const stages = await db.query<StageRow>(
        `select ws.name, ws.position
           from workflow_stages ws
           join workflows w on w.id = ws.workflow_id
          where exists (select 1 from workflow_stages nx where nx.workflow_id = ws.workflow_id and nx.position > ws.position)
            and ($1::bigint is null or ws.sector_id = $1)
            and ($2::bigint is null
                 or w.store_id = $2
                 or (w.store_id is null and not exists (
                       select 1 from workflows own where own.store_id = $2 and own.delivery_type = w.delivery_type)))`,
        [sectorId, storeId],
      );

      const orders = await db.query<MonitorOrderRow>(
        `select o.id, o.store_id, s.name as store_name, c.name as client_name, u.name as user_name,
                o.total_amount, o.delivery_address, o.notes, o.confirmed_at,
                ws.id as stage_id, ws.name as stage_name, ws.sector_id, ws.sla_minutes, o.stage_entered_at,
                nx.name as next_stage_name,
                (select count(*) from order_items i where i.order_id = o.id) as items_count
           from orders o
           join workflow_stages ws on ws.id = o.stage_id
           join lateral (
             select name from workflow_stages
              where workflow_id = ws.workflow_id and position > ws.position
              order by position limit 1
           ) nx on true
           join stores s on s.id = o.store_id
           join clients c on c.id = o.client_id
           join users u on u.id = o.user_id
          where ($1::bigint is null or ws.sector_id = $1)
            and ($2::bigint is null or o.store_id = $2)
          order by o.stage_entered_at, o.id
          limit ${MAX_ORDERS}`,
        [sectorId, storeId],
      );
      return { sectors, stages: stages.rows, orders: orders.rows };
    });

    const columns = new Map<string, { key: string; name: string; position: number }>();
    const addColumn = (name: string, position: number) => {
      const key = columnKey(name);
      const current = columns.get(key);
      if (!current) columns.set(key, { key, name, position });
      else current.position = Math.min(current.position, position);
    };
    for (const stage of result.stages) addColumn(stage.name, stage.position);
    // Etapa de um fluxo que a loja não usa mais: vai para o fim do quadro.
    for (const order of result.orders) addColumn(order.stage_name, Number.MAX_SAFE_INTEGER);

    res.json({
      now: new Date(),
      my_sector_ids: [...result.sectors],
      columns: [...columns.values()]
        .sort((a, b) => a.position - b.position || a.name.localeCompare(b.name, 'pt-BR'))
        .map(({ key, name }) => ({ key, name })),
      orders: result.orders.map((order) => ({
        ...order,
        column: columnKey(order.stage_name),
        delivery_type: order.delivery_address ? 'delivery' : 'pickup',
        can_move: canMoveFrom(user, order.sector_id, result.sectors),
      })),
    });
  });

  return router;
}
