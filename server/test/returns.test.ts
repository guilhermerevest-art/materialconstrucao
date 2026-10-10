import type pg from 'pg';
import type request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { createApp } from '../src/app.js';
import { login, resetDatabase, seedFixtures, setupApp, TEST_DATABASE_URL, type Fixtures } from './helpers.js';

const describeDb = TEST_DATABASE_URL ? describe : describe.skip;

type Agent = ReturnType<typeof request.agent>;

describeDb('devolução e troca', () => {
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

  /** Pedido confirmado de 10 sacos de cimento (389,00), já retirado pelo cliente. */
  async function soldAndTaken(agent: Agent, extra: Record<string, unknown> = {}, take = 10) {
    const res = await agent.post('/api/orders').send({
      client_id: f.clientId,
      status: 'order',
      store_id: f.storeA,
      items: [{ product_id: f.products.cimento, quantity: 10 }],
      ...extra,
    });
    expect(res.status).toBe(201);
    const order = res.body.order;
    if (take > 0) {
      const pickup = await agent
        .post(`/api/orders/${order.id}/deliveries`)
        .send({ kind: 'pickup', status: 'done', items: [{ order_item_id: order.items[0]!.id, quantity: take }] });
      expect(pickup.status).toBe(201);
    }
    return order as { id: number; items: { id: number }[]; total_amount: number };
  }

  const stockOf = async () =>
    Number((await adminPool.query('select quantity from stock_balances where product_id = $1 and store_id = $2', [f.products.cimento, f.storeA])).rows[0]?.quantity ?? 0);
  const giveBack = (agent: Agent, orderId: number, items: { order_item_id: number; quantity: number; restock?: boolean }[], refund_method: string, reason = 'Sobrou na obra') =>
    agent.post(`/api/orders/${orderId}/returns`).send({ items, reason, refund_method });

  it('devolve parte do que o cliente levou: estoque volta e o saldo para devolver diminui', async () => {
    const seller = await login(app, 'vendedor.a');
    const order = await soldAndTaken(seller, {}, 6);
    expect(await stockOf()).toBe(-10);

    const tooMuch = await giveBack(seller, order.id, [{ order_item_id: order.items[0]!.id, quantity: 7 }], 'cash');
    expect(tooMuch.status).toBe(409);
    expect(tooMuch.body.error).toContain('até 6');

    const res = await giveBack(seller, order.id, [{ order_item_id: order.items[0]!.id, quantity: 3 }], 'cash');
    expect(res.status).toBe(201);
    expect(res.body.return.amount).toBe(116.7);
    expect(await stockOf()).toBe(-7);

    // Avariado não volta para a prateleira.
    await giveBack(seller, order.id, [{ order_item_id: order.items[0]!.id, quantity: 1, restock: false }], 'none', 'Saco rasgado');
    expect(await stockOf()).toBe(-7);

    const view = (await seller.get(`/api/orders/${order.id}/returns`)).body;
    expect(view.items[0]).toMatchObject({ sold: 10, taken: 6, returned: 4, returnable: 2 });
    expect(view.returns).toHaveLength(2);
    expect(view.returns[1]).toMatchObject({ refund_method: 'cash', amount: 116.7, user_name: 'Vendedor A' });

    // Pedido com devolução não é cancelado (o resto também se devolve).
    const admin = await login(app, 'admin');
    expect((await admin.post(`/api/orders/${order.id}/cancel`).send({ reason: 'Desistiu' })).status).toBe(409);
  });

  it('o valor considera o desconto do pedido', async () => {
    const seller = await login(app, 'vendedor.a');
    const order = await soldAndTaken(seller, { discount_type: 'percent', discount_value: 10 });
    const res = await giveBack(seller, order.id, [{ order_item_id: order.items[0]!.id, quantity: 2 }], 'pix');
    expect(res.body.return.amount).toBe(70.02); // 2 x 35,01
  });

  it('troca: o valor vira crédito do cliente e é usado no pedido seguinte', async () => {
    const admin = await login(app, 'admin');
    const seller = await login(app, 'vendedor.a');
    const order = await soldAndTaken(seller);
    expect((await giveBack(seller, order.id, [{ order_item_id: order.items[0]!.id, quantity: 3 }], 'credit', 'Troca por areia')).status).toBe(201);
    expect((await seller.get(`/api/clients/${f.clientId}/credits`)).body.balance).toBe(116.7);

    const sale = (extra: Record<string, unknown>) =>
      seller.post('/api/orders').send({ client_id: f.clientId, store_id: f.storeA, items: [{ product_id: f.products.areia, quantity: 1 }], ...extra });
    expect((await sale({ status: 'order', credit_used: 200 })).status).toBe(400); // passa do total (145)
    const tooMuch = await sale({ status: 'order', credit_used: 120 });
    expect(tooMuch.status).toBe(409);
    expect(tooMuch.body.code).toBe('CREDIT_BALANCE');

    // Orçamento guarda o crédito sem gastar; a confirmação gasta.
    const quote = await sale({ status: 'quote', credit_used: 100 });
    expect(quote.body.order.credit_used).toBe(100);
    expect((await seller.get(`/api/clients/${f.clientId}/credits`)).body.balance).toBe(116.7);
    const confirmed = await seller.post(`/api/orders/${quote.body.order.id}/convert`);
    expect(confirmed.status).toBe(200);
    expect((await seller.get(`/api/clients/${f.clientId}/credits`)).body.balance).toBe(16.7);

    // Com o financeiro, a parcela é só do que falta (145 - 100).
    await admin.put('/api/finance/settings').send({ finance_enabled: true });
    const another = await sale({ status: 'order', credit_used: 16.7 });
    expect((await seller.get(`/api/orders/${another.body.order.id}/receivables`)).body.items[0].amount).toBe(128.3);

    // Cancelar devolve o crédito usado.
    expect((await admin.post(`/api/orders/${quote.body.order.id}/cancel`).send({ reason: 'Engano' })).status).toBe(200);
    expect((await seller.get(`/api/clients/${f.clientId}/credits`)).body.balance).toBe(100);
  });

  it('dinheiro com o financeiro ligado sai do caixa aberto', async () => {
    const admin = await login(app, 'admin');
    await admin.put('/api/finance/settings').send({ finance_enabled: true });
    const seller = await login(app, 'vendedor.a');
    const order = await soldAndTaken(seller);
    const closed = await giveBack(seller, order.id, [{ order_item_id: order.items[0]!.id, quantity: 1 }], 'cash');
    expect(closed.status).toBe(409);
    expect(closed.body.code).toBe('CASH_CLOSED');

    await seller.post('/api/cash/open').send({ opening_amount: 200 });
    expect((await giveBack(seller, order.id, [{ order_item_id: order.items[0]!.id, quantity: 1 }], 'cash')).status).toBe(201);
    const current = (await seller.get('/api/cash/current')).body.current;
    expect(current.summary).toMatchObject({ refunds: 38.9, expected_cash: 161.1 });
    expect(current.movements[0]).toMatchObject({ kind: 'refund', amount: 38.9 });
  });

  it('abate no fiado e nas parcelas do pedido', async () => {
    const admin = await login(app, 'admin');
    await admin.put('/api/fiado/settings').send({ enabled: true, due_day: 10, block_days: 0, late_fee_percent: 0, interest_percent: 0, message: null });
    await admin.put('/api/finance/settings').send({ finance_enabled: true });
    await admin.put(`/api/clients/${f.clientId}/credit`).send({ credit_limit: 5000 });
    const methods = (await admin.get('/api/payment-methods')).body.items as { id: number; kind: string }[];
    const fiado = methods.find((m) => m.kind === 'fiado')!.id;
    const credit = (await admin.post('/api/payment-methods').send({ name: 'Crediário 3x', kind: 'store_credit', installments: 3, first_due_days: 30, interval_days: 30 })).body.payment_method.id;
    const seller = await login(app, 'vendedor.a');

    const fiadoOrder = await soldAndTaken(seller, { payment_method_id: fiado });
    expect((await giveBack(seller, fiadoOrder.id, [{ order_item_id: fiadoOrder.items[0]!.id, quantity: 2 }], 'fiado')).status).toBe(201);
    expect((await seller.get(`/api/fiado/accounts/${f.clientId}`)).body.account.balance).toBe(311.2);

    const creditOrder = await soldAndTaken(seller, { payment_method_id: credit });
    // 389,00 em 3x: 129,68 + 129,66 + 129,66. Devolver 4 sacos (155,60) zera a última e abate da penúltima.
    expect((await giveBack(seller, creditOrder.id, [{ order_item_id: creditOrder.items[0]!.id, quantity: 4 }], 'receivables')).status).toBe(201);
    const receivables = (await seller.get(`/api/orders/${creditOrder.id}/receivables`)).body.items as { installment: number; amount: number; status: string }[];
    expect(receivables.map((r) => [r.installment, r.amount, r.status])).toEqual([
      [1, 129.68, 'open'],
      [2, 103.72, 'open'],
      [3, 129.66, 'cancelled'],
    ]);
    // O resto (6 sacos = 233,40) é exatamente o que falta: tudo some.
    expect((await giveBack(seller, creditOrder.id, [{ order_item_id: creditOrder.items[0]!.id, quantity: 6 }], 'receivables')).status).toBe(201);
    const after = (await seller.get(`/api/orders/${creditOrder.id}/receivables`)).body.items as { status: string }[];
    expect(after.map((r) => r.status)).toEqual(['cancelled', 'cancelled', 'cancelled']);

    // Com parcela já paga, não dá para abater mais do que está em aberto.
    const paidOrder = await soldAndTaken(seller, { payment_method_id: credit });
    const cash = (await admin.post('/api/payment-methods').send({ name: 'Dinheiro', kind: 'cash' })).body.payment_method.id;
    await seller.post('/api/cash/open').send({ opening_amount: 0 });
    const first = ((await seller.get(`/api/orders/${paidOrder.id}/receivables`)).body.items as { id: number }[])[0]!;
    await seller.post(`/api/receivables/${first.id}/payments`).send({ amount: 129.68, payment_method_id: cash });
    const tooMuch = await giveBack(seller, paidOrder.id, [{ order_item_id: paidOrder.items[0]!.id, quantity: 10 }], 'receivables');
    expect(tooMuch.status).toBe(409);
    expect(tooMuch.body.error).toContain('259,32');
  });
});
