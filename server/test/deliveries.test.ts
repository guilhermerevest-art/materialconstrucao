import type pg from 'pg';
import type request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { createApp } from '../src/app.js';
import { login, resetDatabase, seedFixtures, setupApp, TEST_DATABASE_URL, type Fixtures } from './helpers.js';

const describeDb = TEST_DATABASE_URL ? describe : describe.skip;

type Agent = ReturnType<typeof request.agent>;
type Line = { order_item_id: number; product_id: number; quantity: number; delivered: number; scheduled: number; pending: number };

// PNG de 1x1 pixel: basta para o formato da assinatura e da foto.
const PIXEL = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

describeDb('entregas e retiradas', () => {
  let pool: pg.Pool;
  let adminPool: pg.Pool;
  let app: ReturnType<typeof createApp>;
  let f: Fixtures;

  beforeAll(() => {
    ({ pool, app, adminPool } = setupApp(TEST_DATABASE_URL!));
  });

  afterAll(async () => {
    await pool?.end();
    await adminPool?.end();
  });

  beforeEach(async () => {
    await resetDatabase(pool, adminPool);
    f = await seedFixtures(pool, adminPool);
  });

  async function createOrder(agent: Agent, extra: Record<string, unknown> = {}) {
    const res = await agent.post('/api/orders').send({
      client_id: f.clientId,
      status: 'order',
      store_id: f.storeA,
      delivery_address: 'Rua das Obras, 10 - Centro',
      items: [
        { product_id: f.products.cimento, quantity: 200 },
        { product_id: f.products.areia, quantity: 6 },
      ],
      ...extra,
    });
    expect(res.status).toBe(201);
    return res.body.order as { id: number; items: { id: number; product_id: number }[] };
  }

  async function lines(agent: Agent, orderId: number) {
    const res = await agent.get(`/api/orders/${orderId}/deliveries`);
    expect(res.status).toBe(200);
    const byProduct = (id: number) => (res.body.items as Line[]).find((l) => l.product_id === id)!;
    return { cimento: byProduct(f.products.cimento), areia: byProduct(f.products.areia), body: res.body };
  }

  function itemId(order: { items: { id: number; product_id: number }[] }, productId: number) {
    return order.items.find((i) => i.product_id === productId)!.id;
  }

  it('retirada parcial: o saldo a entregar diminui e não passa do vendido', async () => {
    const seller = await login(app, 'vendedor.a');
    const order = await createOrder(seller, { delivery_address: null });
    const cimento = itemId(order, f.products.cimento);

    const first = await seller.post(`/api/orders/${order.id}/deliveries`).send({
      kind: 'pickup',
      status: 'done',
      receiver_name: 'Seu Zé',
      items: [{ order_item_id: cimento, quantity: 50 }],
    });
    expect(first.status).toBe(201);
    expect(first.body.delivery).toMatchObject({ kind: 'pickup', status: 'done', receiver_name: 'Seu Zé', completed_by_name: 'Vendedor A' });
    let state = await lines(seller, order.id);
    expect(state.cimento).toMatchObject({ quantity: 200, delivered: 50, scheduled: 0, pending: 150 });
    // No estoque, o que foi vendido e não saiu aparece como "a entregar".
    const stock = await seller.get(`/api/stock?store_id=${f.storeA}&q=CIM-50`);
    expect(stock.body.items[0]).toMatchObject({ quantity: -200, to_deliver: 150 });
    expect(state.areia.pending).toBe(6);

    const tooMuch = await seller.post(`/api/orders/${order.id}/deliveries`).send({
      kind: 'pickup',
      status: 'done',
      items: [{ order_item_id: cimento, quantity: 151 }],
    });
    expect(tooMuch.status).toBe(409);
    expect(tooMuch.body.error).toContain('só faltam 150');

    // Entrega no endereço não é registrada como feita sem comprovante.
    const instant = await seller.post(`/api/orders/${order.id}/deliveries`).send({
      kind: 'delivery',
      status: 'done',
      address: 'Rua X',
      items: [{ order_item_id: cimento, quantity: 1 }],
    });
    expect(instant.status).toBe(400);

    // Orçamento não tem entrega.
    const quote = await createOrder(seller, { status: 'quote' });
    const res = await seller.post(`/api/orders/${quote.id}/deliveries`).send({
      kind: 'pickup',
      status: 'done',
      items: [{ order_item_id: itemId(quote, f.products.cimento), quantity: 1 }],
    });
    expect(res.status).toBe(409);
  });

  it('agenda, reagenda e confirma a entrega com comprovante', async () => {
    const seller = await login(app, 'vendedor.a');
    const order = await createOrder(seller);
    const scheduled = await seller.post(`/api/orders/${order.id}/deliveries`).send({
      kind: 'delivery',
      status: 'scheduled',
      scheduled_date: '2026-10-20',
      period: 'morning',
      items: [
        { order_item_id: itemId(order, f.products.cimento), quantity: 100 },
        { order_item_id: itemId(order, f.products.areia), quantity: 6 },
      ],
    });
    expect(scheduled.status).toBe(201);
    const delivery = scheduled.body.delivery;
    expect(delivery).toMatchObject({
      status: 'scheduled',
      scheduled_date: '2026-10-20',
      address: 'Rua das Obras, 10 - Centro',
      period: 'morning',
    });
    expect(delivery.items).toHaveLength(2);
    expect((await lines(seller, order.id)).cimento).toMatchObject({ scheduled: 100, pending: 100 });

    const moved = await seller.put(`/api/deliveries/${delivery.id}`).send({ scheduled_date: '2026-10-21', period: 'afternoon' });
    expect(moved.body.delivery).toMatchObject({ period: 'afternoon' });
    const agenda = await seller.get('/api/deliveries?from=2026-10-21');
    expect(agenda.body.items.map((d: { id: number }) => d.id)).toEqual([delivery.id]);
    expect((await seller.get('/api/deliveries?from=2026-10-20')).body.items).toEqual([]);
    const overdue = await seller.get('/api/deliveries?overdue=true&from=2026-10-25');
    expect(overdue.body.items).toHaveLength(1);

    const badSignature = await seller.post(`/api/deliveries/${delivery.id}/complete`).send({
      receiver_name: 'Mestre Raimundo',
      signature: 'data:text/html;base64,PGgxPg==',
    });
    expect(badSignature.status).toBe(400);

    const done = await seller.post(`/api/deliveries/${delivery.id}/complete`).send({
      receiver_name: 'Mestre Raimundo',
      receiver_document: '123.456.789-00',
      signature: PIXEL,
      photo: PIXEL,
    });
    expect(done.status).toBe(200);
    expect(done.body.delivery).toMatchObject({ status: 'done', has_signature: true, has_photo: true, receiver_name: 'Mestre Raimundo' });
    expect((await lines(seller, order.id)).cimento).toMatchObject({ delivered: 100, scheduled: 0, pending: 100 });
    const proof = await seller.get(`/api/deliveries/${delivery.id}/proof`);
    expect(proof.body).toEqual({ signature: PIXEL, photo: PIXEL });
    expect((await seller.post(`/api/deliveries/${delivery.id}/complete`).send({ receiver_name: 'De novo' })).status).toBe(409);

    // Estornar entrega já confirmada é só do admin; a quantidade volta para o saldo.
    expect((await seller.post(`/api/deliveries/${delivery.id}/cancel`).send({ reason: 'Engano' })).status).toBe(403);
    const admin = await login(app, 'admin');
    const reversed = await admin.post(`/api/deliveries/${delivery.id}/cancel`).send({ reason: 'Registrada por engano' });
    expect(reversed.body.delivery).toMatchObject({ status: 'cancelled', cancel_reason: 'Registrada por engano' });
    expect((await lines(admin, order.id)).cimento).toMatchObject({ delivered: 0, pending: 200 });
  });

  it('romaneio: monta, sai, confirma uma e devolve a que ficou para reagendar', async () => {
    const seller = await login(app, 'vendedor.a');
    const admin = await login(app, 'admin');
    const vehicle = await admin.post('/api/vehicles').send({ name: 'Caminhão baú', plate: 'abc-1d23' });
    expect(vehicle.body.vehicle).toMatchObject({ plate: 'ABC1D23' });
    expect((await admin.post('/api/vehicles').send({ name: 'Moto', plate: 'XX' })).status).toBe(400);
    expect((await seller.post('/api/vehicles').send({ name: 'Moto' })).status).toBe(403);

    const schedule = async (orderId: number, items: { order_item_id: number; quantity: number }[], kind = 'delivery') =>
      (
        await seller.post(`/api/orders/${orderId}/deliveries`).send({
          kind,
          status: 'scheduled',
          scheduled_date: '2026-10-20',
          items,
        })
      ).body.delivery as { id: number };
    const o1 = await createOrder(seller);
    const o2 = await createOrder(seller, { delivery_address: 'Av. Brasil, 500' });
    const d1 = await schedule(o1.id, [{ order_item_id: itemId(o1, f.products.cimento), quantity: 200 }]);
    const d2 = await schedule(o2.id, [{ order_item_id: itemId(o2, f.products.areia), quantity: 6 }]);
    const pickup = await schedule(o2.id, [{ order_item_id: itemId(o2, f.products.cimento), quantity: 10 }], 'pickup');

    const withPickup = await seller.post('/api/delivery-routes').send({
      route_date: '2026-10-20',
      delivery_ids: [d1.id, pickup.id],
    });
    expect(withPickup.status).toBe(400);

    const created = await seller.post('/api/delivery-routes').send({
      route_date: '2026-10-20',
      vehicle_id: vehicle.body.vehicle.id,
      driver_name: 'Josué',
      delivery_ids: [d2.id, d1.id],
    });
    expect(created.status).toBe(201);
    const route = created.body.route;
    expect(route).toMatchObject({ status: 'open', vehicle_name: 'Caminhão baú', driver_name: 'Josué', store_id: f.storeA });
    const agenda = (await seller.get('/api/deliveries?from=2026-10-20')).body.items as { id: number; route_id: number; route_position: number }[];
    expect(agenda.filter((d) => d.route_id === route.id).map((d) => d.id)).toEqual([d2.id, d1.id]);

    const pdf = await seller.get(`/api/delivery-routes/${route.id}/pdf`);
    expect(pdf.status).toBe(200);
    expect(pdf.headers['content-type']).toBe('application/pdf');
    expect(pdf.body.subarray(0, 5).toString()).toBe('%PDF-');

    expect((await seller.post(`/api/delivery-routes/${route.id}/finish`)).status).toBe(409);
    const departed = await seller.post(`/api/delivery-routes/${route.id}/depart`);
    expect(departed.body.route.status).toBe('in_route');
    expect((await seller.get(`/api/deliveries/${d1.id}`)).body.delivery.status).toBe('in_route');
    expect((await seller.delete(`/api/delivery-routes/${route.id}`)).status).toBe(409);

    await seller.post(`/api/deliveries/${d2.id}/complete`).send({ receiver_name: 'Portaria' });
    const finished = await seller.post(`/api/delivery-routes/${route.id}/finish`);
    expect(finished.body).toMatchObject({ route: { status: 'done' }, returned: 1 });
    expect((await seller.get(`/api/deliveries/${d1.id}`)).body.delivery).toMatchObject({ status: 'scheduled', route_id: null });

    // Vendedor da outra loja não vê o romaneio nem as entregas.
    const sellerB = await login(app, 'vendedor.b');
    expect((await sellerB.get('/api/delivery-routes?from=2026-10-20')).body.items).toEqual([]);
    expect((await sellerB.get(`/api/deliveries/${d1.id}`)).status).toBe(404);
  });

  it('cancelar pedido: bloqueado com entrega feita; desmarca as agendadas', async () => {
    const admin = await login(app, 'admin');
    const order = await createOrder(admin);
    const cimento = itemId(order, f.products.cimento);
    const done = await admin.post(`/api/orders/${order.id}/deliveries`).send({
      kind: 'pickup',
      status: 'done',
      items: [{ order_item_id: cimento, quantity: 10 }],
    });
    const scheduled = await admin.post(`/api/orders/${order.id}/deliveries`).send({
      kind: 'delivery',
      status: 'scheduled',
      scheduled_date: '2026-10-20',
      items: [{ order_item_id: cimento, quantity: 20 }],
    });

    const blocked = await admin.post(`/api/orders/${order.id}/cancel`).send({ reason: 'Cliente desistiu' });
    expect(blocked.status).toBe(409);
    expect(blocked.body.error).toContain('entrega');

    await admin.post(`/api/deliveries/${done.body.delivery.id}/cancel`).send({ reason: 'Devolveu no balcão' });
    const cancelled = await admin.post(`/api/orders/${order.id}/cancel`).send({ reason: 'Cliente desistiu' });
    expect(cancelled.status).toBe(200);
    expect((await admin.get(`/api/deliveries/${scheduled.body.delivery.id}`)).body.delivery).toMatchObject({
      status: 'cancelled',
      cancel_reason: 'Pedido cancelado: Cliente desistiu',
    });
  });

  it('chegar na etapa final do fluxo registra a entrega do que faltava', async () => {
    const admin = await login(app, 'admin');
    await admin.post('/api/workflows/suggested');
    const order = await createOrder(admin, { delivery_address: null });
    // Uma parte já saiu antes.
    await admin.post(`/api/orders/${order.id}/deliveries`).send({
      kind: 'pickup',
      status: 'done',
      items: [{ order_item_id: itemId(order, f.products.cimento), quantity: 80 }],
    });
    let detail = (await admin.get(`/api/orders/${order.id}`)).body.order;
    while (detail.workflow.next_stage) {
      detail = (
        await admin.post(`/api/orders/${order.id}/stage`).send({ direction: 'next', expected_stage_id: detail.workflow.stage_id })
      ).body.order;
    }
    expect(detail.workflow.stage_name).toBe('Retirado');
    const state = await lines(admin, order.id);
    expect(state.cimento).toMatchObject({ delivered: 200, pending: 0 });
    expect(state.areia).toMatchObject({ delivered: 6, pending: 0 });
    expect(state.body.deliveries.at(-1)).toMatchObject({ kind: 'pickup', status: 'done', notes: 'Registrado ao chegar na etapa "Retirado".' });
  });

  it('pedido de antes do controle de entregas não tem saldo', async () => {
    const admin = await login(app, 'admin');
    const order = await createOrder(admin);
    await adminPool.query('update orders set delivery_tracking = false where id = $1', [order.id]);
    const res = await admin.get(`/api/orders/${order.id}/deliveries`);
    expect(res.body.tracking).toBe(false);
    const post = await admin.post(`/api/orders/${order.id}/deliveries`).send({
      kind: 'pickup',
      status: 'done',
      items: [{ order_item_id: itemId(order, f.products.cimento), quantity: 1 }],
    });
    expect(post.status).toBe(409);
  });
});
