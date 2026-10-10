import type pg from 'pg';
import type request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { createApp } from '../src/app.js';
import { roundPrice } from '../src/routes/pricing.js';
import { login, PASSWORD, resetDatabase, seedFixtures, setupApp, TEST_DATABASE_URL, type Fixtures } from './helpers.js';

const describeDb = TEST_DATABASE_URL ? describe : describe.skip;

type Agent = ReturnType<typeof request.agent>;
type Item = { product_id: number; quantity: number; unit_price: number };

describe('arredondamento do reajuste', () => {
  it('arredonda para cima no múltiplo escolhido', () => {
    expect(roundPrice(12.37, 'none')).toBe(12.37);
    expect(roundPrice(12.37, '0.05')).toBe(12.4);
    expect(roundPrice(12.31, '0.10')).toBe(12.4);
    expect(roundPrice(12.4, '0.10')).toBe(12.4);
    expect(roundPrice(12.01, '0.50')).toBe(12.5);
    expect(roundPrice(12.01, '1.00')).toBe(13);
  });
});

describeDb('preço', () => {
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

  function order(agent: Agent, items: { product_id: number; quantity: number }[], extra: Record<string, unknown> = {}) {
    return agent.post('/api/orders').send({ client_id: f.clientId, status: 'quote', items, ...extra });
  }
  const priceOf = (items: Item[], productId: number) => items.find((i) => i.product_id === productId)!.unit_price;

  it('sem nada configurado, vale o preço do catálogo e o desconto é livre', async () => {
    const seller = await login(app, 'vendedor.a');
    const res = await order(seller, [{ product_id: f.products.cimento, quantity: 100 }], { discount_type: 'percent', discount_value: 30 });
    expect(res.status).toBe(201);
    expect(res.body.order.items[0].unit_price).toBe(38.9);
    expect(res.body.order.price_list_name).toBeNull();
    const me = (await seller.get('/api/auth/me')).body.user;
    expect(me.max_discount_percent).toBeNull();
  });

  it('tabela de preço do cliente: ajuste % e preço próprio por produto', async () => {
    const admin = await login(app, 'admin');
    const list = (await admin.post('/api/price-lists').send({ name: 'Atacado', adjust_percent: -10 })).body.price_list;
    expect((await admin.put(`/api/price-lists/${list.id}/items`).send({ items: [{ product_id: f.products.areia, price: 120 }] })).status).toBe(204);

    const seller = await login(app, 'vendedor.a');
    // Vendedor não muda a tabela do cliente.
    const denied = await seller.put(`/api/clients/${f.clientId}`).send({ name: 'Maria da Silva', whatsapp: '5511987654321', price_list_id: list.id });
    expect(denied.status).toBe(403);
    const saved = await admin.put(`/api/clients/${f.clientId}`).send({ name: 'Maria da Silva', whatsapp: '5511987654321', price_list_id: list.id });
    expect(saved.status).toBe(200);

    const res = await order(seller, [
      { product_id: f.products.cimento, quantity: 10 },
      { product_id: f.products.areia, quantity: 1 },
    ]);
    expect(res.status).toBe(201);
    expect(priceOf(res.body.order.items, f.products.cimento)).toBe(35.01); // 38,90 - 10%
    expect(priceOf(res.body.order.items, f.products.areia)).toBe(120);
    expect(res.body.order.price_list_name).toBe('Atacado');

    const search = (await seller.get(`/api/products?q=cimento&client_id=${f.clientId}`)).body.items[0];
    expect(search).toMatchObject({ price: 38.9, client_price: 35.01 });

    // Desativada, o cliente volta ao catálogo.
    await admin.put(`/api/price-lists/${list.id}`).send({ name: 'Atacado', adjust_percent: -10, active: false });
    const back = await order(seller, [{ product_id: f.products.cimento, quantity: 10 }]);
    expect(back.body.order.items[0].unit_price).toBe(38.9);
  });

  it('faixa por quantidade e o menor entre faixa e tabela', async () => {
    const admin = await login(app, 'admin');
    const put = await admin
      .put(`/api/products/${f.products.cimento}/pricing`)
      .send({ markup_percent: null, tiers: [{ min_quantity: 50, price: 36.9 }, { min_quantity: 200, price: 35.5 }] });
    expect(put.status).toBe(204);
    const seller = await login(app, 'vendedor.a');

    const preview = await seller.post('/api/orders/price-preview').send({
      client_id: f.clientId,
      items: [
        { product_id: f.products.cimento, quantity: 10 },
        { product_id: f.products.tijolo, quantity: 10 },
      ],
    });
    expect(preview.status).toBe(200);
    expect(preview.body.items[0]).toMatchObject({ unit_price: 38.9, source: 'catalog', next_tier: { min_quantity: 50, price: 36.9 } });

    const res = await order(seller, [{ product_id: f.products.cimento, quantity: 60 }]);
    expect(res.body.order.items[0].unit_price).toBe(36.9);
    const big = await order(seller, [{ product_id: f.products.cimento, quantity: 250 }]);
    expect(big.body.order.items[0].unit_price).toBe(35.5);

    // Com tabela de -10% (35,01), a faixa de 50 (36,90) não compensa: fica a tabela.
    const list = (await admin.post('/api/price-lists').send({ name: 'Construtora', adjust_percent: -10 })).body.price_list;
    await admin.put(`/api/clients/${f.clientId}`).send({ name: 'Maria da Silva', whatsapp: '5511987654321', price_list_id: list.id });
    const mixed = await order(seller, [{ product_id: f.products.cimento, quantity: 60 }]);
    expect(mixed.body.order.items[0].unit_price).toBe(35.01);
  });

  it('orçamento editado mantém o preço da época; mudou a quantidade, fica o menor', async () => {
    const admin = await login(app, 'admin');
    const seller = await login(app, 'vendedor.a');
    const quote = (await order(seller, [{ product_id: f.products.cimento, quantity: 10 }])).body.order;
    await adminPool.query('update products set price = 42 where id = $1', [f.products.cimento]);

    const same = await seller.put(`/api/orders/${quote.id}`).send({ client_id: f.clientId, status: 'quote', items: [{ product_id: f.products.cimento, quantity: 10 }] });
    expect(same.body.order.items[0].unit_price).toBe(38.9);

    // Mais quantidade com faixa melhor que o preço antigo: o cliente ganha a faixa.
    await admin.put(`/api/products/${f.products.cimento}/pricing`).send({ markup_percent: null, tiers: [{ min_quantity: 50, price: 37 }] });
    const preview = await seller
      .post('/api/orders/price-preview')
      .send({ client_id: f.clientId, order_id: quote.id, items: [{ product_id: f.products.cimento, quantity: 60 }] });
    expect(preview.body.items[0].unit_price).toBe(37);
    const more = await seller.put(`/api/orders/${quote.id}`).send({ client_id: f.clientId, status: 'quote', items: [{ product_id: f.products.cimento, quantity: 60 }] });
    expect(more.body.order.items[0].unit_price).toBe(37);

    // Menos quantidade (sem faixa): o preço de agora (42) é maior, fica o antigo.
    const less = await seller.put(`/api/orders/${quote.id}`).send({ client_id: f.clientId, status: 'quote', items: [{ product_id: f.products.cimento, quantity: 5 }] });
    expect(less.body.order.items[0].unit_price).toBe(37);
  });

  it('desconto acima do limite pede a senha de quem libera', async () => {
    const admin = await login(app, 'admin');
    expect((await admin.put('/api/sales-settings').send({ max_discount_percent: 5, default_markup_percent: null })).status).toBe(200);
    const seller = await login(app, 'vendedor.a');
    expect((await seller.get('/api/auth/me')).body.user.max_discount_percent).toBe(5);

    const items = [{ product_id: f.products.cimento, quantity: 10 }];
    expect((await order(seller, items, { discount_type: 'percent', discount_value: 5 })).status).toBe(201);
    const blocked = await order(seller, items, { discount_type: 'percent', discount_value: 10 });
    expect(blocked.status).toBe(403);
    expect(blocked.body).toMatchObject({ code: 'DISCOUNT_APPROVAL_REQUIRED', limit: 5, requested: 10 });
    // Desconto em R$ conta pelo percentual: 50,00 de 389,00 = 12,85%.
    const byAmount = await order(seller, items, { discount_type: 'amount', discount_value: 50 });
    expect(byAmount.body).toMatchObject({ code: 'DISCOUNT_APPROVAL_REQUIRED', requested: 12.85 });

    const wrong = await order(seller, items, { discount_type: 'percent', discount_value: 10, discount_approval: { username: 'admin', password: 'errada' } });
    expect(wrong.status).toBe(422);
    const notAllowed = await order(seller, items, { discount_type: 'percent', discount_value: 10, discount_approval: { username: 'vendedor.b', password: PASSWORD } });
    expect(notAllowed.status).toBe(403);
    expect(notAllowed.body.error).toContain('não pode liberar');

    const approved = await order(seller, items, { discount_type: 'percent', discount_value: 10, discount_approval: { username: 'ADMIN', password: PASSWORD } });
    expect(approved.status).toBe(201);
    const row = await adminPool.query('select discount_approved_by, discount_approved_percent from orders where id = $1', [approved.body.order.id]);
    expect(row.rows[0]).toMatchObject({ discount_approved_by: f.adminId, discount_approved_percent: 10 });

    // Editar sem passar do liberado não pede de novo; passar pede.
    const body = { client_id: f.clientId, status: 'quote', items, discount_type: 'percent' };
    expect((await seller.put(`/api/orders/${approved.body.order.id}`).send({ ...body, discount_value: 8 })).status).toBe(200);
    expect((await seller.put(`/api/orders/${approved.body.order.id}`).send({ ...body, discount_value: 12 })).status).toBe(403);

    // Limite do próprio vendedor vale mais que o da loja; quem libera pode ter limite.
    const users = (await admin.get('/api/users')).body.items as { id: number; username: string }[];
    const sellerA = users.find((u) => u.username === 'vendedor.a')!;
    const sellerB = users.find((u) => u.username === 'vendedor.b')!;
    const update = (u: { id: number; username: string }, extra: Record<string, unknown>) =>
      admin.put(`/api/users/${u.id}`).send({
        name: u.username === 'vendedor.a' ? 'Vendedor A' : 'Vendedor B',
        username: u.username,
        email: null,
        role: 'seller',
        store_id: u.username === 'vendedor.a' ? f.storeA : f.storeB,
        active: true,
        ...extra,
      });
    expect((await update(sellerA, { max_discount_percent: 15 })).status).toBe(200);
    expect((await order(seller, items, { discount_type: 'percent', discount_value: 15 })).status).toBe(201);
    expect((await update(sellerB, { can_approve_discounts: true, max_discount_percent: 20 })).status).toBe(200);
    const byB = await order(seller, items, { discount_type: 'percent', discount_value: 18, discount_approval: { username: 'vendedor.b', password: PASSWORD } });
    expect(byB.status).toBe(201);
    const tooMuch = await order(seller, items, { discount_type: 'percent', discount_value: 25, discount_approval: { username: 'vendedor.b', password: PASSWORD } });
    expect(tooMuch.status).toBe(403);
    expect(tooMuch.body.error).toContain('libera até 20%');

    // Admin não tem limite.
    expect((await order(admin, items, { discount_type: 'percent', discount_value: 50, store_id: f.storeA })).status).toBe(201);
  });

  it('reajuste em massa por % e por margem, com histórico', async () => {
    const admin = await login(app, 'admin');
    const preview = await admin.post('/api/products/price-adjust').send({ mode: 'percent', percent: 10, rounding: '0.10' });
    expect(preview.status).toBe(200);
    expect(preview.body.applied).toBe(false);
    const cimento = preview.body.items.find((i: { id: number }) => i.id === f.products.cimento);
    expect(cimento).toMatchObject({ old_price: 38.9, new_price: 42.8 }); // 42,79 → 42,80
    expect((await adminPool.query('select price from products where id = $1', [f.products.cimento])).rows[0].price).toBe(38.9);

    const applied = await admin.post('/api/products/price-adjust').send({ mode: 'percent', percent: 10, rounding: '0.10', q: 'cimento', apply: true });
    expect(applied.body).toMatchObject({ count: 1, applied: true });
    const pricing = (await admin.get(`/api/products/${f.products.cimento}/pricing`)).body.pricing;
    expect(pricing.price).toBe(42.8);
    expect(pricing.history[0]).toMatchObject({ old_price: 38.9, new_price: 42.8, reason: 'Reajuste de 10%', user_name: 'Admin' });

    // Margem: custo + margem do produto (ou a padrão); sem custo, fica de fora.
    await adminPool.query('update products set cost_price = 25 where id = $1', [f.products.cimento]);
    await admin.put(`/api/products/${f.products.cimento}/pricing`).send({ markup_percent: 60, tiers: [] });
    await adminPool.query('update products set cost_price = 1 where id = $1', [f.products.tijolo]);
    await admin.put('/api/sales-settings').send({ max_discount_percent: null, default_markup_percent: 50 });
    const markup = await admin.post('/api/products/price-adjust').send({ mode: 'markup', rounding: 'none', apply: true });
    expect(markup.body.skipped).toBe(1); // areia sem custo
    const prices = await adminPool.query('select id, price from products order by id');
    const byId = new Map(prices.rows.map((r) => [Number(r.id), Number(r.price)]));
    expect(byId.get(f.products.cimento)).toBe(40); // 25 + 60%
    expect(byId.get(f.products.tijolo)).toBe(1.5); // 1 + 50%
    expect(byId.get(f.products.areia)).toBe(145);

    // Vendedor não reajusta.
    const seller = await login(app, 'vendedor.a');
    expect((await seller.post('/api/products/price-adjust').send({ mode: 'percent', percent: 5 })).status).toBe(403);
  });

  it('entrada de nota sugere pela margem e pode atualizar o preço de venda', async () => {
    const admin = await login(app, 'admin');
    await admin.put('/api/sales-settings').send({ max_discount_percent: null, default_markup_percent: 40 });
    const match = await admin.post('/api/stock/entries/match').send({ supplier_document: null, items: [{ code: 'CIM-50', ean: null, name: null }] });
    expect(match.body.matches[0].product).toMatchObject({ price: 38.9, markup_percent: 40 });

    const entry = await admin.post('/api/stock/entries').send({
      store_id: f.storeA,
      invoice_number: '1234',
      items: [
        { product_id: f.products.cimento, quantity: 100, unit_cost: 29, new_price: 40.6 },
        { product_id: f.products.tijolo, quantity: 1000, unit_cost: 0.8 },
      ],
    });
    expect(entry.status).toBe(201);
    const pricing = (await admin.get(`/api/products/${f.products.cimento}/pricing`)).body.pricing;
    expect(pricing).toMatchObject({ price: 40.6, cost_price: 29 });
    expect(pricing.history[0]).toMatchObject({ new_price: 40.6, reason: 'Entrada da NF 1234' });
    expect((await adminPool.query('select price from products where id = $1', [f.products.tijolo])).rows[0].price).toBe(1.35);
  });

  it('a venda guarda o custo do item na confirmação', async () => {
    await adminPool.query('update products set cost_price = 30.5 where id = $1', [f.products.cimento]);
    const seller = await login(app, 'vendedor.a');
    const res = await order(seller, [{ product_id: f.products.cimento, quantity: 2 }], { status: 'order' });
    expect(res.status).toBe(201);
    const cost = await adminPool.query('select unit_cost from order_items where order_id = $1', [res.body.order.id]);
    expect(Number(cost.rows[0].unit_cost)).toBe(30.5);
  });
});
