import type pg from 'pg';
import type request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { createApp } from '../src/app.js';
import { login, resetDatabase, seedFixtures, setupApp, TEST_DATABASE_URL, type Fixtures } from './helpers.js';

const describeDb = TEST_DATABASE_URL ? describe : describe.skip;

type Agent = ReturnType<typeof request.agent>;

describeDb('cancelamento de pedido e orçamento perdido', () => {
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

  function createOrder(agent: Agent, status: 'quote' | 'order' = 'order') {
    return agent.post('/api/orders').send({
      client_id: f.clientId,
      status,
      store_id: f.storeA,
      items: [{ product_id: f.products.cimento, quantity: 2 }],
    });
  }

  it('vendedor marca orçamento como perdido e reabre', async () => {
    const seller = await login(app, 'vendedor.a');
    const quote = (await createOrder(seller, 'quote')).body.order;

    expect((await seller.post(`/api/orders/${quote.id}/cancel`).send({ reason: '' })).status).toBe(400);
    const lost = await seller.post(`/api/orders/${quote.id}/cancel`).send({ reason: 'Comprou em outro lugar' });
    expect(lost.status).toBe(200);
    expect(lost.body.order).toMatchObject({
      status: 'cancelled',
      cancelled_from: 'quote',
      cancel_reason: 'Comprou em outro lugar',
      cancelled_by_name: 'Vendedor A',
    });

    const dashboard = await seller.get('/api/dashboard');
    expect(dashboard.body.summary.open_quotes).toBe(0);
    const list = await seller.get('/api/orders?status=cancelled');
    expect(list.body.items.map((o: { id: number }) => o.id)).toEqual([quote.id]);

    expect((await seller.post(`/api/orders/${quote.id}/convert`)).body.error).toContain('Reabra');
    const reopened = await seller.post(`/api/orders/${quote.id}/reopen`);
    expect(reopened.body.order).toMatchObject({ status: 'quote', cancelled_at: null, cancel_reason: null });
    expect((await seller.post(`/api/orders/${quote.id}/convert`)).status).toBe(200);
  });

  it('só o admin cancela pedido confirmado, e o cancelado fica travado', async () => {
    const seller = await login(app, 'vendedor.a');
    const admin = await login(app, 'admin');
    const order = (await createOrder(seller)).body.order;

    expect((await seller.post(`/api/orders/${order.id}/cancel`).send({ reason: 'Cliente desistiu' })).status).toBe(403);
    const sellerB = await login(app, 'vendedor.b');
    expect((await sellerB.post(`/api/orders/${order.id}/cancel`).send({ reason: 'Cliente desistiu' })).status).toBe(404);

    const cancelled = await admin.post(`/api/orders/${order.id}/cancel`).send({ reason: 'Cliente desistiu' });
    expect(cancelled.status).toBe(200);
    expect(cancelled.body.order).toMatchObject({ status: 'cancelled', cancelled_from: 'order', cancelled_by_name: 'Admin' });

    expect((await admin.post(`/api/orders/${order.id}/cancel`).send({ reason: 'De novo' })).status).toBe(409);
    expect((await admin.post(`/api/orders/${order.id}/reopen`)).status).toBe(409);
    expect((await admin.post(`/api/orders/${order.id}/whatsapp`)).status).toBe(409);
    const edit = await admin.put(`/api/orders/${order.id}`).send({
      client_id: f.clientId,
      status: 'quote',
      items: [{ product_id: f.products.cimento, quantity: 1 }],
    });
    expect(edit.status).toBe(409);

    // Pedido cancelado sai das vendas do painel.
    expect((await admin.get('/api/dashboard')).body.summary.orders_today).toBe(0);
    const pdf = await admin.get(`/api/orders/${order.id}/pdf`);
    expect(pdf.status).toBe(200);
  });

  it('pedido cancelado sai do monitor e o cancelamento entra no histórico de etapas', async () => {
    const admin = await login(app, 'admin');
    await admin.post('/api/workflows/suggested');
    const order = (await createOrder(admin)).body.order;
    expect((await admin.get('/api/monitor')).body.orders).toHaveLength(1);

    const cancelled = await admin.post(`/api/orders/${order.id}/cancel`).send({ reason: 'Pedido em duplicidade' });
    expect(cancelled.body.order.workflow).toMatchObject({ can_move: false, next_stage: null, previous_stage: null });
    expect(cancelled.body.order.workflow.events.at(-1)).toMatchObject({
      from_stage_name: 'Aguardando faturamento',
      to_stage_name: 'Cancelado',
      note: 'Pedido em duplicidade',
    });
    expect((await admin.get('/api/monitor')).body.orders).toHaveLength(0);
    const move = await admin
      .post(`/api/orders/${order.id}/stage`)
      .send({ direction: 'next', expected_stage_id: order.workflow.stage_id });
    expect(move.status).toBe(409);
  });

  it('com o módulo fiscal, NF-e autorizada impede o cancelamento', async () => {
    const admin = await login(app, 'admin');
    const order = (await createOrder(admin)).body.order;
    // Só o que o cancelamento consulta da tabela do módulo fiscal.
    await adminPool.query(`create table fiscal_documents (id serial primary key, order_id bigint not null, status text not null)`);
    await adminPool.query('grant select on fiscal_documents to oms_app');
    await adminPool.query(`insert into fiscal_documents (order_id, status) values ($1, 'cancelado'), ($1, 'autorizado')`, [order.id]);

    const blocked = await admin.post(`/api/orders/${order.id}/cancel`).send({ reason: 'Cliente desistiu' });
    expect(blocked.status).toBe(409);
    expect(blocked.body.error).toContain('NF-e');

    await adminPool.query(`update fiscal_documents set status = 'cancelado'`);
    expect((await admin.post(`/api/orders/${order.id}/cancel`).send({ reason: 'Cliente desistiu' })).status).toBe(200);
  });
});
