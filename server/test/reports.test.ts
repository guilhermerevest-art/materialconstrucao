import type pg from 'pg';
import type request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { createApp } from '../src/app.js';
import { login, resetDatabase, seedFixtures, setupApp, TEST_DATABASE_URL, type Fixtures } from './helpers.js';

const describeDb = TEST_DATABASE_URL ? describe : describe.skip;

type Agent = ReturnType<typeof request.agent>;
type Row = Record<string, unknown>;

describeDb('comissão e relatórios novos', () => {
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

  const sell = async (agent: Agent, items: { product_id: number; quantity: number }[], extra: Record<string, unknown> = {}) => {
    const res = await agent.post('/api/orders').send({ client_id: f.clientId, status: 'order', items, ...extra });
    expect(res.status).toBe(201);
    return res.body.order as { id: number; items: { id: number }[]; total_amount: number };
  };
  const report = async (agent: Agent, type: string, query: Record<string, unknown> = {}) => {
    const res = await agent.get(`/api/reports/${type}`).query(query);
    expect(res.status).toBe(200);
    return res.body as { rows: Row[]; metrics: { label: string; value: number }[] };
  };
  const metric = (body: { metrics: { label: string; value: number }[] }, label: string) => body.metrics.find((m) => m.label === label)?.value;

  it('comissão: venda confirmada menos devolução, com o percentual do vendedor ou o da loja', async () => {
    const admin = await login(app, 'admin');
    const sellerA = await login(app, 'vendedor.a');
    const sellerB = await login(app, 'vendedor.b');
    await admin.put('/api/sales-settings').send({ max_discount_percent: null, default_markup_percent: null, default_commission_percent: 2 });
    const users = (await admin.get('/api/users')).body.items as { id: number; username: string; name: string; email: string; role: string; store_id: number | null; active: boolean }[];
    const a = users.find((u) => u.username === 'vendedor.a')!;
    const saved = await admin.put(`/api/users/${a.id}`).send({ ...a, commission_percent: 3 });
    expect(saved.status).toBe(200);
    expect(saved.body.user.commission_percent).toBe(3);
    // A tela antiga (sem o campo) não apaga.
    await admin.put('/api/sales-settings').send({ max_discount_percent: 5, default_markup_percent: null });
    expect((await admin.get('/api/sales-settings')).body.settings.default_commission_percent).toBe(2);

    const order = await sell(sellerA, [{ product_id: f.products.cimento, quantity: 10 }]); // 389,00
    await sellerA.post(`/api/orders/${order.id}/deliveries`).send({ kind: 'pickup', status: 'done', items: [{ order_item_id: order.items[0]!.id, quantity: 10 }] });
    await sellerA.post(`/api/orders/${order.id}/returns`).send({ items: [{ order_item_id: order.items[0]!.id, quantity: 1 }], reason: 'Sobrou', refund_method: 'cash' });
    await sell(sellerB, [{ product_id: f.products.areia, quantity: 1 }]); // 145,00
    const cancelled = await sell(sellerB, [{ product_id: f.products.areia, quantity: 2 }]);
    await admin.post(`/api/orders/${cancelled.id}/cancel`).send({ reason: 'Desistiu' });
    await sellerA.post('/api/orders').send({ client_id: f.clientId, status: 'quote', items: [{ product_id: f.products.areia, quantity: 9 }] });

    const all = await report(admin, 'comissao');
    expect(all.rows.map((r) => [r.name, r.sales, r.returned, r.base, r.percent, r.commission])).toEqual([
      ['Vendedor A', 389, 38.9, 350.1, 3, 10.5],
      ['Vendedor B', 145, 0, 145, 2, 2.9],
    ]);
    expect(metric(all, 'Comissão')).toBe(13.4);
    // O vendedor vê só a própria.
    const own = await report(sellerB, 'comissao');
    expect(own.rows.map((r) => r.name)).toEqual(['Vendedor B']);
  });

  it('conversão de orçamentos: convertidos, perdidos e em aberto; pedido direto não conta', async () => {
    const admin = await login(app, 'admin');
    const seller = await login(app, 'vendedor.a');
    const quote = (quantity: number) =>
      seller.post('/api/orders').send({ client_id: f.clientId, status: 'quote', items: [{ product_id: f.products.areia, quantity }] }).then((r) => r.body.order);
    const won = await quote(1);
    const lost = await quote(2);
    await quote(3);
    await new Promise((resolve) => setTimeout(resolve, 20));
    await seller.post(`/api/orders/${won.id}/convert`);
    await admin.post(`/api/orders/${lost.id}/cancel`).send({ reason: 'Comprou no concorrente' });
    await sell(seller, [{ product_id: f.products.cimento, quantity: 1 }]);

    const body = await report(admin, 'conversao');
    expect(body.rows).toHaveLength(1);
    expect(body.rows[0]).toMatchObject({ name: 'Vendedor A', count: 3, converted: 1, lost: 1, open: 1, converted_amount: 145, rate: 33.3 });
    expect(metric(body, 'Taxa de conversão')).toBe(33.3);
  });

  it('estoque: curva ABC, parado e valorizado (este só do admin)', async () => {
    const admin = await login(app, 'admin');
    const seller = await login(app, 'vendedor.a');
    await admin.post('/api/stock/entries').send({
      store_id: f.storeA,
      items: [
        { product_id: f.products.cimento, quantity: 100, unit_cost: 30 },
        { product_id: f.products.tijolo, quantity: 1000, unit_cost: 0.8 },
        { product_id: f.products.areia, quantity: 10, unit_cost: 100 },
      ],
    });
    await sell(seller, [
      { product_id: f.products.cimento, quantity: 50 }, // 1.945,00
      { product_id: f.products.areia, quantity: 2 }, // 290,00
    ], { store_id: f.storeA });

    const abc = await report(admin, 'curva-abc', { store_id: f.storeA });
    expect(abc.rows.map((r) => [r.name, r.class, r.stock])).toEqual([
      ['Cimento CP II 50 kg', 'A', 50],
      ['Areia média', 'B', 8],
    ]);
    expect(abc.rows[0]).toMatchObject({ revenue: 1945, turnover: 1 });

    const stale = await report(admin, 'estoque-parado', { store_id: f.storeA, dias: 30 });
    expect(stale.rows.map((r) => [r.name, r.quantity, r.value, r.last_sale_at])).toEqual([['Tijolo cerâmico 8 furos', 1000, 800, null]]);

    expect((await seller.get('/api/reports/estoque-valorizado')).status).toBe(403);
    const value = await report(admin, 'estoque-valorizado', { store_id: f.storeA });
    expect(metric(value, 'Estoque a custo')).toBe(1500 + 800 + 800);
    expect(metric(value, 'Estoque a preço de venda')).toBe(50 * 38.9 + 1000 * 1.35 + 8 * 145);

    // Margem: custo gravado na confirmação (30 e 100).
    const margin = await report(admin, 'margem');
    expect(margin.rows.map((r) => [r.name, r.revenue, r.cost, r.margin, r.margin_percent])).toEqual([
      ['Cimento CP II 50 kg', 1945, 1500, 445, 22.9],
      ['Areia média', 290, 200, 90, 31],
    ]);
    expect(metric(margin, 'Margem bruta')).toBe(535);
  });

  it('inadimplência, fluxo de caixa, devoluções e compras', async () => {
    const admin = await login(app, 'admin');
    await admin.put('/api/finance/settings').send({ finance_enabled: true });
    await admin.put('/api/fiado/settings').send({ enabled: true, due_day: 10, block_days: 0, late_fee_percent: 0, interest_percent: 0, message: null });
    await admin.put(`/api/clients/${f.clientId}/credit`).send({ credit_limit: 5000 });
    const methods = (await admin.get('/api/payment-methods')).body.items as { id: number; kind: string }[];
    const fiado = methods.find((m) => m.kind === 'fiado')!.id;
    const cash = (await admin.post('/api/payment-methods').send({ name: 'Dinheiro', kind: 'cash' })).body.payment_method.id;
    const seller = await login(app, 'vendedor.a');

    // Parcela à vista vencida há 45 dias e uma compra no fiado vencida há 100.
    const order = await sell(seller, [{ product_id: f.products.areia, quantity: 1 }], { payment_method_id: cash });
    await adminPool.query(`update receivables set due_date = (now() at time zone 'America/Sao_Paulo')::date - 45 where order_id = $1`, [order.id]);
    const fiadoOrder = await sell(seller, [{ product_id: f.products.cimento, quantity: 2 }], { payment_method_id: fiado });
    await adminPool.query(`update fiado_entries set due_date = (now() at time zone 'America/Sao_Paulo')::date - 100 where order_id = $1`, [fiadoOrder.id]);
    const late = await report(admin, 'inadimplencia');
    expect(late.rows).toHaveLength(1);
    expect(late.rows[0]).toMatchObject({ name: 'Maria da Silva', total_amount: 222.8, d60: 145, d90plus: 77.8, fiado: 77.8, days_late: 100 });

    // Fluxo: recebe a parcela no caixa e paga uma conta.
    await seller.post('/api/cash/open').send({ opening_amount: 0 });
    const receivable = (await seller.get(`/api/orders/${order.id}/receivables`)).body.items[0];
    await seller.post(`/api/receivables/${receivable.id}/payments`).send({ amount: 145, payment_method_id: cash });
    const payable = (await admin.post('/api/payables').send({ store_id: f.storeA, description: 'Energia', installments: [{ due_date: '2099-01-10', amount: 90 }] })).body.ids[0];
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(new Date());
    await admin.post(`/api/payables/${payable}/payments`).send({ amount: 90, paid_on: today, method: 'pix' });
    const flow = await report(admin, 'fluxo-de-caixa', { from: today, to: today });
    expect(flow.rows).toEqual([expect.objectContaining({ day: today, received: 145, paid: 90, balance: 55 })]);
    expect((await seller.get('/api/reports/fluxo-de-caixa')).status).toBe(403);

    // Devoluções por produto.
    await seller.post(`/api/orders/${fiadoOrder.id}/deliveries`).send({ kind: 'pickup', status: 'done', items: [{ order_item_id: fiadoOrder.items[0]!.id, quantity: 2 }] });
    await seller.post(`/api/orders/${fiadoOrder.id}/returns`).send({ items: [{ order_item_id: fiadoOrder.items[0]!.id, quantity: 1, restock: false }], reason: 'Saco rasgado', refund_method: 'fiado' });
    const returns = await report(admin, 'devolucoes');
    expect(returns.rows[0]).toMatchObject({ name: 'Cimento CP II 50 kg', quantity: 1, damaged: 1, amount: 38.9 });
    expect(metric(returns, 'Valor devolvido')).toBe(38.9);

    // Compras por fornecedor.
    await admin.post('/api/stock/entries').send({ store_id: f.storeA, supplier_name: 'Votorantim', supplier_document: '12345678000190', items: [{ product_id: f.products.cimento, quantity: 10, unit_cost: 30 }] });
    const buys = await report(admin, 'compras');
    expect(buys.rows).toEqual([expect.objectContaining({ name: 'Votorantim', count: 1, total_amount: 300 })]);
  });
});
