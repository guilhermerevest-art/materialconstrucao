import type pg from 'pg';
import type { SessionUser } from '../db/session.js';
import { HttpError } from '../errors.js';
import { formatOrderNumber } from '../lib/format.js';

/** Retirada na loja (pedido sem endereço de entrega) ou entrega. */
export type DeliveryType = 'pickup' | 'delivery';

export const deliveryTypeOf = (deliveryAddress: string | null): DeliveryType => (deliveryAddress ? 'delivery' : 'pickup');

export type StageRef = { id: number; name: string };

export type StageEvent = {
  id: number;
  from_stage_name: string | null;
  to_stage_name: string;
  user_name: string;
  note: string | null;
  created_at: Date;
};

/** Onde o pedido está no fluxo. Nulo quando o pedido não passa por etapas. */
export type OrderWorkflow = {
  stage_id: number;
  stage_name: string;
  sector_id: number | null;
  sector_name: string | null;
  sla_minutes: number | null;
  entered_at: Date;
  /** Chegou na última etapa: o pedido está concluído. */
  is_final: boolean;
  next_stage: StageRef | null;
  previous_stage: StageRef | null;
  /** O usuário pode tirar o pedido desta etapa (para frente ou para trás). */
  can_move: boolean;
  events: StageEvent[];
};

/** Setores do usuário. Admin move pedidos de qualquer etapa e não depende disto. */
export async function userSectorIds(db: pg.PoolClient, userId: number): Promise<Set<number>> {
  const { rows } = await db.query<{ sector_id: number }>('select sector_id from user_sectors where user_id = $1', [userId]);
  return new Set(rows.map((r) => r.sector_id));
}

/** Quem tira o pedido de uma etapa: o admin, alguém do setor dela, ou qualquer um da loja se ela não tem setor. */
export function canMoveFrom(user: SessionUser, sectorId: number | null, sectors: Set<number>) {
  return user.role === 'admin' || sectorId === null || sectors.has(sectorId);
}

/**
 * Coloca o pedido recém-confirmado na primeira etapa do fluxo da loja para o tipo de
 * entrega dele: o fluxo próprio da loja, senão o modelo da lojamestre. Sem fluxo, o
 * pedido fica sem etapa. Chamar dentro da mesma transação que confirma o pedido.
 */
export async function enterWorkflow(db: pg.PoolClient, orderId: number, userId: number): Promise<StageRef | null> {
  const { rows } = await db.query<StageRef>(
    `select ws.id, ws.name
       from orders o
       join workflows w
         on w.delivery_type = case when o.delivery_address is null then 'pickup' else 'delivery' end
        and (w.store_id = o.store_id or w.store_id is null)
       join workflow_stages ws on ws.workflow_id = w.id
      where o.id = $1
      order by w.store_id is null, ws.position
      limit 1`,
    [orderId],
  );
  const stage = rows[0];
  if (!stage) return null;
  await db.query('update orders set stage_id = $2, stage_entered_at = now() where id = $1', [orderId, stage.id]);
  await db.query(
    `insert into order_stage_events (tenant_id, order_id, to_stage_id, to_stage_name, user_id)
     select o.tenant_id, o.id, $2, $3, $4 from orders o where o.id = $1`,
    [orderId, stage.id, stage.name, userId],
  );
  return stage;
}

type CurrentStageRow = {
  order_status: 'quote' | 'order' | 'cancelled';
  stage_id: number;
  stage_name: string;
  sector_id: number | null;
  sector_name: string | null;
  sla_minutes: number | null;
  entered_at: Date;
  next_id: number | null;
  next_name: string | null;
  previous_id: number | null;
  previous_name: string | null;
};

/** Etapa atual com a próxima e a anterior do mesmo fluxo. Roda dentro de withSession. */
async function loadCurrentStage(db: pg.PoolClient, orderId: number, lock = false): Promise<CurrentStageRow | null> {
  const { rows } = await db.query<CurrentStageRow>(
    `select o.status as order_status, ws.id as stage_id, ws.name as stage_name, ws.sector_id, s.name as sector_name, ws.sla_minutes,
            o.stage_entered_at as entered_at,
            nx.id as next_id, nx.name as next_name, pv.id as previous_id, pv.name as previous_name
       from orders o
       join workflow_stages ws on ws.id = o.stage_id
       left join sectors s on s.id = ws.sector_id
       left join lateral (
         select id, name from workflow_stages
          where workflow_id = ws.workflow_id and position > ws.position
          order by position limit 1
       ) nx on true
       left join lateral (
         select id, name from workflow_stages
          where workflow_id = ws.workflow_id and position < ws.position
          order by position desc limit 1
       ) pv on true
      where o.id = $1
      ${lock ? 'for update of o' : ''}`,
    [orderId],
  );
  return rows[0] ?? null;
}

const ref = (id: number | null, name: string | null): StageRef | null => (id !== null && name !== null ? { id, name } : null);

export async function loadOrderWorkflow(db: pg.PoolClient, orderId: number, user: SessionUser): Promise<OrderWorkflow | null> {
  const current = await loadCurrentStage(db, orderId);
  if (!current) return null;
  const sectors = await userSectorIds(db, user.id);
  // Pedido cancelado guarda a etapa onde parou, mas não anda mais.
  const cancelled = current.order_status === 'cancelled';
  const { rows: events } = await db.query<StageEvent>(
    `select e.id, e.from_stage_name, e.to_stage_name, u.name as user_name, e.note, e.created_at
       from order_stage_events e
       join users u on u.id = e.user_id
      where e.order_id = $1
      order by e.created_at, e.id`,
    [orderId],
  );
  return {
    stage_id: current.stage_id,
    stage_name: current.stage_name,
    sector_id: current.sector_id,
    sector_name: current.sector_name,
    sla_minutes: current.sla_minutes,
    entered_at: current.entered_at,
    is_final: current.next_id === null,
    next_stage: cancelled ? null : ref(current.next_id, current.next_name),
    previous_stage: cancelled ? null : ref(current.previous_id, current.previous_name),
    can_move: !cancelled && canMoveFrom(user, current.sector_id, sectors),
    events,
  };
}

export type MoveInput = {
  direction: 'next' | 'previous';
  /** A etapa que a pessoa viu na tela. Se outra pessoa já moveu o pedido, nada muda. */
  expected_stage_id: number;
  note: string | null;
};

/** Etapa em que o pedido entrou, com a mensagem de WhatsApp dela. */
export type EnteredStage = StageRef & { whatsapp_message: string | null };

/**
 * Avança o pedido para a próxima etapa ou devolve para a anterior. A linha do pedido
 * fica travada até o fim da transação, então dois cliques ao mesmo tempo (em dois
 * monitores) não pulam duas etapas: o segundo recebe 409.
 */
export async function moveOrderStage(
  db: pg.PoolClient,
  orderId: number,
  user: SessionUser,
  input: MoveInput,
): Promise<EnteredStage> {
  const current = await loadCurrentStage(db, orderId, true);
  if (!current) {
    const exists = await db.query('select 1 from orders where id = $1', [orderId]);
    if (!exists.rowCount) throw new HttpError(404, 'Pedido não encontrado.');
    throw new HttpError(409, 'Este pedido não passa por etapas.');
  }
  if (current.order_status === 'cancelled') throw new HttpError(409, 'Pedido cancelado não muda de etapa.');
  if (current.stage_id !== input.expected_stage_id) {
    throw new HttpError(
      409,
      `Este pedido já foi movido para "${current.stage_name}" por outra pessoa. A tela foi atualizada.`,
      'STAGE_CHANGED',
    );
  }
  const sectors = await userSectorIds(db, user.id);
  if (!canMoveFrom(user, current.sector_id, sectors)) {
    throw new HttpError(403, `Só quem é do setor ${current.sector_name} pode mover pedidos da etapa "${current.stage_name}".`);
  }
  const targetId = input.direction === 'next' ? current.next_id : current.previous_id;
  if (targetId === null) {
    throw new HttpError(409, input.direction === 'next' ? 'Este pedido já está concluído.' : 'Este pedido já está na primeira etapa.');
  }

  const { rows } = await db.query<EnteredStage>('select id, name, whatsapp_message from workflow_stages where id = $1', [
    targetId,
  ]);
  const target = rows[0]!;
  await db.query('update orders set stage_id = $2, stage_entered_at = now(), updated_at = now() where id = $1', [
    orderId,
    target.id,
  ]);
  await db.query(
    `insert into order_stage_events (tenant_id, order_id, from_stage_id, from_stage_name, to_stage_id, to_stage_name, user_id, note)
     select o.tenant_id, o.id, $2, $3, $4, $5, $6, $7 from orders o where o.id = $1`,
    [orderId, current.stage_id, current.stage_name, target.id, target.name, user.id, input.note],
  );
  return target;
}

/** Placeholders aceitos na mensagem da etapa. */
export const MESSAGE_PLACEHOLDERS = ['{cliente}', '{pedido}', '{loja}', '{etapa}'] as const;

/** Troca os placeholders da mensagem da etapa. {cliente} é o primeiro nome, como na legenda do PDF. */
export function renderStageMessage(
  template: string,
  values: { clientName: string; orderId: number; storeName: string; stageName: string },
) {
  const firstName = values.clientName.trim().split(/\s+/)[0] ?? '';
  const replacements: Record<string, string> = {
    '{cliente}': firstName,
    '{pedido}': formatOrderNumber(values.orderId),
    '{loja}': values.storeName,
    '{etapa}': values.stageName,
  };
  return template.replace(/\{(cliente|pedido|loja|etapa)\}/gi, (match) => replacements[match.toLowerCase()] ?? match);
}
