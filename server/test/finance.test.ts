import type pg from 'pg';
import type request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { createApp } from '../src/app.js';
import { todayIn } from '../src/lib/format.js';
import { login, resetDatabase, seedFixtures, setupApp, TEST_DATABASE_URL, type Fixtures } from './helpers.js';

const describeDb = TEST_DATABASE_URL ? describe : describe.skip;

type Agent = ReturnType<typeof request.agent>;
type Receivable = { id: number; installment: number; due_date: string; amount: number; paid_amount: number; remaining: number; status: string };

const addDays = (iso: string, days: number) => {
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};

describeDb('financeiro', () => {
  let pool: pg.Pool;
  let adminPool: pg.Pool;
  let app: ReturnType<typeof createApp>;
  let f: Fixtures;
  let methods: { cash: number; pix: number; credit: number; boleto: number };

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
    const admin = await login(app, 'admin');
    const create = async (body: Record<string, unknown>) => (await admin.post('/api/payment-methods').send(body)).body.payment_method.id as number;
    methods = {
      cash: await create({ name: 'Dinheiro', kind: 'cash' }),
      pix: await create({ name: 'PIX', kind: 'pix' }),
      credit: await create({ name: 'Crediário 3x', kind: 'store_credit', installments: 3, first_due_days: 30, interval_days: 30 }),
      boleto: await create({ name: 'Boleto 30/60', kind: 'boleto', installments: 2, first_due_days: 30, interval_days: 30 }),
    };
  });

  async function enable(admin: Agent, extra: Record<string, unknown> = {}) {
    const res = await admin.put('/api/finance/settings').send({ finance_enabled: true, ...extra });
    expect(res.status).toBe(200);
  }

  function sell(agent: Agent, paymentMethodId: number | null, quantity = 10, extra: Record<string, unknown> = {}) {
    // 10 x 38,90 = 389,00
    return agent.post('/api/orders').send({
      client_id: f.clientId,
      status: 'order',
      store_id: f.storeA,
      payment_method_id: paymentMethodId,
      items: [{ product_id: f.products.cimento, quantity }],
      ...extra,
    });
  }

  async function receivables(agent: Agent, orderId: number) {
    return (await agent.get(`/api/orders/${orderId}/receivables`)).body.items as Receivable[];
  }

  it('desligado (padrão): nada de parcela, crediário não trava e o caixa não abre', async () => {
    const seller = await login(app, 'vendedor.a');
    expect((await seller.get('/api/auth/me')).body.user.finance_enabled).toBe(false);
    const order = await sell(seller, methods.credit);
    expect(order.status).toBe(201);
    expect(await receivables(seller, order.body.order.id)).toEqual([]);
    const open = await seller.post('/api/cash/open').send({ opening_amount: 100 });
    expect(open.status).toBe(409);
    expect(open.body.code).toBe('FINANCE_DISABLED');
  });

  it('gera as parcelas pela condição da forma de pagamento', async () => {
    const admin = await login(app, 'admin');
    await enable(admin);
    const today = todayIn('America/Sao_Paulo');

    const cash = await sell(admin, methods.cash);
    expect(await receivables(admin, cash.body.order.id)).toMatchObject([
      { installment: 1, due_date: today, amount: 389, paid_amount: 0, status: 'open' },
    ]);
    // Sem forma de pagamento: uma parcela no dia.
    const none = await sell(admin, null);
    expect(await receivables(admin, none.body.order.id)).toMatchObject([{ due_date: today, amount: 389 }]);

    // 389,00 em 2: a diferença de centavo vai na primeira.
    const boleto = await sell(admin, methods.boleto);
    expect(await receivables(admin, boleto.body.order.id)).toMatchObject([
      { installment: 1, due_date: addDays(today, 30), amount: 194.5 },
      { installment: 2, due_date: addDays(today, 60), amount: 194.5 },
    ]);
    const odd = await sell(admin, methods.boleto, 10, { items: [{ product_id: f.products.tijolo, quantity: 1 }] });
    expect((await receivables(admin, odd.body.order.id)).map((r) => r.amount)).toEqual([0.68, 0.67]);

    // Orçamento não gera; vira parcela quando é convertido.
    const quote = await sell(admin, methods.cash, 1, { status: 'quote' });
    expect(await receivables(admin, quote.body.order.id)).toEqual([]);
    await admin.post(`/api/orders/${quote.body.order.id}/convert`);
    expect(await receivables(admin, quote.body.order.id)).toHaveLength(1);
  });

  it('crediário: precisa de limite, respeita o disponível e trava com parcela vencida', async () => {
    const admin = await login(app, 'admin');
    await enable(admin);
    const seller = await login(app, 'vendedor.a');

    const notApproved = await sell(seller, methods.credit);
    expect(notApproved.status).toBe(409);
    expect(notApproved.body.code).toBe('CREDIT_NOT_APPROVED');
    // Nada foi salvo: o pedido inteiro voltou.
    expect((await seller.get('/api/orders')).body.total).toBe(0);

    await admin.put(`/api/clients/${f.clientId}/credit`).send({ credit_limit: 1000 });
    const first = await sell(seller, methods.credit, 20); // 778,00
    expect(first.status).toBe(201);
    expect((await receivables(seller, first.body.order.id)).map((r) => r.amount)).toEqual([259.34, 259.33, 259.33]);

    const over = await sell(seller, methods.credit, 10); // 389,00 > 222,00 disponível
    expect(over.status).toBe(409);
    expect(over.body.code).toBe('CREDIT_LIMIT');
    expect(over.body.error).toMatch(/disponível R\$\s222,00/);

    const credit = (await seller.get(`/api/clients/${f.clientId}/credit`)).body.credit;
    expect(credit).toMatchObject({ credit_limit: 1000, open_balance: 778, available: 222, overdue_amount: 0 });

    await adminPool.query(`update receivables set due_date = current_date - 3 where installment = 1`);
    const overdue = await sell(seller, methods.credit, 1);
    expect(overdue.status).toBe(409);
    expect(overdue.body.code).toBe('CREDIT_OVERDUE');
    // À vista continua vendendo normalmente.
    expect((await sell(seller, methods.cash, 1)).status).toBe(201);
  });

  it('caixa: recebe em partes e formas diferentes, sangria e fechamento com diferença', async () => {
    const admin = await login(app, 'admin');
    await enable(admin);
    const seller = await login(app, 'vendedor.a');
    const order = await sell(seller, methods.cash);
    const [parcel] = await receivables(seller, order.body.order.id);

    const closed = await seller.post(`/api/receivables/${parcel!.id}/payments`).send({ amount: 10, payment_method_id: methods.cash });
    expect(closed.body.code).toBe('CASH_CLOSED');

    expect((await seller.post('/api/cash/open').send({ opening_amount: 100 })).status).toBe(201);
    expect((await seller.post('/api/cash/open').send({ opening_amount: 100 })).status).toBe(409);

    const part = await seller.post(`/api/receivables/${parcel!.id}/payments`).send({ amount: 50, payment_method_id: methods.cash });
    expect(part.body.receivable).toMatchObject({ paid_amount: 50, remaining: 339, status: 'open' });
    const tooMuch = await seller.post(`/api/receivables/${parcel!.id}/payments`).send({ amount: 400, payment_method_id: methods.pix });
    expect(tooMuch.status).toBe(409);
    const asCredit = await seller.post(`/api/receivables/${parcel!.id}/payments`).send({ amount: 10, payment_method_id: methods.credit });
    expect(asCredit.status).toBe(400);
    const rest = await seller.post(`/api/receivables/${parcel!.id}/payments`).send({ amount: 339, payment_method_id: methods.pix });
    expect(rest.body.receivable).toMatchObject({ remaining: 0, status: 'paid' });

    expect((await seller.post('/api/cash/movements').send({ kind: 'withdrawal', amount: 200, reason: 'Depósito no banco' })).status).toBe(409);
    await seller.post('/api/cash/movements').send({ kind: 'withdrawal', amount: 100, reason: 'Depósito no banco' });
    const current = (await seller.get('/api/cash/current')).body.current;
    expect(current.summary).toMatchObject({ received: 389, withdrawals: 100, deposits: 0, expected_cash: 50 });
    expect(current.summary.methods).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ method_name: 'PIX', amount: 339 }),
        expect.objectContaining({ method_name: 'Dinheiro', amount: 50 }),
      ]),
    );

    const close = await seller.post('/api/cash/close').send({ counted_amount: 45, notes: 'Faltou troco' });
    expect(close.body.closed.summary).toMatchObject({ expected_cash: 50, difference: -5 });
    expect((await seller.get('/api/cash/current')).body.current).toBeNull();

    // Recebimento de caixa fechado não é estornado.
    const payments = (await seller.get(`/api/orders/${order.body.order.id}/receivables`)).body.payments;
    const reversed = await seller.post(`/api/receivable-payments/${payments[0].id}/reverse`).send({ reason: 'Engano' });
    expect(reversed.status).toBe(409);

    const history = await admin.get('/api/cash/sessions');
    expect(history.body.items[0]).toMatchObject({ user_name: 'Vendedor A', counted_amount: 45, summary: { difference: -5 } });
  });

  it('cancelar pedido: bloqueado com recebimento; depois do estorno, cancela as parcelas', async () => {
    const admin = await login(app, 'admin');
    await enable(admin);
    const order = await sell(admin, methods.boleto);
    const [first] = await receivables(admin, order.body.order.id);
    await admin.post('/api/cash/open').send({ store_id: f.storeA, opening_amount: 0 });
    await admin.post(`/api/receivables/${first!.id}/payments`).send({ amount: 100, payment_method_id: methods.pix });

    const blocked = await admin.post(`/api/orders/${order.body.order.id}/cancel`).send({ reason: 'Cliente desistiu' });
    expect(blocked.status).toBe(409);
    expect(blocked.body.error).toContain('Estorne');

    const payment = (await admin.get(`/api/orders/${order.body.order.id}/receivables`)).body.payments[0];
    expect((await admin.post(`/api/receivable-payments/${payment.id}/reverse`).send({ reason: 'Devolvido ao cliente' })).status).toBe(204);
    expect((await receivables(admin, order.body.order.id))[0]).toMatchObject({ paid_amount: 0, status: 'open' });

    expect((await admin.post(`/api/orders/${order.body.order.id}/cancel`).send({ reason: 'Cliente desistiu' })).status).toBe(200);
    expect((await receivables(admin, order.body.order.id)).map((r) => r.status)).toEqual(['cancelled', 'cancelled']);
  });

  it('contas a receber: vencidas, filtro por loja e PIX da parcela', async () => {
    const admin = await login(app, 'admin');
    await enable(admin);
    const a = await sell(admin, methods.cash);
    const b = await sell(admin, methods.cash, 1, { store_id: f.storeB });
    await adminPool.query('update receivables set due_date = current_date - 2 where order_id = $1', [a.body.order.id]);

    const overdue = await admin.get('/api/receivables?status=overdue');
    expect(overdue.body.items.map((r: { order_id: number; overdue: boolean }) => [r.order_id, r.overdue])).toEqual([[a.body.order.id, true]]);
    expect(overdue.body.totals).toMatchObject({ remaining: 389, overdue: 389 });

    const sellerB = await login(app, 'vendedor.b');
    const fromB = await sellerB.get(`/api/receivables?store_id=${f.storeA}`);
    expect(fromB.body.items.map((r: { order_id: number }) => r.order_id)).toEqual([b.body.order.id]);

    const [parcel] = await receivables(admin, a.body.order.id);
    expect((await admin.get(`/api/receivables/${parcel!.id}/pix`)).body.code).toBe('PIX_NOT_CONFIGURED');
    const bad = await admin.put('/api/finance/settings').send({ finance_enabled: true, pix_key: 'xyz', pix_merchant_name: 'Loja', pix_city: 'SP' });
    expect(bad.status).toBe(400);
    await enable(admin, { pix_key: '12.345.678/0001-99', pix_merchant_name: 'Loja Teste', pix_city: 'São Paulo' });
    const pix = await admin.get(`/api/receivables/${parcel!.id}/pix`);
    expect(pix.body.amount).toBe(389);
    expect(pix.body.payload).toContain('0114123456780001995204000053039865406389.00');
    expect(pix.body.qr).toMatch(/^data:image\/png;base64,/);

    // Pedido no PIX sai com o QR Code no PDF.
    const pixOrder = await sell(admin, methods.pix, 1);
    const pdf = await admin.get(`/api/orders/${pixOrder.body.order.id}/pdf`);
    const plain = await admin.get(`/api/orders/${a.body.order.id}/pdf`);
    expect(pdf.status).toBe(200);
    expect(pdf.body.length).toBeGreaterThan(plain.body.length + 500);
  });
});
