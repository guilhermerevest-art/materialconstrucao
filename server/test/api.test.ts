import type pg from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { createApp } from '../src/app.js';
import { withSession } from '../src/db/session.js';
import {
  login,
  PASSWORD,
  resetDatabase,
  seedFixtures,
  setupApp,
  startFakeEvolution,
  TEST_DATABASE_URL,
  type Fixtures,
} from './helpers.js';

const describeDb = TEST_DATABASE_URL ? describe : describe.skip;

describeDb('API com banco de teste', () => {
  let pool: pg.Pool;
  let adminPool: pg.Pool;
  let app: ReturnType<typeof createApp>;
  let f: Fixtures;
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
    f = await seedFixtures(pool, adminPool);
    evolution.requests.length = 0;
    evolution.respondWith(201, { key: { id: 'MSG1' }, status: 'PENDING' });
  });

  /** Pedido com 3 itens: 3 x 38,90 + 10 x 1,35 + 2,5 x 145,00 = 492,70 */
  async function createThreeItemOrder(agent: ReturnType<typeof request.agent>, status: 'quote' | 'order' = 'quote') {
    return agent.post('/api/orders').send({
      client_id: f.clientId,
      status,
      notes: 'Entregar pela manhã',
      items: [
        { product_id: f.products.cimento, quantity: 3 },
        { product_id: f.products.tijolo, quantity: 10 },
        { product_id: f.products.areia, quantity: 2.5 },
      ],
    });
  }

  async function configureEvolution(admin: ReturnType<typeof request.agent>) {
    const res = await admin.put('/api/settings').send({
      evolution_api_url: `${evolution.url}/`,
      evolution_instance: 'loja centro',
      evolution_api_token: 'token-secreto-1234',
    });
    expect(res.status).toBe(200);
  }

  describe('autenticação', () => {
    it('recusa senha errada e aceita a correta', async () => {
      const wrong = await request(app)
        .post('/api/auth/login')
        .send({ tenant_slug: f.slug, username: 'vendedor.a', password: 'x' });
      expect(wrong.status).toBe(401);

      const agent = request.agent(app);
      const ok = await agent
        .post('/api/auth/login')
        .send({ tenant_slug: f.slug, username: 'VENDEDOR.A', password: PASSWORD });
      expect(ok.status).toBe(200);
      expect(ok.body.user).toMatchObject({ role: 'seller', store_id: f.storeA, store_name: 'Loja A' });
      expect(ok.headers['set-cookie']?.[0]).toMatch(/oms_session=.*HttpOnly/);

      const me = await agent.get('/api/auth/me');
      expect(me.status).toBe(200);
      expect(me.body.user.email).toBe('vendedor.a@teste.local');
    });

    it('bloqueia o login depois de 10 senhas erradas seguidas', async () => {
      for (let i = 0; i < 10; i++) {
        const res = await request(app)
          .post('/api/auth/login')
          .send({ tenant_slug: f.slug, username: 'vendedor.a', password: 'errada' });
        expect(res.status).toBe(401);
      }
      const blocked = await request(app)
        .post('/api/auth/login')
        .send({ tenant_slug: f.slug, username: 'vendedor.a', password: PASSWORD });
      expect(blocked.status).toBe(429);
      // Outro usuário no mesmo computador continua entrando.
      const other = await request(app)
        .post('/api/auth/login')
        .send({ tenant_slug: f.slug, username: 'vendedor.b', password: PASSWORD });
      expect(other.status).toBe(200);
    });

    it('exige login nas rotas protegidas', async () => {
      const res = await request(app).get('/api/orders');
      expect(res.status).toBe(401);
    });

    it('derruba a sessão quando o admin desativa o usuário', async () => {
      const seller = await login(app, 'vendedor.a');
      const admin = await login(app, 'admin');
      const res = await admin.put(`/api/users/${f.sellerAId}`).send({
        name: 'Vendedor A',
        username: 'vendedor.a',
        email: 'vendedor.a@teste.local',
        role: 'seller',
        store_id: f.storeA,
        active: false,
      });
      expect(res.status).toBe(200);
      expect((await seller.get('/api/auth/me')).status).toBe(401);
    });

    it('troca a senha e mantém a sessão atual', async () => {
      const seller = await login(app, 'vendedor.a');
      const res = await seller
        .post('/api/auth/change-password')
        .send({ current_password: PASSWORD, new_password: 'nova-senha-123' });
      expect(res.status).toBe(204);
      expect((await seller.get('/api/auth/me')).status).toBe(200);
      const old = await request(app)
        .post('/api/auth/login')
        .send({ tenant_slug: f.slug, username: 'vendedor.a', password: PASSWORD });
      expect(old.status).toBe(401);
    });
  });

  describe('pedidos', () => {
    it('cria orçamento com 3 itens e calcula o total no servidor', async () => {
      const seller = await login(app, 'vendedor.a');
      const res = await createThreeItemOrder(seller);
      expect(res.status).toBe(201);
      const order = res.body.order;
      expect(order).toMatchObject({
        status: 'quote',
        store_id: f.storeA,
        user_id: f.sellerAId,
        client_name: 'Maria da Silva',
        total_amount: 492.7,
        confirmed_at: null,
      });
      expect(order.items.map((i: any) => [i.product_code, i.quantity, i.unit_price, i.subtotal])).toEqual([
        ['CIM-50', 3, 38.9, 116.7],
        ['TIJ-8F', 10, 1.35, 13.5],
        ['ARE-MED', 2.5, 145, 362.5],
      ]);
    });

    it('ignora preço enviado pelo navegador', async () => {
      const seller = await login(app, 'vendedor.a');
      const res = await seller.post('/api/orders').send({
        client_id: f.clientId,
        status: 'order',
        items: [{ product_id: f.products.cimento, quantity: 1, unit_price: 0.01 }],
      });
      expect(res.status).toBe(201);
      expect(res.body.order.total_amount).toBe(38.9);
      expect(res.body.order.confirmed_at).not.toBeNull();
    });

    it('valida cliente e itens', async () => {
      const seller = await login(app, 'vendedor.a');
      const noItems = await seller.post('/api/orders').send({ client_id: f.clientId, status: 'quote', items: [] });
      expect(noItems.status).toBe(400);
      expect(noItems.body.error).toBe('Adicione pelo menos um produto.');

      const noClient = await seller
        .post('/api/orders')
        .send({ client_id: 999999, status: 'quote', items: [{ product_id: f.products.cimento, quantity: 1 }] });
      expect(noClient.status).toBe(400);
    });

    it('edição de orçamento mantém o preço original dos itens já lançados', async () => {
      const seller = await login(app, 'vendedor.a');
      const created = await createThreeItemOrder(seller);
      const id = created.body.order.id;
      await pool.query('update products set price = 50 where id = $1', [f.products.cimento]);

      const edited = await seller.put(`/api/orders/${id}`).send({
        client_id: f.clientId,
        status: 'quote',
        items: [
          { product_id: f.products.cimento, quantity: 4 },
          { product_id: f.products.tijolo, quantity: 10 },
        ],
      });
      expect(edited.status).toBe(200);
      expect(edited.body.order.items[0]).toMatchObject({ unit_price: 38.9, subtotal: 155.6 });
      expect(edited.body.order.total_amount).toBe(169.1);
    });

    it('converte orçamento em pedido e bloqueia edição depois', async () => {
      const seller = await login(app, 'vendedor.a');
      const id = (await createThreeItemOrder(seller)).body.order.id;

      const converted = await seller.post(`/api/orders/${id}/convert`);
      expect(converted.status).toBe(200);
      expect(converted.body.order.status).toBe('order');
      expect(converted.body.order.confirmed_at).not.toBeNull();

      expect((await seller.post(`/api/orders/${id}/convert`)).status).toBe(409);
      const edit = await seller
        .put(`/api/orders/${id}`)
        .send({ client_id: f.clientId, status: 'order', items: [{ product_id: f.products.cimento, quantity: 1 }] });
      expect(edit.status).toBe(409);
    });

    it('filtra a listagem por status e cliente', async () => {
      const seller = await login(app, 'vendedor.a');
      await createThreeItemOrder(seller, 'quote');
      await createThreeItemOrder(seller, 'order');

      const quotes = await seller.get('/api/orders').query({ status: 'quote' });
      expect(quotes.body.total).toBe(1);
      expect(quotes.body.items[0].status).toBe('quote');

      const byClient = await seller.get('/api/orders').query({ q: 'maria' });
      expect(byClient.body.total).toBe(2);
      const none = await seller.get('/api/orders').query({ q: 'joão' });
      expect(none.body.total).toBe(0);
    });

    it('só o admin exclui pedidos', async () => {
      const seller = await login(app, 'vendedor.a');
      const id = (await createThreeItemOrder(seller)).body.order.id;
      expect((await seller.delete(`/api/orders/${id}`)).status).toBe(403);
      const admin = await login(app, 'admin');
      expect((await admin.delete(`/api/orders/${id}`)).status).toBe(204);
      expect((await admin.get(`/api/orders/${id}`)).status).toBe(404);
    });
  });

  describe('isolamento entre lojas (critério 4)', () => {
    it('vendedor da Loja B não vê nem altera pedidos da Loja A', async () => {
      const sellerA = await login(app, 'vendedor.a');
      const id = (await createThreeItemOrder(sellerA)).body.order.id;
      const sellerB = await login(app, 'vendedor.b');

      expect((await sellerB.get(`/api/orders/${id}`)).status).toBe(404);
      expect((await sellerB.get(`/api/orders/${id}/pdf`)).status).toBe(404);
      expect((await sellerB.post(`/api/orders/${id}/convert`)).status).toBe(404);
      expect((await sellerB.post(`/api/orders/${id}/whatsapp`)).status).toBe(404);
      const edit = await sellerB
        .put(`/api/orders/${id}`)
        .send({ client_id: f.clientId, status: 'quote', items: [{ product_id: f.products.cimento, quantity: 1 }] });
      expect(edit.status).toBe(404);

      const list = await sellerB.get('/api/orders');
      expect(list.body.total).toBe(0);
      // Filtro de loja na query string não fura o isolamento.
      const forced = await sellerB.get('/api/orders').query({ store_id: f.storeA });
      expect(forced.body.total).toBe(0);
      const dashboard = await sellerB.get('/api/dashboard');
      expect(dashboard.body.recent).toHaveLength(0);
    });

    it('vendedor não consegue lançar pedido em outra loja', async () => {
      const sellerB = await login(app, 'vendedor.b');
      const res = await sellerB.post('/api/orders').send({
        client_id: f.clientId,
        status: 'quote',
        store_id: f.storeA,
        items: [{ product_id: f.products.cimento, quantity: 1 }],
      });
      expect(res.status).toBe(201);
      expect(res.body.order.store_id).toBe(f.storeB);
    });

    it('admin vê pedidos de todas as lojas', async () => {
      await createThreeItemOrder(await login(app, 'vendedor.a'));
      await createThreeItemOrder(await login(app, 'vendedor.b'));
      const admin = await login(app, 'admin');
      const all = await admin.get('/api/orders');
      expect(all.body.total).toBe(2);
      const onlyA = await admin.get('/api/orders').query({ store_id: f.storeA });
      expect(onlyA.body.total).toBe(1);
    });

    it('o próprio banco (RLS) esconde pedidos de outra loja', async () => {
      const sellerA = await login(app, 'vendedor.a');
      await createThreeItemOrder(sellerA);

      const sellerB = { id: f.sellerBId, tenant_id: f.tenantId, role: 'seller' as const, store_id: f.storeB };
      const seen = await withSession(pool, sellerB, async (db) => {
        const orders = await db.query('select id from orders');
        const items = await db.query('select id from order_items');
        return { orders: orders.rowCount, items: items.rowCount };
      });
      expect(seen).toEqual({ orders: 0, items: 0 });

      // Sem contexto de sessão nada aparece.
      const raw = await pool.query('select count(*) as total from orders');
      expect(raw.rows[0].total).toBe(0);

      // Inserir pedido em outra loja é barrado pela política.
      await expect(
        withSession(pool, sellerB, (db) =>
          db.query(`insert into orders (user_id, store_id, client_id, status) values ($1, $2, $3, 'quote')`, [
            f.sellerBId,
            f.storeA,
            f.clientId,
          ]),
        ),
      ).rejects.toThrow(/row-level security/);
    });
  });

  describe('PDF e WhatsApp (critérios 2 e 3)', () => {
    it('gera o PDF do pedido', async () => {
      const seller = await login(app, 'vendedor.a');
      const id = (await createThreeItemOrder(seller)).body.order.id;
      const res = await seller
        .get(`/api/orders/${id}/pdf`)
        .buffer(true)
        .parse((response, callback) => {
          const chunks: Buffer[] = [];
          response.on('data', (chunk: Buffer) => chunks.push(chunk));
          response.on('end', () => callback(null, Buffer.concat(chunks)));
        });
      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toBe('application/pdf');
      expect(res.headers['content-disposition']).toContain(`orcamento-${String(id).padStart(6, '0')}.pdf`);
      expect((res.body as Buffer).subarray(0, 5).toString()).toBe('%PDF-');
    });

    it('avisa quando a EvolutionAPI não está configurada', async () => {
      const seller = await login(app, 'vendedor.a');
      const id = (await createThreeItemOrder(seller)).body.order.id;
      const res = await seller.post(`/api/orders/${id}/whatsapp`);
      expect(res.status).toBe(422);
      expect(res.body.code).toBe('WHATSAPP_NOT_CONFIGURED');
    });

    it('envia o PDF para a EvolutionAPI com o payload esperado', async () => {
      const admin = await login(app, 'admin');
      await configureEvolution(admin);
      const seller = await login(app, 'vendedor.a');
      const id = (await createThreeItemOrder(seller)).body.order.id;

      const res = await seller.post(`/api/orders/${id}/whatsapp`);
      expect(res.status).toBe(200);
      expect(res.body.sent_at).toBeTruthy();

      expect(evolution.requests).toHaveLength(1);
      const sent = evolution.requests[0]!;
      expect(sent.method).toBe('POST');
      expect(sent.url).toBe('/message/sendMedia/loja%20centro');
      expect(sent.headers.apikey).toBe('token-secreto-1234');
      expect(sent.body).toMatchObject({
        number: '5511987654321',
        mediatype: 'document',
        mimetype: 'application/pdf',
        fileName: `orcamento-${String(id).padStart(6, '0')}.pdf`,
      });
      expect(Buffer.from(sent.body.media, 'base64').subarray(0, 5).toString()).toBe('%PDF-');
      expect(sent.body.caption).toContain('Olá, Maria!');
      expect(sent.body.caption).toContain('R$');

      const detail = await seller.get(`/api/orders/${id}`);
      expect(detail.body.order.sent_at).toBeTruthy();
    });

    it('responde 502 com o motivo quando a EvolutionAPI falha', async () => {
      const admin = await login(app, 'admin');
      await configureEvolution(admin);
      evolution.respondWith(400, {
        status: 400,
        error: 'Bad Request',
        response: { message: [{ exists: false, jid: '5511987654321@s.whatsapp.net', number: '5511987654321' }] },
      });
      const seller = await login(app, 'vendedor.a');
      const id = (await createThreeItemOrder(seller)).body.order.id;

      const res = await seller.post(`/api/orders/${id}/whatsapp`);
      expect(res.status).toBe(502);
      expect(res.body.code).toBe('WHATSAPP_FAILED');
      expect(res.body.error).toBe('Este número não tem WhatsApp. Confira o cadastro do cliente.');
      expect((await seller.get(`/api/orders/${id}`)).body.order.sent_at).toBeNull();
    });

    it('não devolve a API Key inteira para o navegador', async () => {
      const admin = await login(app, 'admin');
      await configureEvolution(admin);
      const res = await admin.get('/api/settings');
      expect(res.body.settings).toEqual(
        expect.objectContaining({
          evolution_api_url: evolution.url,
          evolution_instance: 'loja centro',
          has_token: true,
          token_hint: '••••1234',
        }),
      );
      expect(JSON.stringify(res.body)).not.toContain('token-secreto');
    });
  });

  describe('permissões e cadastros', () => {
    it('vendedor não acessa telas de administração', async () => {
      const seller = await login(app, 'vendedor.a');
      expect((await seller.get('/api/settings')).status).toBe(403);
      expect((await seller.get('/api/users')).status).toBe(403);
      expect((await seller.get('/api/stores')).status).toBe(403);
      expect((await seller.post('/api/products').send({ name: 'X', unit: 'UN', price: 1 })).status).toBe(403);
    });

    it('cadastra cliente com WhatsApp higienizado e recusa número inválido', async () => {
      const seller = await login(app, 'vendedor.a');
      const ok = await seller.post('/api/clients').send({ name: 'João Souza', whatsapp: '(21) 99876-5432' });
      expect(ok.status).toBe(201);
      expect(ok.body.client.whatsapp).toBe('5521998765432');

      const bad = await seller.post('/api/clients').send({ name: 'Sem DDD', whatsapp: '99876-5432' });
      expect(bad.status).toBe(400);
      expect(bad.body.error).toMatch(/WhatsApp inválido/);

      const search = await seller.get('/api/clients').query({ q: 'joao' });
      expect(search.body.items.map((c: any) => c.name)).toEqual(['João Souza']);
      const byPhone = await seller.get('/api/clients').query({ q: '99876' });
      expect(byPhone.body.items.map((c: any) => c.name)).toEqual(['João Souza']);
    });

    it('busca produto por código exato ou nome sem acento', async () => {
      const seller = await login(app, 'vendedor.a');
      const byCode = await seller.get('/api/products').query({ q: 'tij-8f' });
      expect(byCode.body.items[0].code).toBe('TIJ-8F');
      const byName = await seller.get('/api/products').query({ q: 'areia media' });
      expect(byName.body.items.map((p: any) => p.code)).toEqual(['ARE-MED']);
    });

    it('não exclui produto usado em pedido e explica o motivo', async () => {
      await createThreeItemOrder(await login(app, 'vendedor.a'));
      const admin = await login(app, 'admin');
      const res = await admin.delete(`/api/products/${f.products.cimento}`);
      expect(res.status).toBe(409);
      expect(res.body.error).toMatch(/Desative-o/);
    });

    it('não deixa o admin tirar o próprio acesso', async () => {
      const admin = await login(app, 'admin');
      const res = await admin
        .put(`/api/users/${f.adminId}`)
        .send({ name: 'Admin', username: 'admin', email: 'admin@teste.local', role: 'seller', store_id: f.storeA, active: true });
      expect(res.status).toBe(400);
    });

    it('exige loja para vendedor', async () => {
      const admin = await login(app, 'admin');
      const res = await admin
        .post('/api/users')
        .send({ name: 'Sem Loja', username: 'semloja', email: 'semloja@teste.local', role: 'seller', password: 'senha-123' });
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('Selecione a loja do vendedor.');
    });
  });

  describe('logo da loja', () => {
    /** 1x1 PNG transparente em base64 (8 bytes decodificados). */
    const tinyPng = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

    it('PUT com PNG valido salva a logo e devolve has_logo true', async () => {
      const admin = await login(app, 'admin');
      const res = await admin.put(`/api/stores/${f.storeA}/logo`).send({ data: tinyPng, mime: 'image/png' });
      expect(res.status).toBe(200);
      expect(res.body.store.has_logo).toBe(true);
    });

    it('GET /stores/:id/logo devolve mime e data exatamente como foram enviados', async () => {
      const admin = await login(app, 'admin');
      await admin.put(`/api/stores/${f.storeA}/logo`).send({ data: tinyPng, mime: 'image/png' });

      const res = await admin.get(`/api/stores/${f.storeA}/logo`);
      expect(res.status).toBe(200);
      expect(res.body.mime).toBe('image/png');
      expect(res.body.data).toBe(tinyPng);
    });

    it('PUT com mime fora da lista devolve 400', async () => {
      const admin = await login(app, 'admin');
      const res = await admin.put(`/api/stores/${f.storeA}/logo`).send({ data: tinyPng, mime: 'image/gif' });
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/não aceito/);
    });

    it('PUT com base64 malformado devolve 400', async () => {
      const admin = await login(app, 'admin');
      const res = await admin.put(`/api/stores/${f.storeA}/logo`).send({ data: 'não-é-base64!@#$', mime: 'image/png' });
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/base64/);
    });

    it('PUT com imagem acima de 500 KB devolve 400', async () => {
      const admin = await login(app, 'admin');
      // Gera mais de 500 KB em bytes decodificados para estourar o limite.
      const huge = Buffer.alloc(501 * 1024, 'A').toString('base64');
      const res = await admin.put(`/api/stores/${f.storeA}/logo`).send({ data: huge, mime: 'image/png' });
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/500 KB/);
    });

    it('DELETE /stores/:id/logo devolve 204 e GET subsequente devolve 404', async () => {
      const admin = await login(app, 'admin');
      await admin.put(`/api/stores/${f.storeA}/logo`).send({ data: tinyPng, mime: 'image/png' });

      const del = await admin.delete(`/api/stores/${f.storeA}/logo`);
      expect(del.status).toBe(204);

      const get = await admin.get(`/api/stores/${f.storeA}/logo`);
      expect(get.status).toBe(404);
    });

    it('GET /stores (listagem) traz has_logo true e NAO traz logo_data', async () => {
      const admin = await login(app, 'admin');
      await admin.put(`/api/stores/${f.storeA}/logo`).send({ data: tinyPng, mime: 'image/png' });

      const list = await admin.get('/api/stores');
      expect(list.status).toBe(200);
      const store = list.body.items.find((s: any) => s.id === f.storeA);
      expect(store.has_logo).toBe(true);
      expect(store.logo_data).toBeUndefined();
    });

    it('rota de loja inexistente devolve 404, nao 500', async () => {
      const admin = await login(app, 'admin');
      const res = await admin.put('/api/stores/999999/logo').send({ data: tinyPng, mime: 'image/png' });
      expect(res.status).toBe(404);
    });
  });

  describe('WhatsApp único por cliente', () => {
    async function totalClientes() {
      // adminPool é o dono do schema e bypassa RLS; pool é oms_app, que vê só
      // o próprio tenant — útil para checar que o insert foi bloqueado.
      const { rows } = await adminPool.query<{ total: number }>('select count(*)::int as total from clients');
      return rows[0]!.total;
    }

    it('recusa cadastrar um WhatsApp que já pertence a outro cliente', async () => {
      const seller = await login(app, 'vendedor.a');
      const before = await totalClientes();

      const res = await seller.post('/api/clients').send({ name: 'Marcos', whatsapp: '5511987654321' });
      expect(res.status).toBe(409);
      expect(res.body).toMatchObject({ error: 'Este WhatsApp já está cadastrado.', code: 'whatsapp_duplicado' });
      expect(res.body.conflicts).toEqual([
        { id: f.clientId, name: 'Maria da Silva', whatsapp: '5511987654321', created_at: expect.any(String) },
      ]);
      expect(Object.keys(res.body.conflicts[0]).sort()).toEqual(['created_at', 'id', 'name', 'whatsapp']);
      // A recusa acontece antes do insert: nada foi gravado.
      expect(await totalClientes()).toBe(before);
    });

    it('continua cadastrando quem tem WhatsApp livre', async () => {
      const seller = await login(app, 'vendedor.a');
      const res = await seller.post('/api/clients').send({ name: 'Marcos', whatsapp: '(34) 99711-1276' });
      expect(res.status).toBe(201);
      expect(res.body.client).toMatchObject({ name: 'Marcos', whatsapp: '5534997111276' });
      expect(await totalClientes()).toBe(2);
    });

    it('recusa editar para o WhatsApp de outro cliente e aponta quem é o dono', async () => {
      const seller = await login(app, 'vendedor.a');
      const outro = await seller.post('/api/clients').send({ name: 'Marcos', whatsapp: '5534997111276' });
      expect(outro.status).toBe(201);

      const res = await seller
        .put(`/api/clients/${f.clientId}`)
        .send({ name: 'Maria da Silva', whatsapp: '+55 34 99711 1276' });
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('whatsapp_duplicado');
      expect(res.body.conflicts).toEqual([
        { id: outro.body.client.id, name: 'Marcos', whatsapp: '5534997111276', created_at: expect.any(String) },
      ]);
      // O cadastro original continua com o número dele.
      const kept = await seller.get(`/api/clients/${f.clientId}`);
      expect(kept.body.client.whatsapp).toBe('5511987654321');
    });

    it('deixa editar o nome sem apagar o próprio WhatsApp', async () => {
      const seller = await login(app, 'vendedor.a');
      const res = await seller.put(`/api/clients/${f.clientId}`).send({ name: 'Maria Souza', whatsapp: '5511987654321' });
      expect(res.status).toBe(200);
      expect(res.body.client).toMatchObject({ id: f.clientId, name: 'Maria Souza', whatsapp: '5511987654321' });
    });

    it('deixa trocar para um WhatsApp livre', async () => {
      const seller = await login(app, 'vendedor.a');
      const res = await seller
        .put(`/api/clients/${f.clientId}`)
        .send({ name: 'Maria da Silva', whatsapp: '(34) 99711-1276' });
      expect(res.status).toBe(200);
      expect(res.body.client).toMatchObject({ id: f.clientId, whatsapp: '5534997111276' });
    });

    it('trata duas formas do mesmo número como o mesmo cliente', async () => {
      const seller = await login(app, 'vendedor.a');
      expect((await seller.post('/api/clients').send({ name: 'Marcos', whatsapp: '5534997111276' })).status).toBe(201);

      const res = await seller.post('/api/clients').send({ name: 'Marcos outro', whatsapp: '(34) 99711-1276' });
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('whatsapp_duplicado');
      expect(res.body.conflicts).toHaveLength(1);
      expect(res.body.conflicts[0].whatsapp).toBe('5534997111276');
      expect(await totalClientes()).toBe(2);
    });

    it('editar um id inexistente responde 404 mesmo com o número de outra pessoa', async () => {
      const seller = await login(app, 'vendedor.a');
      const before = await totalClientes();

      const res = await seller.put('/api/clients/999999').send({ name: 'Fantasma', whatsapp: '5511987654321' });
      expect(res.status).toBe(404);
      expect(res.body.code).toBeUndefined();
      expect(await totalClientes()).toBe(before);
    });
  });
});
