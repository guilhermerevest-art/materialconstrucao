import type pg from 'pg';
import type request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { createApp } from '../src/app.js';
import { todayIn } from '../src/lib/format.js';
import {
  login,
  resetDatabase,
  seedFixtures,
  setupApp,
  startFakeEvolution,
  TEST_DATABASE_URL,
  testConfig,
  type Fixtures,
} from './helpers.js';

const describeDb = TEST_DATABASE_URL ? describe : describe.skip;

type Agent = ReturnType<typeof request.agent>;
type FollowupRow = { id: number; due_on: string; days_late: number; followup_count: number; last_note: string | null };

const addDays = (iso: string, days: number) => {
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};

describeDb('retomada de orçamentos', () => {
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

  /** 3 x 38,90 = 116,70 */
  async function quote(agent: Agent, status: 'quote' | 'order' = 'quote') {
    const res = await agent.post('/api/orders').send({
      client_id: f.clientId,
      status,
      items: [{ product_id: f.products.cimento, quantity: 3 }],
    });
    expect(res.status).toBe(201);
    return res.body.order.id as number;
  }

  /** Volta a criação do orçamento no tempo, como se tivesse sido lançado há `days` dias. */
  async function age(orderId: number, days: number) {
    await adminPool.query(`update orders set created_at = now() - make_interval(days => $2) where id = $1`, [orderId, days]);
  }

  async function list(agent: Agent, scope = 'due') {
    const res = await agent.get(`/api/followups?scope=${scope}`);
    expect(res.status).toBe(200);
    return res.body.items as FollowupRow[];
  }

  async function configureEvolution(admin: Agent) {
    const res = await admin.put('/api/settings').send({
      evolution_api_url: evolution.url,
      evolution_instance: 'loja centro',
      evolution_api_token: 'token-secreto-1234',
    });
    expect(res.status).toBe(200);
  }

  it('sem configurar nada: o orçamento entra na retomada 3 dias depois do último contato', async () => {
    const seller = await login(app, 'vendedor.a');
    const id = await quote(seller);
    const today = todayIn(tz);

    expect(await list(seller)).toEqual([]);
    const upcoming = await list(seller, 'upcoming');
    expect(upcoming.map((r) => [r.id, r.due_on])).toEqual([[id, addDays(today, 3)]]);

    await age(id, 4);
    const due = await list(seller);
    expect(due).toHaveLength(1);
    expect(due[0]).toMatchObject({ id, due_on: addDays(today, -1), days_late: 1 });
    expect((await seller.get('/api/dashboard')).body.summary.followups_due).toBe(1);

    // Outra loja não vê; pedido confirmado e orçamento esquecido há meses não entram.
    const sellerB = await login(app, 'vendedor.b');
    expect(await list(sellerB)).toEqual([]);
    expect((await sellerB.get(`/api/orders/${id}/followups`)).status).toBe(404);
    expect((await sellerB.get('/api/dashboard')).body.summary.followups_due).toBe(0);
    const order = await quote(seller, 'order');
    await age(order, 10);
    const old = await quote(seller);
    await age(old, 90);
    expect((await list(seller, 'all')).map((r) => r.id)).toEqual([id]);

    const admin = await login(app, 'admin');
    expect((await list(admin)).map((r) => r.id)).toEqual([id]);
    expect((await admin.get('/api/dashboard')).body.summary.followups_due).toBe(1);
  });

  it('ligação registrada com o próximo contato combinado', async () => {
    const seller = await login(app, 'vendedor.a');
    const id = await quote(seller);
    await age(id, 5);
    const today = todayIn(tz);

    const noNote = await seller.post(`/api/orders/${id}/followups`).send({ channel: 'call' });
    expect(noNote.status).toBe(400);
    const sameDay = await seller.post(`/api/orders/${id}/followups`).send({ channel: 'call', note: 'Ligar hoje', next_on: today });
    expect(sameDay.status).toBe(422);

    const next = addDays(today, 7);
    const res = await seller
      .post(`/api/orders/${id}/followups`)
      .send({ channel: 'call', note: 'Vai ver com o mestre de obras', next_on: next });
    expect(res.status).toBe(201);
    expect(res.body.followup).toMatchObject({ channel: 'call', next_on: next, user_name: 'Vendedor A' });
    expect(evolution.requests).toHaveLength(0);

    expect(await list(seller)).toEqual([]);
    const [row] = await list(seller, 'upcoming');
    expect(row).toMatchObject({ id, due_on: next, followup_count: 1, last_note: 'Vai ver com o mestre de obras' });

    const history = (await seller.get(`/api/orders/${id}/followups`)).body;
    expect(history).toMatchObject({ followup_count: 1, followup_on: next, due_on: next, days: 3 });
    expect(history.items).toHaveLength(1);
    expect(history.message).toMatch(
      new RegExp(
        `^Olá, Maria! Aqui é Vendedor, da Loja A\\. Passando para saber se ficou alguma dúvida no orçamento nº ` +
          `${String(id).padStart(6, '0')} \\(R\\$\\s116,70\\)\\. Posso ajudar a fechar\\?$`,
      ),
    );

    // Sem data combinada, a próxima conta 3 dias a partir deste contato.
    const again = await seller.post(`/api/orders/${id}/followups`).send({ channel: 'visit', note: 'Passou na loja' });
    expect(again.status).toBe(201);
    const [after] = await list(seller, 'upcoming');
    expect(after).toMatchObject({ due_on: addDays(today, 3), followup_count: 2 });
  });

  it('WhatsApp: manda a mensagem (com o PDF, se pedido) e só registra se a EvolutionAPI aceitar', async () => {
    const admin = await login(app, 'admin');
    const seller = await login(app, 'vendedor.a');
    const id = await quote(seller);
    await age(id, 4);

    const notConfigured = await seller.post(`/api/orders/${id}/followups`).send({ channel: 'whatsapp' });
    expect(notConfigured.status).toBe(422);
    expect(notConfigured.body.code).toBe('WHATSAPP_NOT_CONFIGURED');

    await configureEvolution(admin);
    const text = await seller.post(`/api/orders/${id}/followups`).send({ channel: 'whatsapp' });
    expect(text.status).toBe(201);
    expect(evolution.requests).toHaveLength(1);
    expect(evolution.requests[0]!.url).toBe('/message/sendText/loja%20centro');
    expect(evolution.requests[0]!.body.number).toBe('5511987654321');
    expect(evolution.requests[0]!.body.text).toContain('Olá, Maria! Aqui é Vendedor, da Loja A.');
    expect(text.body.followup.message).toBe(evolution.requests[0]!.body.text);
    expect(await list(seller)).toEqual([]);

    evolution.requests.length = 0;
    const withPdf = await seller
      .post(`/api/orders/${id}/followups`)
      .send({ channel: 'whatsapp', message: 'Oi Maria, segue o orçamento atualizado.', with_pdf: true });
    expect(withPdf.status).toBe(201);
    const sent = evolution.requests[0]!;
    expect(sent.url).toBe('/message/sendMedia/loja%20centro');
    expect(sent.body.caption).toBe('Oi Maria, segue o orçamento atualizado.');
    expect(Buffer.from(sent.body.media, 'base64').subarray(0, 5).toString()).toBe('%PDF-');
    expect((await seller.get(`/api/orders/${id}`)).body.order.sent_at).toBeTruthy();

    evolution.respondWith(400, {
      status: 400,
      error: 'Bad Request',
      response: { message: [{ exists: false, jid: '5511987654321@s.whatsapp.net', number: '5511987654321' }] },
    });
    const failed = await seller.post(`/api/orders/${id}/followups`).send({ channel: 'whatsapp' });
    expect(failed.status).toBe(502);
    expect(failed.body.code).toBe('WHATSAPP_FAILED');
    expect((await seller.get(`/api/orders/${id}/followups`)).body.followup_count).toBe(2);
  });

  it('enviar o PDF do orçamento conta como contato', async () => {
    const admin = await login(app, 'admin');
    await configureEvolution(admin);
    const seller = await login(app, 'vendedor.a');
    const id = await quote(seller);
    await age(id, 4);
    expect(await list(seller)).toHaveLength(1);
    expect((await seller.post(`/api/orders/${id}/whatsapp`)).status).toBe(200);
    expect(await list(seller)).toEqual([]);
  });

  it('pedido não tem retomada; orçamento perdido sai da lista e volta se reaberto', async () => {
    const seller = await login(app, 'vendedor.a');
    const order = await quote(seller, 'order');
    const res = await seller.post(`/api/orders/${order}/followups`).send({ channel: 'call', note: 'Oi' });
    expect(res.status).toBe(409);

    const id = await quote(seller);
    await age(id, 4);
    expect((await seller.post(`/api/orders/${id}/cancel`).send({ reason: 'Comprou em outro lugar' })).status).toBe(200);
    expect(await list(seller)).toEqual([]);
    expect((await seller.post(`/api/orders/${id}/followups`).send({ channel: 'call', note: 'Oi' })).status).toBe(409);
    expect((await seller.post(`/api/orders/${id}/reopen`)).status).toBe(200);
    expect((await list(seller)).map((r) => r.id)).toEqual([id]);
  });

  it('mensagem chama o cliente pelo contato cadastrado', async () => {
    const seller = await login(app, 'vendedor.a');
    const id = await quote(seller);
    const saved = await seller
      .put(`/api/clients/${f.clientId}`)
      .send({ name: 'Maria da Silva', whatsapp: '5511987654321', contact_name: 'Rogério Lima' });
    expect(saved.status).toBe(200);
    expect(saved.body.client.contact_name).toBe('Rogério Lima');
    expect((await seller.get(`/api/orders/${id}/followups`)).body.message).toMatch(/^Olá, Rogério! /);

    // Sem mandar o campo, o contato continua o mesmo.
    await seller.put(`/api/clients/${f.clientId}`).send({ name: 'Maria da Silva', whatsapp: '5511987654321' });
    expect((await seller.get(`/api/clients/${f.clientId}`)).body.client.contact_name).toBe('Rogério Lima');
  });

  it('o admin muda os dias e a mensagem; vendedor não', async () => {
    const admin = await login(app, 'admin');
    const seller = await login(app, 'vendedor.a');
    expect((await seller.put('/api/followups/settings').send({ followup_days: 7, followup_message: null })).status).toBe(403);

    const defaults = (await admin.get('/api/followups/settings')).body.settings;
    expect(defaults).toMatchObject({ followup_days: 3, followup_message: null });
    expect(defaults.default_message).toContain('{cliente}');

    const bad = await admin.put('/api/followups/settings').send({ followup_days: 0, followup_message: null });
    expect(bad.status).toBe(400);
    const saved = await admin
      .put('/api/followups/settings')
      .send({ followup_days: 7, followup_message: '{cliente}, o orçamento {pedido} de {total} ainda vale. {vendedor} - {loja}' });
    expect(saved.status).toBe(200);

    const id = await quote(seller);
    await age(id, 4);
    expect(await list(seller)).toEqual([]);
    const history = (await seller.get(`/api/orders/${id}/followups`)).body;
    expect(history.days).toBe(7);
    expect(history.message).toMatch(new RegExp(`^Maria, o orçamento ${String(id).padStart(6, '0')} de R\\$\\s116,70 ainda vale\\. Vendedor - Loja A$`));
  });
});
