import type pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { createApp } from '../src/app.js';
import { login, resetDatabase, seedFixtures, setupApp, TEST_DATABASE_URL, type Fixtures } from './helpers.js';

const describeDb = TEST_DATABASE_URL ? describe : describe.skip;

describeDb('obras e crédito do cliente', () => {
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

  it('vendedor cadastra obras e usa no pedido', async () => {
    const seller = await login(app, 'vendedor.a');
    const badPhone = await seller.post(`/api/clients/${f.clientId}/sites`).send({
      name: 'Obra Rua das Flores',
      address: 'Rua das Flores, 120 - Centro',
      contact_phone: '123',
    });
    expect(badPhone.status).toBe(400);

    const created = await seller.post(`/api/clients/${f.clientId}/sites`).send({
      name: 'Obra Rua das Flores',
      address: 'Rua das Flores, 120 - Centro',
      contact_name: 'Seu Zé (mestre de obras)',
      contact_phone: '(11) 91234-5678',
    });
    expect(created.status).toBe(201);
    const site = created.body.site;
    expect(site).toMatchObject({ client_id: f.clientId, contact_phone: '5511912345678', active: true, orders_count: 0 });

    const order = await seller.post('/api/orders').send({
      client_id: f.clientId,
      status: 'quote',
      client_site_id: site.id,
      delivery_address: site.address,
      items: [{ product_id: f.products.areia, quantity: 3 }],
    });
    expect(order.status).toBe(201);
    expect(order.body.order).toMatchObject({ client_site_id: site.id, client_site_name: 'Obra Rua das Flores' });

    const clients = await seller.get('/api/clients');
    expect(clients.body.items[0]).toMatchObject({ sites_count: 1, credit_limit: null });

    // Desativada: some do PDV, mas o orçamento que já estava com ela continua salvando.
    await seller.put(`/api/client-sites/${site.id}`).send({ ...site, active: false });
    const blocked = await seller.post('/api/orders').send({
      client_id: f.clientId,
      status: 'quote',
      client_site_id: site.id,
      items: [{ product_id: f.products.areia, quantity: 1 }],
    });
    expect(blocked.status).toBe(400);
    const kept = await seller.put(`/api/orders/${order.body.order.id}`).send({
      client_id: f.clientId,
      status: 'quote',
      client_site_id: site.id,
      delivery_address: site.address,
      items: [{ product_id: f.products.areia, quantity: 4 }],
    });
    expect(kept.status).toBe(200);

    // Excluir a obra não apaga o endereço gravado no pedido.
    expect((await seller.delete(`/api/client-sites/${site.id}`)).status).toBe(204);
    const detail = await seller.get(`/api/orders/${order.body.order.id}`);
    expect(detail.body.order).toMatchObject({ client_site_id: null, delivery_address: 'Rua das Flores, 120 - Centro' });
  });

  it('obra de outro cliente não entra no pedido', async () => {
    const seller = await login(app, 'vendedor.a');
    const other = await seller.post('/api/clients').send({ name: 'João Construtor', whatsapp: '(11) 98888-7777' });
    const site = await seller.post(`/api/clients/${other.body.client.id}/sites`).send({ name: 'Obra do João', address: 'Rua B, 2' });
    const res = await seller.post('/api/orders').send({
      client_id: f.clientId,
      status: 'quote',
      client_site_id: site.body.site.id,
      items: [{ product_id: f.products.areia, quantity: 1 }],
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('não é deste cliente');
  });

  it('só o admin define o limite de crédito', async () => {
    const seller = await login(app, 'vendedor.a');
    expect((await seller.put(`/api/clients/${f.clientId}/credit`).send({ credit_limit: 5000 })).status).toBe(403);
    const admin = await login(app, 'admin');
    const set = await admin.put(`/api/clients/${f.clientId}/credit`).send({ credit_limit: 5000.456 });
    expect(set.body.client.credit_limit).toBe(5000.46);
    expect((await admin.get(`/api/clients/${f.clientId}`)).body.client.credit_limit).toBe(5000.46);
    expect((await admin.put(`/api/clients/${f.clientId}/credit`).send({ credit_limit: -1 })).status).toBe(400);
    const cleared = await admin.put(`/api/clients/${f.clientId}/credit`).send({ credit_limit: null });
    expect(cleared.body.client.credit_limit).toBeNull();
  });
});
