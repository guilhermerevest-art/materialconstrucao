import type pg from 'pg';
import type request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { createApp } from '../src/app.js';
import { login, resetDatabase, seedFixtures, setupApp, TEST_DATABASE_URL, type Fixtures } from './helpers.js';

const describeDb = TEST_DATABASE_URL ? describe : describe.skip;

type Agent = ReturnType<typeof request.agent>;

const ACCESS_KEY = '35261012345678000199550010000012341000012345';

describeDb('estoque', () => {
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

  async function balance(agent: Agent, productId: number, storeId = f.storeA) {
    const res = await agent.get(`/api/stock/products/${productId}?store_id=${storeId}`);
    return res.body.balances.find((b: { store_id: number }) => b.store_id === storeId).quantity as number;
  }

  function entry(admin: Agent, extra: Record<string, unknown> = {}) {
    return admin.post('/api/stock/entries').send({
      store_id: f.storeA,
      supplier_name: 'Votorantim Cimentos',
      supplier_document: '12.345.678/0001-99',
      invoice_number: '1234',
      invoice_series: '1',
      access_key: ACCESS_KEY,
      items: [
        { product_id: f.products.cimento, quantity: 100, unit_cost: 29.5, supplier_code: 'CPII-50' },
        // A nota vende o milheiro; a loja vende a unidade.
        { product_id: f.products.tijolo, quantity: 2000, unit_cost: 0.62, supplier_code: 'TIJ-MIL', factor: 1000 },
      ],
      ...extra,
    });
  }

  it('entrada da nota soma o estoque, guarda o custo e não entra duas vezes', async () => {
    const admin = await login(app, 'admin');
    const res = await entry(admin);
    expect(res.status).toBe(201);
    expect(await balance(admin, f.products.cimento)).toBe(100);
    expect(await balance(admin, f.products.tijolo)).toBe(2000);
    expect(await balance(admin, f.products.cimento, f.storeB)).toBe(0);

    const detail = await admin.get(`/api/stock/products/${f.products.cimento}?store_id=${f.storeA}`);
    expect(detail.body.product.cost_price).toBe(29.5);
    expect(detail.body.movements[0]).toMatchObject({ kind: 'entry', quantity: 100, balance_after: 100, invoice_number: '1234' });

    const again = await entry(admin);
    expect(again.status).toBe(409);
    expect(again.body.error).toContain('já deu entrada');

    // Na próxima nota do mesmo fornecedor, o código dele já aponta para o produto (com a conversão).
    const match = await admin.post('/api/stock/entries/match').send({
      supplier_document: '12345678000199',
      items: [{ code: 'TIJ-MIL', name: 'TIJOLO 8F MILHEIRO' }, { code: 'X', ean: 'ARE-MED' }, { code: 'Y', name: 'Nada parecido' }],
    });
    expect(match.body.matches).toMatchObject([
      { product_id: f.products.tijolo, factor: 1000, source: 'supplier', product: { code: 'TIJ-8F', unit: 'UN' } },
      { product_id: f.products.areia, factor: 1, source: 'code', product: { name: 'Areia média' } },
      null,
    ]);

    const list = await admin.get('/api/stock/entries');
    expect(list.body.items[0]).toMatchObject({ invoice_number: '1234', items_count: 2, total_amount: 4190 });
  });

  it('venda baixa na confirmação e o cancelamento devolve', async () => {
    const admin = await login(app, 'admin');
    await entry(admin);
    const seller = await login(app, 'vendedor.a');

    const quote = await seller.post('/api/orders').send({
      client_id: f.clientId,
      status: 'quote',
      items: [{ product_id: f.products.cimento, quantity: 10 }],
    });
    expect(await balance(admin, f.products.cimento)).toBe(100);
    await seller.post(`/api/orders/${quote.body.order.id}/convert`);
    expect(await balance(admin, f.products.cimento)).toBe(90);

    // A busca do PDV mostra o saldo da loja.
    const search = await seller.get(`/api/products?q=CIM-50&stock_store_id=${f.storeA}`);
    expect(search.body.items[0]).toMatchObject({ stock: 90, track_stock: true });

    const order = await seller.post('/api/orders').send({
      client_id: f.clientId,
      status: 'order',
      items: [
        { product_id: f.products.cimento, quantity: 95 },
        { product_id: f.products.tijolo, quantity: 500 },
      ],
    });
    // Sem trava: o saldo pode ficar negativo.
    expect(await balance(admin, f.products.cimento)).toBe(-5);
    expect((await admin.get(`/api/stock?store_id=${f.storeA}&filter=negative`)).body.items.map((p: { id: number }) => p.id)).toEqual([
      f.products.cimento,
    ]);

    expect((await admin.delete(`/api/orders/${order.body.order.id}`)).status).toBe(409);
    await admin.post(`/api/orders/${order.body.order.id}/cancel`).send({ reason: 'Cliente desistiu' });
    expect(await balance(admin, f.products.cimento)).toBe(90);
    expect(await balance(admin, f.products.tijolo)).toBe(2000);
    const movements = (await admin.get(`/api/stock/products/${f.products.cimento}?store_id=${f.storeA}`)).body.movements;
    expect(movements[0]).toMatchObject({ kind: 'sale_cancel', quantity: 95, order_id: order.body.order.id });
    // Cancelado pode ser excluído.
    expect((await admin.delete(`/api/orders/${order.body.order.id}`)).status).toBe(204);
  });

  it('produto que não controla estoque não baixa', async () => {
    const admin = await login(app, 'admin');
    await admin.put(`/api/stock/products/${f.products.areia}/tracking`).send({ track_stock: false });
    await admin.post('/api/orders').send({
      client_id: f.clientId,
      status: 'order',
      store_id: f.storeA,
      items: [{ product_id: f.products.areia, quantity: 3 }],
    });
    expect(await balance(admin, f.products.areia)).toBe(0);
    const res = await admin.post('/api/stock/adjustments').send({
      store_id: f.storeA,
      items: [{ product_id: f.products.areia, mode: 'count', quantity: 5 }],
    });
    expect(res.status).toBe(400);
  });

  it('contagem, acerto, mínimo e transferência', async () => {
    const admin = await login(app, 'admin');
    await entry(admin);

    const count = await admin.post('/api/stock/adjustments').send({
      store_id: f.storeA,
      note: 'Inventário de outubro',
      items: [
        { product_id: f.products.cimento, mode: 'count', quantity: 97 },
        { product_id: f.products.tijolo, mode: 'delta', quantity: -15 },
      ],
    });
    expect(count.body.changed).toBe(2);
    expect(await balance(admin, f.products.cimento)).toBe(97);
    expect(await balance(admin, f.products.tijolo)).toBe(1985);

    await admin.put(`/api/stock/products/${f.products.cimento}/min`).send({ store_id: f.storeA, min_quantity: 120 });
    const below = await admin.get(`/api/stock?store_id=${f.storeA}&filter=below_min`);
    expect(below.body.items).toMatchObject([{ id: f.products.cimento, quantity: 97, min_quantity: 120 }]);
    expect(below.body.summary).toEqual({ below_min: 1, negative: 0 });

    const same = await admin.post('/api/stock/transfers').send({
      from_store_id: f.storeA,
      to_store_id: f.storeA,
      items: [{ product_id: f.products.cimento, quantity: 1 }],
    });
    expect(same.status).toBe(400);
    await admin.post('/api/stock/transfers').send({
      from_store_id: f.storeA,
      to_store_id: f.storeB,
      items: [{ product_id: f.products.cimento, quantity: 40 }],
    });
    expect(await balance(admin, f.products.cimento)).toBe(57);
    expect(await balance(admin, f.products.cimento, f.storeB)).toBe(40);
    const moved = (await admin.get(`/api/stock/products/${f.products.cimento}?store_id=${f.storeB}`)).body.movements[0];
    expect(moved).toMatchObject({ kind: 'transfer_in', quantity: 40, other_store_name: 'Loja A' });
  });

  it('vendedor consulta o estoque, mas não mexe', async () => {
    const seller = await login(app, 'vendedor.b');
    const list = await seller.get('/api/stock');
    expect(list.status).toBe(200);
    expect(list.body.store_id).toBe(f.storeB);
    // Consulta o saldo da outra loja para dizer ao cliente onde tem.
    expect((await seller.get(`/api/stock?store_id=${f.storeA}`)).body.store_id).toBe(f.storeA);
    expect((await seller.post('/api/stock/adjustments').send({ store_id: f.storeB, items: [] })).status).toBe(403);
    expect((await entry(seller)).status).toBe(403);
  });
});
