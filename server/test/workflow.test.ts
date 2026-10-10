import type pg from 'pg';
import type request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { createApp } from '../src/app.js';
import { renderStageMessage } from '../src/workflow/queries.js';
import {
  login,
  resetDatabase,
  seedFixtures,
  setupApp,
  startFakeEvolution,
  TEST_DATABASE_URL,
  type Fixtures,
} from './helpers.js';

const describeDb = TEST_DATABASE_URL ? describe : describe.skip;

type Agent = ReturnType<typeof request.agent>;
type Stage = { id: number; name: string; sector_id: number | null; sla_minutes: number | null; whatsapp_message: string | null };
type Workflow = { id: number; store_id: number | null; delivery_type: 'pickup' | 'delivery'; stages: Stage[] };

describe('mensagem da etapa', () => {
  it('troca os placeholders e usa o primeiro nome do cliente', () => {
    expect(
      renderStageMessage('Olá, {cliente}! Pedido {PEDIDO} em "{etapa}" na {loja}. {outro}', {
        clientName: '  Maria da Silva',
        orderId: 42,
        storeName: 'Loja A',
        stageName: 'Saiu para entrega',
      }),
    ).toBe('Olá, Maria! Pedido 000042 em "Saiu para entrega" na Loja A. {outro}');
  });
});

describeDb('fluxo do pedido', () => {
  let pool: pg.Pool;
  let adminPool: pg.Pool;
  let app: ReturnType<typeof createApp>;
  let f: Fixtures;
  let evolution: Awaited<ReturnType<typeof startFakeEvolution>>;

  beforeAll(async () => {
    ({ pool, app, adminPool } = setupApp(TEST_DATABASE_URL!));
    evolution = await startFakeEvolution();
  });

  afterAll(async () => {
    await evolution?.close();
    await pool?.end();
    await adminPool?.end();
  });

  beforeEach(async () => {
    await resetDatabase(pool, adminPool);
    f = await seedFixtures(pool, adminPool);
    evolution.requests.length = 0;
    evolution.respondWith(201, { key: { id: 'MSG1' }, status: 'PENDING' });
  });

  function createOrder(agent: Agent, extra: Record<string, unknown> = {}) {
    return agent.post('/api/orders').send({
      client_id: f.clientId,
      status: 'order',
      items: [{ product_id: f.products.cimento, quantity: 2 }],
      ...extra,
    });
  }

  async function suggested(admin: Agent) {
    const res = await admin.post('/api/workflows/suggested');
    expect(res.status).toBe(201);
    const sectors = await admin.get('/api/sectors');
    const sectorId = (name: string) => sectors.body.items.find((s: { name: string }) => s.name === name).id as number;
    const template = (type: 'pickup' | 'delivery') =>
      (res.body.items as Workflow[]).find((w) => w.store_id === null && w.delivery_type === type)!;
    return { pickup: template('pickup'), delivery: template('delivery'), sectorId };
  }

  function move(agent: Agent, orderId: number, expected: number, direction: 'next' | 'previous' = 'next', note?: string) {
    return agent.post(`/api/orders/${orderId}/stage`).send({ direction, expected_stage_id: expected, note });
  }

  /** Troca os setores do Vendedor A. */
  async function setSectors(admin: Agent, sectorIds: number[]) {
    const res = await admin.put(`/api/users/${f.sellerAId}`).send({
      name: 'Vendedor A',
      username: 'vendedor.a',
      email: null,
      role: 'seller',
      store_id: f.storeA,
      active: true,
      sector_ids: sectorIds,
    });
    expect(res.status).toBe(200);
    expect(res.body.user.sector_ids).toEqual([...sectorIds].sort((a, b) => a - b));
  }

  it('sem fluxo configurado, o pedido confirmado fica sem etapa', async () => {
    const seller = await login(app, 'vendedor.a');
    const created = await createOrder(seller);
    expect(created.status).toBe(201);
    expect(created.body.order.workflow).toBeNull();

    const moved = await move(seller, created.body.order.id, 1);
    expect(moved.status).toBe(409);
    const monitor = await seller.get('/api/monitor');
    expect(monitor.body).toMatchObject({ columns: [], orders: [] });
  });

  it('cria o fluxo sugerido uma vez só e só o admin configura', async () => {
    const admin = await login(app, 'admin');
    const { pickup, delivery } = await suggested(admin);
    expect(pickup.stages.map((s) => s.name)).toEqual(['Aguardando faturamento', 'Em separação', 'Pronto para retirada', 'Retirado']);
    expect(delivery.stages).toHaveLength(5);

    const again = await admin.post('/api/workflows/suggested');
    expect(again.body.items).toHaveLength(2);
    const sectors = await admin.get('/api/sectors');
    expect(sectors.body.items.map((s: { name: string }) => s.name)).toEqual(['Expedição', 'Faturamento', 'Separação']);

    const seller = await login(app, 'vendedor.a');
    expect((await seller.get('/api/workflows')).status).toBe(403);
    expect((await seller.post('/api/sectors').send({ name: 'Caixa' })).status).toBe(403);
    // O vendedor lista os setores: o monitor precisa.
    expect((await seller.get('/api/sectors')).status).toBe(200);
  });

  it('pedido entra na primeira etapa do fluxo do tipo de entrega dele', async () => {
    const admin = await login(app, 'admin');
    const { pickup, delivery } = await suggested(admin);
    const seller = await login(app, 'vendedor.a');

    const retirada = await createOrder(seller);
    expect(retirada.body.order.workflow).toMatchObject({
      stage_id: pickup.stages[0]!.id,
      stage_name: 'Aguardando faturamento',
      sector_name: 'Faturamento',
      is_final: false,
      previous_stage: null,
      next_stage: { id: pickup.stages[1]!.id, name: 'Em separação' },
      can_move: false,
    });
    expect(retirada.body.order.workflow.events).toMatchObject([
      { from_stage_name: null, to_stage_name: 'Aguardando faturamento', user_name: 'Vendedor A' },
    ]);

    const entrega = await createOrder(seller, { delivery_address: 'Rua das Obras, 10' });
    expect(entrega.body.order.workflow.stage_id).toBe(delivery.stages[0]!.id);

    // Orçamento não entra no fluxo; entra quando vira pedido (convertendo ou salvando como pedido).
    const quote = await createOrder(seller, { status: 'quote' });
    expect(quote.body.order.workflow).toBeNull();
    const converted = await seller.post(`/api/orders/${quote.body.order.id}/convert`);
    expect(converted.body.order.workflow.stage_id).toBe(pickup.stages[0]!.id);

    const quote2 = await createOrder(seller, { status: 'quote' });
    const saved = await seller.put(`/api/orders/${quote2.body.order.id}`).send({
      client_id: f.clientId,
      status: 'order',
      delivery_address: 'Rua Nova, 5',
      items: [{ product_id: f.products.tijolo, quantity: 100 }],
    });
    expect(saved.status).toBe(200);
    expect(saved.body.order.workflow.stage_id).toBe(delivery.stages[0]!.id);

    const list = await seller.get('/api/orders?status=order');
    expect(list.body.items.map((o: { stage_name: string }) => o.stage_name)).toContain('Aguardando faturamento');
  });

  it('loja com fluxo próprio usa o dela; as outras continuam no modelo', async () => {
    const admin = await login(app, 'admin');
    const { pickup, sectorId } = await suggested(admin);

    const imported = await admin.post('/api/workflows/import').send({ store_id: f.storeA, delivery_type: 'pickup' });
    expect(imported.status).toBe(201);
    const own: Workflow = imported.body.workflow;
    expect(own.store_id).toBe(f.storeA);
    expect(own.stages.map((s) => s.name)).toEqual(pickup.stages.map((s) => s.name));
    expect(own.stages[0]!.id).not.toBe(pickup.stages[0]!.id);

    // Loja A tira o faturamento: separa direto e entrega no balcão.
    const edited = await admin.put('/api/workflows').send({
      store_id: f.storeA,
      delivery_type: 'pickup',
      stages: [
        { id: own.stages[1]!.id, name: 'Separando', sector_id: sectorId('Separação'), sla_minutes: 20 },
        { id: own.stages[3]!.id, name: 'Retirado' },
      ],
    });
    expect(edited.status).toBe(200);
    expect(edited.body.workflow.stages).toMatchObject([
      { id: own.stages[1]!.id, position: 1, name: 'Separando', sla_minutes: 20 },
      { id: own.stages[3]!.id, position: 2, name: 'Retirado', sector_id: null },
    ]);

    const sellerA = await login(app, 'vendedor.a');
    const sellerB = await login(app, 'vendedor.b');
    expect((await createOrder(sellerA)).body.order.workflow.stage_name).toBe('Separando');
    expect((await createOrder(sellerB)).body.order.workflow.stage_name).toBe('Aguardando faturamento');

    // Loja A volta para o modelo apagando o fluxo próprio... mas só sem pedidos nele.
    const blocked = await admin.delete(`/api/workflows/${own.id}`);
    expect(blocked.status).toBe(409);
    expect(blocked.body.error).toContain('"Separando" tem 1 pedido');
  });

  it('só quem é do setor da etapa move o pedido', async () => {
    const admin = await login(app, 'admin');
    const { pickup, sectorId } = await suggested(admin);
    const sellerA = await login(app, 'vendedor.a');
    const order = (await createOrder(sellerA)).body.order;
    const [faturamento, separacao, pronto, retirado] = pickup.stages as [Stage, Stage, Stage, Stage];

    const denied = await move(sellerA, order.id, faturamento.id);
    expect(denied.status).toBe(403);
    expect(denied.body.error).toContain('setor Faturamento');

    await setSectors(admin, [sectorId('Faturamento')]);
    const advanced = await move(sellerA, order.id, faturamento.id);
    expect(advanced.status).toBe(200);
    expect(advanced.body.order.workflow).toMatchObject({ stage_id: separacao.id, can_move: false });
    expect(advanced.body.notification).toBeNull();

    // Vendedor da outra loja nem enxerga o pedido.
    const sellerB = await login(app, 'vendedor.b');
    expect((await move(sellerB, order.id, separacao.id)).status).toBe(404);

    // Admin move de qualquer etapa; a etapa final não tem setor.
    expect((await move(admin, order.id, separacao.id)).status).toBe(200);
    const done = await move(admin, order.id, pronto.id, 'next');
    expect(done.body.order.workflow).toMatchObject({ stage_id: retirado.id, is_final: true, next_stage: null });
    expect((await move(admin, order.id, retirado.id)).body.error).toBe('Este pedido já está concluído.');

    // Devolver com motivo fica no histórico.
    const back = await move(sellerA, order.id, retirado.id, 'previous', 'Cliente ainda não retirou');
    expect(back.status).toBe(200);
    const events = back.body.order.workflow.events;
    expect(events.at(-1)).toMatchObject({
      from_stage_name: 'Retirado',
      to_stage_name: 'Pronto para retirada',
      user_name: 'Vendedor A',
      note: 'Cliente ainda não retirou',
    });
    expect(events).toHaveLength(5);
  });

  it('segundo clique na mesma etapa não pula duas etapas', async () => {
    const admin = await login(app, 'admin');
    const { pickup } = await suggested(admin);
    const order = (await createOrder(admin, { store_id: f.storeA })).body.order;
    const first = pickup.stages[0]!.id;

    const [a, b] = await Promise.all([move(admin, order.id, first), move(admin, order.id, first)]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
    const conflict = a.status === 409 ? a : b;
    expect(conflict.body).toMatchObject({ code: 'STAGE_CHANGED' });
    const detail = await admin.get(`/api/orders/${order.id}`);
    expect(detail.body.order.workflow.stage_name).toBe('Em separação');
  });

  it('avisa o cliente pelo WhatsApp ao entrar numa etapa com mensagem', async () => {
    const admin = await login(app, 'admin');
    const { pickup } = await suggested(admin);
    const order = (await createOrder(admin, { store_id: f.storeA })).body.order;
    await move(admin, order.id, pickup.stages[0]!.id);

    // Sem WhatsApp configurado: a etapa muda e a resposta diz que o cliente não foi avisado.
    const unconfigured = await move(admin, order.id, pickup.stages[1]!.id);
    expect(unconfigured.status).toBe(200);
    expect(unconfigured.body.order.workflow.stage_name).toBe('Pronto para retirada');
    expect(unconfigured.body.notification).toMatchObject({ status: 'failed' });
    expect(evolution.requests).toHaveLength(0);

    await admin.put('/api/settings').send({
      evolution_api_url: evolution.url,
      evolution_instance: 'loja',
      evolution_api_token: 'token-secreto-1234',
    });
    await move(admin, order.id, pickup.stages[2]!.id, 'previous');
    const sent = await move(admin, order.id, pickup.stages[1]!.id);
    expect(sent.body.notification).toEqual({ status: 'sent' });
    expect(evolution.requests).toHaveLength(1);
    expect(evolution.requests[0]).toMatchObject({
      method: 'POST',
      url: '/message/sendText/loja',
      body: {
        number: '5511987654321',
        text: `Olá, Maria! Seu pedido nº ${String(order.id).padStart(6, '0')} está pronto para retirada na Loja A.`,
      },
    });

    // Falha da EvolutionAPI não desfaz a etapa.
    evolution.respondWith(500, { error: 'boom' });
    await move(admin, order.id, pickup.stages[2]!.id, 'previous');
    const failed = await move(admin, order.id, pickup.stages[1]!.id);
    expect(failed.status).toBe(200);
    expect(failed.body.notification.status).toBe('failed');
    expect(failed.body.order.workflow.stage_name).toBe('Pronto para retirada');
  });

  it('não remove etapa com pedido e valida o fluxo', async () => {
    const admin = await login(app, 'admin');
    const { pickup } = await suggested(admin);
    await createOrder(admin, { store_id: f.storeA });

    const removing = await admin.put('/api/workflows').send({
      store_id: null,
      delivery_type: 'pickup',
      stages: pickup.stages.slice(1),
    });
    expect(removing.status).toBe(409);
    expect(removing.body.error).toContain('"Aguardando faturamento" tem 1 pedido');

    const duplicate = await admin.put('/api/workflows').send({
      store_id: null,
      delivery_type: 'pickup',
      stages: [{ name: 'Separação' }, { name: 'separação' }],
    });
    expect(duplicate.status).toBe(400);
    const tooShort = await admin.put('/api/workflows').send({ store_id: null, delivery_type: 'pickup', stages: [{ name: 'Fim' }] });
    expect(tooShort.status).toBe(400);

    // Reordenar troca as posições sem violar a unicidade.
    const reversed = [...pickup.stages].reverse();
    const reordered = await admin.put('/api/workflows').send({ store_id: null, delivery_type: 'pickup', stages: reversed });
    expect(reordered.status).toBe(200);
    expect(reordered.body.workflow.stages.map((s: Stage) => s.id)).toEqual(reversed.map((s) => s.id));

    // Setor de outra lojamestre não entra.
    const other = await adminPool.query<{ id: number }>(`insert into tenants (slug, name) values ('outra', 'Outra') returning id`);
    const foreign = await adminPool.query<{ id: number }>(`insert into sectors (tenant_id, name) values ($1, 'Intruso') returning id`, [
      other.rows[0]!.id,
    ]);
    const res = await admin.put('/api/workflows').send({
      store_id: null,
      delivery_type: 'delivery',
      stages: [{ name: 'A', sector_id: foreign.rows[0]!.id }, { name: 'B' }],
    });
    expect(res.status).toBe(400);
  });

  it('monitor mostra os pedidos em andamento do setor, sem a etapa final', async () => {
    const admin = await login(app, 'admin');
    const { pickup, delivery, sectorId } = await suggested(admin);
    const sellerA = await login(app, 'vendedor.a');
    const sellerB = await login(app, 'vendedor.b');
    const a1 = (await createOrder(sellerA)).body.order;
    const a2 = (await createOrder(sellerA, { delivery_address: 'Rua X, 1' })).body.order;
    const b1 = (await createOrder(sellerB)).body.order;

    // a1 vai para separação; b1 é concluído.
    await move(admin, a1.id, pickup.stages[0]!.id);
    for (const stage of pickup.stages.slice(0, 3)) await move(admin, b1.id, stage.id);

    const all = await admin.get('/api/monitor');
    expect(all.status).toBe(200);
    expect(all.body.orders.map((o: { id: number }) => o.id).sort()).toEqual([a1.id, a2.id].sort());
    // Colunas das etapas de trabalho (sem as finais), agrupadas pelo nome, na ordem do fluxo.
    expect(all.body.columns.map((c: { name: string }) => c.name)).toEqual([
      'Aguardando faturamento',
      'Em separação',
      'Aguardando carregamento',
      'Pronto para retirada',
      'Saiu para entrega',
    ]);

    const separacao = await sellerA.get(`/api/monitor?sector_id=${sectorId('Separação')}`);
    expect(separacao.body.columns.map((c: { name: string }) => c.name)).toEqual(['Em separação']);
    expect(separacao.body.orders).toMatchObject([
      { id: a1.id, column: 'em separação', delivery_type: 'pickup', items_count: 1, next_stage_name: 'Pronto para retirada', can_move: false },
    ]);
    expect(separacao.body.my_sector_ids).toEqual([]);

    await setSectors(admin, [sectorId('Faturamento')]);
    const faturamento = await sellerA.get(`/api/monitor?sector_id=${sectorId('Faturamento')}`);
    expect(faturamento.body.orders).toMatchObject([{ id: a2.id, stage_id: delivery.stages[0]!.id, can_move: true }]);
    expect(faturamento.body.my_sector_ids).toEqual([sectorId('Faturamento')]);

    // Vendedor B só vê a loja dele, mesmo pedindo outra.
    const fromB = await sellerB.get(`/api/monitor?store_id=${f.storeA}`);
    expect(fromB.body.orders).toEqual([]);
    const adminStoreB = await admin.get(`/api/monitor?store_id=${f.storeB}`);
    expect(adminStoreB.body.orders).toEqual([]);
  });

  it('setores: cadastro, uso e exclusão', async () => {
    const admin = await login(app, 'admin');
    const created = await admin.post('/api/sectors').send({ name: 'Separação' });
    expect(created.status).toBe(201);
    expect((await admin.post('/api/sectors').send({ name: 'SEPARAÇÃO' })).status).toBe(409);

    const user = await admin.post('/api/users').send({
      name: 'Separador',
      username: 'separador',
      password: 'senha-forte-123',
      role: 'seller',
      store_id: f.storeA,
      sector_ids: [created.body.sector.id],
    });
    expect(user.status).toBe(201);
    expect(user.body.user.sector_ids).toEqual([created.body.sector.id]);

    await admin.put('/api/workflows').send({
      store_id: null,
      delivery_type: 'pickup',
      stages: [{ name: 'Separando', sector_id: created.body.sector.id }, { name: 'Retirado' }],
    });
    const list = await admin.get('/api/sectors');
    expect(list.body.items[0]).toMatchObject({ name: 'Separação', users_count: 1, stages_count: 1 });

    const inUse = await admin.delete(`/api/sectors/${created.body.sector.id}`);
    expect(inUse.status).toBe(409);
    expect(inUse.body.error).toContain('usado em etapas');

    // Editar o usuário sem mandar sector_ids mantém os setores.
    const edited = await admin.put(`/api/users/${user.body.user.id}`).send({
      name: 'Separador',
      username: 'separador',
      role: 'seller',
      store_id: f.storeA,
      active: true,
    });
    expect(edited.body.user.sector_ids).toEqual([created.body.sector.id]);
  });
});
