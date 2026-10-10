import type pg from 'pg';
import type request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { createApp } from '../src/app.js';
import { computeAccount, purchaseDueDate } from '../src/fiado/queries.js';
import { todayIn } from '../src/lib/format.js';
import { login, resetDatabase, seedFixtures, setupApp, startFakeEvolution, TEST_DATABASE_URL, testConfig, type Fixtures } from './helpers.js';

const describeDb = TEST_DATABASE_URL ? describe : describe.skip;

type Agent = ReturnType<typeof request.agent>;

const addDays = (iso: string, days: number) => {
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};

describe('regras do fiado', () => {
  it('compra vence no dia de vencimento do mês seguinte', () => {
    expect(purchaseDueDate('2026-10-05', 10)).toBe('2026-11-10');
    expect(purchaseDueDate('2026-10-31', 10)).toBe('2026-11-10');
    expect(purchaseDueDate('2026-12-20', 5)).toBe('2027-01-05');
  });

  it('o pagamento abate as compras mais antigas e os encargos correm só no que atrasou', () => {
    const at = new Date();
    const account = computeAccount(
      [
        { id: 1, kind: 'purchase', amount: 100, due_date: '2026-09-10', created_at: at },
        { id: 2, kind: 'purchase', amount: 50, due_date: '2026-10-10', created_at: at },
        { id: 3, kind: 'payment', amount: -120, due_date: null, created_at: at },
        { id: 4, kind: 'purchase', amount: 80, due_date: '2026-11-10', created_at: at },
      ],
      '2026-10-15',
      { late_fee_percent: 2, interest_percent: 3 },
    );
    expect(account).toMatchObject({
      balance: 110,
      overdue: 30,
      oldest_overdue: '2026-10-10',
      days_late: 5,
      next_due: '2026-11-10',
      next_due_amount: 80,
      charges: 0.75, // 30 x 2% + 30 x 3%/30 x 5 dias
    });
  });

  it('depois de um pagamento, a multa não se repete e os juros correm a partir dele', () => {
    const at = new Date();
    const entries = [
      { id: 1, kind: 'purchase', amount: 100, due_date: '2026-09-10', created_at: at },
      { id: 2, kind: 'payment', amount: -40, due_date: null, created_at: at },
      { id: 3, kind: 'purchase', amount: 50, due_date: '2026-10-10', created_at: at },
    ];
    const settings = { late_fee_percent: 2, interest_percent: 3 };
    // Pagou em 01/10: os 60 restantes da 1ª compra só têm juros de 01/10 a 15/10 (14 dias);
    // a 2ª venceu depois do pagamento: multa e juros desde 10/10 (5 dias).
    const account = computeAccount(entries, '2026-10-15', settings, '2026-10-01');
    expect(account.charges).toBe(Math.round((60 * 0.001 * 14 + 50 * 0.02 + 50 * 0.001 * 5) * 100) / 100);
    // Pagou hoje: nada mais a cobrar.
    expect(computeAccount(entries, '2026-10-15', settings, '2026-10-15').charges).toBe(0);
  });
});

describeDb('fiado', () => {
  let pool: pg.Pool;
  let adminPool: pg.Pool;
  let app: ReturnType<typeof createApp>;
  let f: Fixtures;
  let evolution: Awaited<ReturnType<typeof startFakeEvolution>>;
  const tz = testConfig(TEST_DATABASE_URL ?? '').timeZone;

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

  const settings = (extra: Record<string, unknown> = {}) => ({
    enabled: true,
    due_day: 10,
    block_days: 0,
    late_fee_percent: 0,
    interest_percent: 0,
    message: null,
    ...extra,
  });

  async function enable(admin: Agent, extra: Record<string, unknown> = {}) {
    const res = await admin.put('/api/fiado/settings').send(settings(extra));
    expect(res.status).toBe(200);
    const methods = (await admin.get('/api/payment-methods')).body.items as { id: number; kind: string; name: string }[];
    const cash = (await admin.post('/api/payment-methods').send({ name: 'Dinheiro', kind: 'cash' })).body.payment_method.id as number;
    return { fiado: methods.find((m) => m.kind === 'fiado')!.id, cash };
  }

  function sell(agent: Agent, methodId: number, quantity = 10) {
    // 10 x 38,90 = 389,00
    return agent.post('/api/orders').send({
      client_id: f.clientId,
      status: 'order',
      store_id: f.storeA,
      payment_method_id: methodId,
      items: [{ product_id: f.products.cimento, quantity }],
    });
  }

  const account = async (agent: Agent) => (await agent.get(`/api/fiado/accounts/${f.clientId}`)).body;
  const setLimit = (admin: Agent, limit: number | null) => admin.put(`/api/clients/${f.clientId}/credit`).send({ credit_limit: limit });
  /** Joga o vencimento das compras para trás, como se estivessem atrasadas. */
  const overdueBy = (days: number) =>
    adminPool.query(`update fiado_entries set due_date = $1 where kind = 'purchase'`, [addDays(todayIn(tz), -days)]);

  it('desligado (padrão): nada de conta, e a venda segue normal', async () => {
    const admin = await login(app, 'admin');
    const seller = await login(app, 'vendedor.a');
    expect((await seller.get('/api/auth/me')).body.user.fiado_enabled).toBe(false);
    expect((await seller.get('/api/fiado/accounts')).status).toBe(409);
    const method = (await admin.post('/api/payment-methods').send({ name: 'Fiado', kind: 'fiado' })).body.payment_method.id;
    expect((await sell(seller, method)).status).toBe(201);
    expect((await adminPool.query('select count(*)::int as n from fiado_entries')).rows[0].n).toBe(0);
  });

  it('venda fiada precisa de limite, soma na conta e vence no mês seguinte', async () => {
    const admin = await login(app, 'admin');
    const { fiado } = await enable(admin);
    const seller = await login(app, 'vendedor.a');
    expect((await seller.get('/api/auth/me')).body.user.fiado_enabled).toBe(true);

    const noLimit = await sell(seller, fiado);
    expect(noLimit.status).toBe(409);
    expect(noLimit.body.code).toBe('FIADO_NOT_APPROVED');

    await setLimit(admin, 1000);
    const first = await sell(seller, fiado);
    expect(first.status).toBe(201);
    const data = await account(seller);
    expect(data.account).toMatchObject({ balance: 389, overdue: 0, next_due: purchaseDueDate(todayIn(tz), 10) });
    expect(data.available).toBe(611);
    expect(data.entries[0]).toMatchObject({ kind: 'purchase', amount: 389, order_id: first.body.order.id, balance_after: 389 });

    const tooMuch = await sell(seller, fiado, 20); // 778 > 611
    expect(tooMuch.status).toBe(409);
    expect(tooMuch.body.code).toBe('FIADO_LIMIT');
    // A venda recusada não entra: nada mudou.
    expect((await account(seller)).account.balance).toBe(389);

    // Fiado não vira parcela no financeiro.
    await admin.put('/api/finance/settings').send({ finance_enabled: true });
    const second = await sell(seller, fiado, 5);
    expect((await seller.get(`/api/orders/${second.body.order.id}/receivables`)).body.items).toEqual([]);
  });

  it('atraso bloqueia nova compra fiada, com tolerância configurável', async () => {
    const admin = await login(app, 'admin');
    const { fiado } = await enable(admin);
    await setLimit(admin, 5000);
    const seller = await login(app, 'vendedor.a');
    await sell(seller, fiado);
    await overdueBy(5);

    const blocked = await sell(seller, fiado);
    expect(blocked.status).toBe(409);
    expect(blocked.body.code).toBe('FIADO_OVERDUE');
    expect(blocked.body.error).toContain('há 5 dias');
    const data = await account(seller);
    expect(data).toMatchObject({ blocked: true, account: { overdue: 389, days_late: 5 } });

    await admin.put('/api/fiado/settings').send(settings({ block_days: 10 }));
    expect((await sell(seller, fiado)).status).toBe(201);
  });

  it('recebe sem o financeiro, abate e não aceita mais que a dívida', async () => {
    const admin = await login(app, 'admin');
    const { fiado, cash } = await enable(admin);
    await setLimit(admin, 1000);
    const seller = await login(app, 'vendedor.a');
    await sell(seller, fiado);

    const pay = (agent: Agent, body: Record<string, unknown>) => agent.post(`/api/fiado/accounts/${f.clientId}/payments`).send(body);
    expect((await pay(seller, { amount: 500, payment_method_id: cash })).status).toBe(409);
    expect((await pay(seller, { amount: 50, payment_method_id: fiado })).status).toBe(400);
    const res = await pay(seller, { amount: 100, payment_method_id: cash });
    expect(res.status).toBe(201);
    expect(res.body.receipt).toMatchObject({ amount: 100, charges: 0, balance: 289 });

    const data = await account(seller);
    expect(data.account.balance).toBe(289);
    const payment = data.entries.find((e: { kind: string }) => e.kind === 'payment');
    expect(payment).toMatchObject({ amount: -100, payment_method_name: 'Dinheiro', cash_session_id: null, balance_after: 289 });

    // Sem caixa, só o admin estorna.
    expect((await seller.post(`/api/fiado/entries/${payment.id}/reverse`).send({ reason: 'Engano' })).status).toBe(403);
    expect((await admin.post(`/api/fiado/entries/${payment.id}/reverse`).send({ reason: 'Engano' })).status).toBe(204);
    expect((await account(seller)).account.balance).toBe(389);
  });

  it('encargos por atraso entram no recebimento; o admin pode dispensar', async () => {
    const admin = await login(app, 'admin');
    const { fiado, cash } = await enable(admin, { late_fee_percent: 2, interest_percent: 3, block_days: 30 });
    await setLimit(admin, 1000);
    const seller = await login(app, 'vendedor.a');
    await sell(seller, fiado);
    await overdueBy(10);

    const data = await account(seller);
    expect(data.account.charges).toBe(11.67); // 389 x 2% + 389 x 0,1% x 10 = 7,78 + 3,89

    expect((await seller.post(`/api/fiado/accounts/${f.clientId}/payments`).send({ amount: 100, payment_method_id: cash, waive_charges: true })).status).toBe(403);
    const res = await seller.post(`/api/fiado/accounts/${f.clientId}/payments`).send({ amount: 100, payment_method_id: cash });
    expect(res.body.receipt).toMatchObject({ charges: 11.67, balance: 300.67 });
    const after = await account(seller);
    expect(after.account.balance).toBe(300.67);
    // O atraso até hoje já foi acertado: um segundo pagamento hoje não cobra de novo.
    expect(after.account.charges).toBe(0);
    expect(after.entries.map((e: { kind: string }) => e.kind)).toEqual(['purchase', 'payment', 'charge']);

    // Estornar o recebimento leva os encargos dele junto.
    const paymentId = after.entries.find((e: { kind: string }) => e.kind === 'payment').id;
    await admin.post(`/api/fiado/entries/${paymentId}/reverse`).send({ reason: 'Cheque voltou' });
    expect((await account(seller)).account.balance).toBe(389);

    const waived = await admin.post(`/api/fiado/accounts/${f.clientId}/payments`).send({ amount: 389, payment_method_id: cash, waive_charges: true });
    expect(waived.body.receipt).toMatchObject({ charges: 0, balance: 0 });
  });

  it('com o financeiro ligado, o recebimento passa pelo caixa', async () => {
    const admin = await login(app, 'admin');
    const { fiado, cash } = await enable(admin);
    await admin.put('/api/finance/settings').send({ finance_enabled: true });
    await setLimit(admin, 1000);
    const seller = await login(app, 'vendedor.a');
    await sell(seller, fiado);

    const closed = await seller.post(`/api/fiado/accounts/${f.clientId}/payments`).send({ amount: 50, payment_method_id: cash });
    expect(closed.status).toBe(409);
    expect(closed.body.code).toBe('CASH_CLOSED');

    await seller.post('/api/cash/open').send({ opening_amount: 100 });
    expect((await seller.post(`/api/fiado/accounts/${f.clientId}/payments`).send({ amount: 50, payment_method_id: cash })).status).toBe(201);
    const current = (await seller.get('/api/cash/current')).body.current;
    expect(current.summary).toMatchObject({ received: 50, expected_cash: 150 });
    expect(current.payments[0]).toMatchObject({ source: 'fiado', amount: 50, client_name: 'Maria da Silva' });

    // O operador estorna enquanto o caixa está aberto.
    expect((await seller.post(`/api/fiado/entries/${current.payments[0].id}/reverse`).send({ reason: 'Engano' })).status).toBe(204);
    expect((await seller.get('/api/cash/current')).body.current.summary.expected_cash).toBe(100);
  });

  it('cancelar o pedido tira a compra da conta; o que já foi pago vira crédito', async () => {
    const admin = await login(app, 'admin');
    const { fiado, cash } = await enable(admin);
    await setLimit(admin, 1000);
    const seller = await login(app, 'vendedor.a');
    const order = (await sell(seller, fiado)).body.order;
    await seller.post(`/api/fiado/accounts/${f.clientId}/payments`).send({ amount: 100, payment_method_id: cash });
    expect((await admin.post(`/api/orders/${order.id}/cancel`).send({ reason: 'Cliente desistiu' })).status).toBe(200);
    const data = await account(seller);
    expect(data.account.balance).toBe(-100);
    expect(data.entries[0]).toMatchObject({ kind: 'purchase', balance_after: null });
    expect(data.entries[0].cancel_reason).toContain('Cliente desistiu');
  });

  it('ajuste do admin, dia de vencimento do cliente, lista, extrato e cobrança', async () => {
    const admin = await login(app, 'admin');
    const { fiado } = await enable(admin);
    await setLimit(admin, 5000);
    const seller = await login(app, 'vendedor.a');

    expect((await seller.post(`/api/fiado/accounts/${f.clientId}/adjustments`).send({ amount: 200, description: 'Saldo da caderneta antiga' })).status).toBe(403);
    expect((await admin.post(`/api/fiado/accounts/${f.clientId}/adjustments`).send({ amount: 200, description: 'Saldo da caderneta antiga' })).status).toBe(201);
    expect((await admin.put(`/api/fiado/accounts/${f.clientId}/due-day`).send({ due_day: 20 })).status).toBe(204);
    await sell(seller, fiado);
    const data = await account(seller);
    expect(data.due_day).toBe(20);
    expect(data.account.balance).toBe(589);
    expect(data.entries[1].due_date).toBe(purchaseDueDate(todayIn(tz), 20));

    // O ajuste vence hoje; amanhã, está atrasado.
    await adminPool.query(`update fiado_entries set due_date = $1 where kind = 'adjustment'`, [addDays(todayIn(tz), -3)]);
    const list = await seller.get('/api/fiado/accounts?status=overdue');
    expect(list.status).toBe(200);
    expect(list.body.items).toHaveLength(1);
    expect(list.body.items[0]).toMatchObject({ client_name: 'Maria da Silva', balance: 589, overdue: 200, days_late: 3 });
    expect(list.body.totals).toMatchObject({ balance: 589, overdue: 200, overdue_clients: 1 });

    const pdf = await seller.get(`/api/fiado/accounts/${f.clientId}/pdf`);
    expect(pdf.status).toBe(200);
    expect(pdf.headers['content-type']).toBe('application/pdf');

    expect((await seller.post(`/api/fiado/accounts/${f.clientId}/whatsapp`).send({})).status).toBe(422);
    await admin.put('/api/settings').send({ evolution_api_url: evolution.url, evolution_instance: 'loja', evolution_api_token: 'token-1234' });
    const sent = await seller.post(`/api/fiado/accounts/${f.clientId}/whatsapp`).send({ with_pdf: true });
    expect(sent.status).toBe(200);
    const caption = evolution.requests[0]!.body.caption as string;
    expect(caption).toMatch(/^Olá, Maria! Aqui é da Loja A\. Seu fiado está com saldo de R\$\s589,00, com R\$\s200,00 vencido desde/);
    expect(evolution.requests[0]!.body.fileName).toBe(`extrato-fiado-${f.clientId}.pdf`);
  });

  it('o limite vale para fiado e crediário juntos', async () => {
    const admin = await login(app, 'admin');
    const { fiado } = await enable(admin);
    await admin.put('/api/finance/settings').send({ finance_enabled: true });
    const credit = (await admin.post('/api/payment-methods').send({ name: 'Crediário 3x', kind: 'store_credit', installments: 3, first_due_days: 30, interval_days: 30 })).body.payment_method.id;
    await setLimit(admin, 1000);
    const seller = await login(app, 'vendedor.a');
    expect((await sell(seller, fiado)).status).toBe(201); // fiado 389
    const res = await sell(seller, credit, 20); // crediário 778 > 611
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('CREDIT_LIMIT');
    expect(res.body.error).toContain('em aberto R$');
    expect((await sell(seller, credit, 5)).status).toBe(201); // 194,50
    const fiadoAgain = await sell(seller, fiado, 12); // 466,80 > 1000 - 389 - 194,50
    expect(fiadoAgain.body.code).toBe('FIADO_LIMIT');
  });
});
