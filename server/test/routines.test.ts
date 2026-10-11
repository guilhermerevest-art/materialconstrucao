import type pg from 'pg';
import type request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { createApp } from '../src/app.js';
import { login, resetDatabase, seedFixtures, setupApp, TEST_DATABASE_URL, type Fixtures } from './helpers.js';

const describeDb = TEST_DATABASE_URL ? describe : describe.skip;

type Agent = ReturnType<typeof request.agent>;

const EVERY_DAY = [0, 1, 2, 3, 4, 5, 6];

describeDb('rotinas e contagem cega', () => {
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

  const enable = (admin: Agent, count_items = 20) => admin.put('/api/routines/settings').send({ enabled: true, count_items });

  it('desligado por padrão; ligar cria os modelos prontos (só o admin)', async () => {
    const admin = await login(app, 'admin');
    const seller = await login(app, 'vendedor.a');
    expect((await seller.get('/api/routines/today')).body.code).toBe('ROUTINES_DISABLED');
    expect((await seller.put('/api/routines/settings').send({ enabled: true, count_items: 20 })).status).toBe(403);
    expect((await enable(admin)).body.settings).toEqual({ enabled: true, count_items: 20 });
    // Desligar e ligar de novo não duplica os modelos.
    await admin.put('/api/routines/settings').send({ enabled: false, count_items: 20 });
    await enable(admin);
    const templates = (await admin.get('/api/routines/templates')).body.items as { name: string; kind: string; items: { action: string | null }[] }[];
    expect(templates.map((t) => t.name)).toEqual(['Abertura da loja', 'Fechamento da loja', 'Recebimento de mercadoria', 'Contagem de estoque']);
    expect(templates[0]!.items.some((i) => i.action === 'cash_open')).toBe(true);
    expect((await login(app, 'vendedor.a').then((a) => a.get('/api/auth/me'))).body.user.routines_enabled).toBe(true);
  });

  it('checklist: itens obrigatórios, caixa conferido pelo sistema, atraso e uma por dia', async () => {
    const admin = await login(app, 'admin');
    await enable(admin);
    const created = await admin.post('/api/routines/templates').send({
      name: 'Abertura (teste)',
      frequency: 'weekly',
      weekdays: EVERY_DAY,
      due_time: '00:00',
      items: [
        { label: 'Alarme desligado', kind: 'check', required: true },
        { label: 'Caixa aberto', kind: 'check', required: true, action: 'cash_open' },
        { label: 'Dinheiro na gaveta', kind: 'number', required: true },
        { label: 'Foto da fachada', kind: 'photo', required: false },
      ],
    });
    expect(created.status).toBe(201);
    const templateId = created.body.template.id;
    expect((await admin.post('/api/routines/templates').send({ name: 'Sem itens', frequency: 'weekly', weekdays: [1] })).status).toBe(400);

    const seller = await login(app, 'vendedor.a');
    const today = (await seller.get('/api/routines/today')).body;
    const row = today.items.find((i: { template_id: number }) => i.template_id === templateId);
    expect(row).toMatchObject({ store_id: f.storeA, due_today: true, status: 'overdue' });

    const started = await seller.post('/api/routines/runs').send({ template_id: templateId });
    expect(started.status).toBe(201);
    const runId = started.body.run.id;
    // Começar de novo no mesmo dia abre a mesma.
    const again = await seller.post('/api/routines/runs').send({ template_id: templateId });
    expect(again.status).toBe(200);
    expect(again.body.run.id).toBe(runId);

    let run = (await seller.get(`/api/routines/runs/${runId}`)).body.run;
    expect(run.items).toHaveLength(4);
    const [alarm, cash, money, photo] = run.items as { id: number }[];
    // Vendedor da outra loja não vê.
    expect((await (await login(app, 'vendedor.b')).get(`/api/routines/runs/${runId}`)).status).toBe(404);

    const finish = () => seller.post(`/api/routines/runs/${runId}/finish`).send({});
    let res = await finish();
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('ROUTINE_INCOMPLETE');

    await seller.put(`/api/routines/runs/${runId}/items/${alarm!.id}`).send({ checked: true });
    await seller.put(`/api/routines/runs/${runId}/items/${money!.id}`).send({ value_number: 150 });
    expect((await seller.put(`/api/routines/runs/${runId}/items/${photo!.id}`).send({ photo: 'data:text/plain;base64,AAAA' })).status).toBe(400);

    // Com o financeiro ligado, o "caixa aberto" é conferido pelo sistema, não pelo clique.
    await admin.put('/api/finance/settings').send({ finance_enabled: true });
    await seller.put(`/api/routines/runs/${runId}/items/${cash!.id}`).send({ checked: true });
    res = await finish();
    expect(res.status).toBe(409);
    expect(res.body.error).toContain('nenhum caixa foi aberto hoje');
    await seller.post('/api/cash/open').send({ opening_amount: 150 });
    run = (await seller.get(`/api/routines/runs/${runId}`)).body.run;
    expect(run.items[1].satisfied).toBe(true);

    res = await finish();
    expect(res.status).toBe(200);
    expect(res.body.run).toMatchObject({ status: 'done', late: true });
    expect((await seller.put(`/api/routines/runs/${runId}/items/${alarm!.id}`).send({ checked: false })).status).toBe(409);
    expect((await seller.get('/api/routines/today')).body.items.find((i: { template_id: number }) => i.template_id === templateId).status).toBe('done');

    // Histórico: vencia hoje e foi feita (com atraso).
    const day = (await seller.get('/api/routines/today')).body.today;
    const history = (await admin.get(`/api/routines/history?from=${day}&to=${day}`)).body.rows as { template_id: number; store_id: number }[];
    expect(history.find((h) => h.template_id === templateId && h.store_id === f.storeA)).toMatchObject({ due: 1, done: 1, late: 1, missed: [] });
    expect(history.find((h) => h.template_id === templateId && h.store_id === f.storeB)).toMatchObject({ due: 1, done: 0, missed: [] });
  });

  it('contagem cega: quem conta não vê o saldo; o ajuste aprovado é pela diferença', async () => {
    const admin = await login(app, 'admin');
    await enable(admin, 5);
    await admin.post('/api/stock/adjustments').send({
      store_id: f.storeA,
      items: [
        { product_id: f.products.cimento, mode: 'count', quantity: 100 },
        { product_id: f.products.tijolo, mode: 'count', quantity: 1000 },
        { product_id: f.products.areia, mode: 'count', quantity: 20 },
      ],
    });
    await adminPool.query('update products set cost_price = 30 where id = $1', [f.products.cimento]);
    const seller = await login(app, 'vendedor.a');
    // Vendido e ainda não entregue continua na prateleira: entra no esperado.
    await seller.post('/api/orders').send({ client_id: f.clientId, status: 'order', items: [{ product_id: f.products.cimento, quantity: 10 }] });

    // A rotina da contagem abre a contagem pela curva ABC (o cimento, mais vendido, é A).
    const templates = (await admin.get('/api/routines/templates')).body.items as { id: number; kind: string; name: string; weekdays: number[] }[];
    const countTemplate = templates.find((t) => t.kind === 'stock_count')!;
    await admin.put(`/api/routines/templates/${countTemplate.id}`).send({ name: countTemplate.name, kind: 'stock_count', frequency: 'weekly', weekdays: EVERY_DAY });
    const runRes = await seller.post('/api/routines/runs').send({ template_id: countTemplate.id });
    expect(runRes.status).toBe(201);
    const run = (await seller.get(`/api/routines/runs/${runRes.body.run.id}`)).body.run;
    expect(run.count).toMatchObject({ status: 'counting', items: 3, counted: 0 });
    const countId = run.count.id;

    let view = (await seller.get(`/api/stock-counts/${countId}`)).body;
    expect(view.reveal).toBe(false);
    const items = view.items as { id: number; product_id: number; abc_class: string; expected_quantity: number | null }[];
    expect(items[0]).toMatchObject({ product_id: f.products.cimento, abc_class: 'A', expected_quantity: null });
    // Um produto não entra em duas contagens abertas: não sobra nada para outra agora.
    expect((await seller.post('/api/stock-counts').send({})).body.code).toBe('NOTHING_TO_COUNT');

    const cimento = items.find((i) => i.product_id === f.products.cimento)!;
    const areia = items.find((i) => i.product_id === f.products.areia)!;
    await seller.put(`/api/stock-counts/${countId}/items/${cimento.id}`).send({ counted_quantity: 98 });
    await seller.put(`/api/stock-counts/${countId}/items/${areia.id}`).send({ counted_quantity: 20 });
    view = (await admin.get(`/api/stock-counts/${countId}`)).body;
    expect(view.reveal).toBe(false); // ainda contando: nem o admin vê
    expect((await seller.post(`/api/routines/runs/${run.id}/finish`).send({})).status).toBe(409);
    expect((await seller.post(`/api/stock-counts/${countId}/submit`)).status).toBe(204);
    expect((await seller.get(`/api/routines/runs/${run.id}`)).body.run.status).toBe('done');
    expect((await seller.put(`/api/stock-counts/${countId}/items/${cimento.id}`).send({ counted_quantity: 1 })).status).toBe(409);

    // Depois de enviada, só o admin vê o esperado: 90 de saldo + 10 a entregar = 100.
    expect((await seller.get(`/api/stock-counts/${countId}`)).body.items[0].expected_quantity).toBeNull();
    view = (await admin.get(`/api/stock-counts/${countId}`)).body;
    expect(view.reveal).toBe(true);
    expect(view.items.find((i: { id: number }) => i.id === cimento.id)).toMatchObject({ counted_quantity: 98, expected_quantity: 100, unit_cost: 30 });

    // Venda depois da contagem não se perde: o ajuste é -2, não "passa a ser 98".
    await seller.post('/api/orders').send({ client_id: f.clientId, status: 'order', items: [{ product_id: f.products.cimento, quantity: 1 }] });
    expect((await seller.post(`/api/stock-counts/${countId}/review`).send({ adjust_item_ids: [] })).status).toBe(403);
    const review = await admin.post(`/api/stock-counts/${countId}/review`).send({ adjust_item_ids: [cimento.id, areia.id], note: 'Dois sacos rasgados' });
    expect(review.body).toEqual({ adjusted: 1, value: -60 });
    const balance = await adminPool.query('select quantity from stock_balances where store_id = $1 and product_id = $2', [f.storeA, f.products.cimento]);
    expect(Number(balance.rows[0].quantity)).toBe(100 - 10 - 1 - 2);
    expect((await admin.post(`/api/stock-counts/${countId}/review`).send({ adjust_item_ids: [] })).status).toBe(409);
    const outcomes = (await admin.get(`/api/stock-counts/${countId}`)).body.items.map((i: { outcome: string | null }) => i.outcome);
    expect(outcomes.sort()).toEqual(['adjusted', 'ignored', null]);
    const divergences = (await admin.get('/api/reports/divergencias')).body;
    expect(divergences.rows).toEqual([expect.objectContaining({ name: 'Cimento CP II 50 kg', expected: 100, counted: 98, difference: -2, value: -60, outcome: 'adjusted' })]);
    expect(divergences.metrics.map((m: { value: number }) => m.value)).toEqual([2, 50, -60, 0]);
    expect((await seller.get('/api/reports/divergencias')).status).toBe(403);

    // Contados há pouco, cimento e areia não voltam na próxima cíclica; o tijolo não foi contado e volta.
    const next = await seller.post('/api/stock-counts').send({});
    expect(next.status).toBe(201);
    const nextItems = (await seller.get(`/api/stock-counts/${next.body.count.id}`)).body.items.map((i: { product_id: number }) => i.product_id);
    expect(nextItems).toEqual([f.products.tijolo]);
    expect((await (await login(app, 'vendedor.b')).post(`/api/stock-counts/${next.body.count.id}/cancel`)).status).toBe(404);
    expect((await seller.post(`/api/stock-counts/${next.body.count.id}/cancel`)).status).toBe(204);
  });
});
