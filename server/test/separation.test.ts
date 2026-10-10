import type pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { createApp } from '../src/app.js';
import { login, resetDatabase, seedFixtures, setupApp, TEST_DATABASE_URL, type Fixtures } from './helpers.js';

const describeDb = TEST_DATABASE_URL ? describe : describe.skip;

describeDb('separação e conferência', () => {
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

  it('lista o que falta sair, gera o PDF e registra a conferência', async () => {
    const seller = await login(app, 'vendedor.a');
    const order = (
      await seller.post('/api/orders').send({
        client_id: f.clientId,
        status: 'order',
        notes: 'Separar o cimento do lote novo',
        items: [
          { product_id: f.products.cimento, quantity: 20 },
          { product_id: f.products.tijolo, quantity: 500 },
        ],
      })
    ).body.order;
    const cimento = order.items.find((i: { product_id: number }) => i.product_id === f.products.cimento).id;
    const tijolo = order.items.find((i: { product_id: number }) => i.product_id === f.products.tijolo).id;

    // Metade do cimento já saiu: a separação é só do resto.
    await seller.post(`/api/orders/${order.id}/deliveries`).send({
      kind: 'pickup',
      status: 'done',
      items: [{ order_item_id: cimento, quantity: 10 }],
    });
    const separation = await seller.get(`/api/orders/${order.id}/separation`);
    expect(separation.status).toBe(200);
    expect(separation.body.items).toMatchObject([
      { order_item_id: cimento, product_code: 'CIM-50', quantity: 10 },
      { order_item_id: tijolo, quantity: 500 },
    ]);

    const pdf = await seller.get(`/api/orders/${order.id}/separation/pdf`);
    expect(pdf.status).toBe(200);
    expect(pdf.headers['content-type']).toBe('application/pdf');

    const divergent = await seller.post(`/api/orders/${order.id}/checks`).send({
      items: [
        { order_item_id: cimento, counted: 10 },
        { order_item_id: tijolo, counted: 480 },
      ],
      note: 'Faltaram 20 tijolos quebrados',
    });
    expect(divergent.status).toBe(201);
    expect(divergent.body.check).toMatchObject({ ok: false, user_name: 'Vendedor A' });
    expect(divergent.body.check.items[1]).toMatchObject({ expected: 500, counted: 480 });

    const ok = await seller.post(`/api/orders/${order.id}/checks`).send({
      items: [
        { order_item_id: cimento, counted: 10 },
        { order_item_id: tijolo, counted: 500 },
      ],
    });
    expect(ok.body.check.ok).toBe(true);
    const checks = (await seller.get(`/api/orders/${order.id}/separation`)).body.checks;
    expect(checks.map((c: { ok: boolean }) => c.ok)).toEqual([true, false]);
  });

  it('separação de uma entrega traz só os itens dela', async () => {
    const seller = await login(app, 'vendedor.a');
    const order = (
      await seller.post('/api/orders').send({
        client_id: f.clientId,
        status: 'order',
        delivery_address: 'Rua A, 1',
        items: [
          { product_id: f.products.cimento, quantity: 20 },
          { product_id: f.products.areia, quantity: 3 },
        ],
      })
    ).body.order;
    const areia = order.items.find((i: { product_id: number }) => i.product_id === f.products.areia).id;
    const delivery = (
      await seller.post(`/api/orders/${order.id}/deliveries`).send({
        kind: 'delivery',
        status: 'scheduled',
        scheduled_date: '2026-10-20',
        items: [{ order_item_id: areia, quantity: 3 }],
      })
    ).body.delivery;
    const res = await seller.get(`/api/orders/${order.id}/separation?delivery_id=${delivery.id}`);
    expect(res.body.items).toMatchObject([{ order_item_id: areia, quantity: 3 }]);
    expect(res.body.delivery).toMatchObject({ id: delivery.id, kind: 'delivery', scheduled_date: '2026-10-20' });

    // Item de fora da entrega não entra na conferência dela.
    const cimento = order.items.find((i: { product_id: number }) => i.product_id === f.products.cimento).id;
    const wrong = await seller.post(`/api/orders/${order.id}/checks`).send({
      delivery_id: delivery.id,
      items: [{ order_item_id: cimento, counted: 1 }],
    });
    expect(wrong.status).toBe(400);

    // Orçamento não tem separação; outra loja não vê.
    const quote = (
      await seller.post('/api/orders').send({ client_id: f.clientId, status: 'quote', items: [{ product_id: f.products.areia, quantity: 1 }] })
    ).body.order;
    expect((await seller.get(`/api/orders/${quote.id}/separation`)).status).toBe(409);
    const sellerB = await login(app, 'vendedor.b');
    expect((await sellerB.get(`/api/orders/${order.id}/separation`)).status).toBe(404);
  });
});
