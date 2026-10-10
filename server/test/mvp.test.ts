import type pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { createApp } from '../src/app.js';
import { login, resetDatabase, seedFixtures, setupApp, startFakeEvolution, TEST_DATABASE_URL } from './helpers.js';

const describeDb = TEST_DATABASE_URL ? describe : describe.skip;

/**
 * O MVP tem que continuar funcionando sem configurar nenhum módulo novo: produto só
 * com código, nome, unidade e preço; cliente só com nome e WhatsApp; orçamento, pedido,
 * PDF e WhatsApp. Fluxo, estoque, entregas, obras e crédito são opcionais.
 */
describeDb('MVP: cadastro simples continua funcionando', () => {
  let pool: pg.Pool;
  let adminPool: pg.Pool;
  let app: ReturnType<typeof createApp>;
  let evolution: Awaited<ReturnType<typeof startFakeEvolution>>;

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
    await seedFixtures(pool, adminPool);
    evolution.requests.length = 0;
  });

  it('produto simples, cliente com nome e WhatsApp, orçamento → pedido → PDF → WhatsApp', async () => {
    const admin = await login(app, 'admin');
    const product = await admin.post('/api/products').send({ code: 'TELHA-01', name: 'Telha colonial', unit: 'un', price: 2.5 });
    expect(product.status).toBe(201);
    expect(product.body.product).toMatchObject({ code: 'TELHA-01', unit: 'UN', price: 2.5, active: true });
    await admin.put('/api/settings').send({
      evolution_api_url: evolution.url,
      evolution_instance: 'loja',
      evolution_api_token: 'token-secreto-1234',
    });

    const seller = await login(app, 'vendedor.a');
    const client = await seller.post('/api/clients').send({ name: 'Dona Rosa', whatsapp: '(11) 97777-1234' });
    expect(client.status).toBe(201);
    const clientId = client.body.client.id;

    const quote = await seller.post('/api/orders').send({
      client_id: clientId,
      status: 'quote',
      items: [{ product_id: product.body.product.id, quantity: 300 }],
    });
    expect(quote.status).toBe(201);
    expect(quote.body.order).toMatchObject({ status: 'quote', total_amount: 750, workflow: null, client_site_id: null });

    const edited = await seller.put(`/api/orders/${quote.body.order.id}`).send({
      client_id: clientId,
      status: 'quote',
      notes: 'Entregar sábado',
      items: [{ product_id: product.body.product.id, quantity: 400 }],
    });
    expect(edited.status).toBe(200);
    expect(edited.body.order.total_amount).toBe(1000);

    const converted = await seller.post(`/api/orders/${quote.body.order.id}/convert`);
    expect(converted.status).toBe(200);
    // Sem fluxo configurado: o pedido não passa por etapas e nada é exigido.
    expect(converted.body.order).toMatchObject({ status: 'order', workflow: null });

    const pdf = await seller.get(`/api/orders/${quote.body.order.id}/pdf`);
    expect(pdf.status).toBe(200);
    expect(pdf.headers['content-type']).toBe('application/pdf');

    const sent = await seller.post(`/api/orders/${quote.body.order.id}/whatsapp`);
    expect(sent.status).toBe(200);
    expect(evolution.requests[0]?.body).toMatchObject({ number: '5511977771234', mediatype: 'document' });

    // Venda direta, sem forma de pagamento nem endereço.
    const direct = await seller.post('/api/orders').send({
      client_id: clientId,
      status: 'order',
      items: [{ product_id: product.body.product.id, quantity: 10 }],
    });
    expect(direct.status).toBe(201);

    expect((await seller.get('/api/orders')).body.total).toBe(2);
    expect((await seller.get('/api/dashboard')).body.summary.orders_today).toBe(2);
    expect((await seller.get('/api/reports/produtos')).status).toBe(200);
    expect((await seller.get(`/api/orders/${direct.body.order.id}`)).status).toBe(200);
  });
});
