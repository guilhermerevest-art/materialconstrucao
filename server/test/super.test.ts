import type pg from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { createApp } from '../src/app.js';
import { hashPassword } from '../src/auth.js';
import { login, PASSWORD, resetDatabase, seedFixtures, setupApp, TEST_DATABASE_URL, type Fixtures } from './helpers.js';

const describeDb = TEST_DATABASE_URL ? describe : describe.skip;

const SUPER_EMAIL = 'super@teste.local';
const SUPER_PASSWORD = 'senha-do-super-123';

describeDb('lojamestres e painel /super', () => {
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
    // Mesmo id do admin da lojamestre: as duas sessões têm o mesmo "sub".
    await adminPool.query(
      'insert into super_admins (id, email, password_hash) overriding system value values ($1, $2, $3)',
      [f.adminId, SUPER_EMAIL, await hashPassword(SUPER_PASSWORD)],
    );
  });

  async function loginSuper() {
    const agent = request.agent(app);
    const res = await agent.post('/api/super/login').send({ email: SUPER_EMAIL, password: SUPER_PASSWORD });
    expect(res.status).toBe(200);
    return agent;
  }

  function sessionToken(res: request.Response) {
    const cookies = ([] as string[]).concat(res.headers['set-cookie'] ?? []);
    return cookies.find((c) => c.startsWith('oms_session='))!.split(';')[0]!.slice('oms_session='.length);
  }

  it('cria lojamestre pelo /super e o admin dela entra só nela', async () => {
    const sup = await loginSuper();
    const created = await sup.post('/api/super/tenants').send({
      slug: 'nova',
      name: 'Loja Nova',
      admin_name: 'Dona da Nova',
      admin_username: 'admin',
      admin_password: 'senha-da-nova-1',
    });
    expect(created.status).toBe(201);

    const list = await sup.get('/api/super/tenants');
    expect(list.status).toBe(200);
    expect(list.body.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ slug: 'nova', stores_count: 0, users_count: 1 }),
        expect.objectContaining({ slug: f.slug, stores_count: 2, users_count: 3 }),
      ]),
    );

    // "admin" existe nas duas lojamestres; cada senha só entra na sua.
    const agent = request.agent(app);
    const ok = await agent
      .post('/api/auth/login')
      .send({ tenant_slug: 'nova', username: 'admin', password: 'senha-da-nova-1' });
    expect(ok.status).toBe(200);
    expect(ok.body.user).toMatchObject({ name: 'Dona da Nova', tenant_id: created.body.tenant.id });
    const crossed = await request(app)
      .post('/api/auth/login')
      .send({ tenant_slug: f.slug, username: 'admin', password: 'senha-da-nova-1' });
    expect(crossed.status).toBe(401);

    const users = await agent.get('/api/users');
    expect(users.status).toBe(200);
    expect(users.body.items.map((u: { username: string }) => u.username)).toEqual(['admin']);
    expect((await agent.get('/api/stores')).body.items).toEqual([]);
    // Formas de pagamento mais comuns já vêm cadastradas.
    const methods = await agent.get('/api/payment-methods');
    expect(methods.body.items.map((m: { name: string }) => m.name)).toEqual(
      expect.arrayContaining(['Dinheiro', 'PIX', 'Cartão de débito', 'Cartão de crédito', 'Boleto']),
    );
  });

  it('recusa lojamestre inexistente ou desativada', async () => {
    const unknown = await request(app)
      .post('/api/auth/login')
      .send({ tenant_slug: 'nao-existe', username: 'admin', password: PASSWORD });
    expect(unknown.status).toBe(401);

    await adminPool.query('update tenants set active = false where id = $1', [f.tenantId]);
    const inactive = await request(app)
      .post('/api/auth/login')
      .send({ tenant_slug: f.slug, username: 'admin', password: PASSWORD });
    expect(inactive.status).toBe(403);
  });

  it('a sessão continua valendo num domínio *.vercel.app', async () => {
    const agent = request.agent(app);
    const res = await agent
      .post('/api/auth/login')
      .set('Host', 'materialconstrucao.vercel.app')
      .send({ tenant_slug: f.slug, username: 'admin', password: PASSWORD });
    expect(res.status).toBe(200);
    const me = await agent.get('/api/auth/me').set('Host', 'materialconstrucao.vercel.app');
    expect(me.status).toBe(200);
    expect((await agent.get('/api/orders').set('Host', 'materialconstrucao.vercel.app')).status).toBe(200);
  });

  it('a sessão de usuário não vale como sessão de super admin, nem o contrário', async () => {
    const userLogin = await request(app)
      .post('/api/auth/login')
      .send({ tenant_slug: f.slug, username: 'admin', password: PASSWORD });
    expect(userLogin.status).toBe(200);
    const asSuper = await request(app)
      .get('/api/super/tenants')
      .set('Cookie', `oms_super_session=${sessionToken(userLogin)}`);
    expect(asSuper.status).toBe(401);

    const superLogin = await request(app).post('/api/super/login').send({ email: SUPER_EMAIL, password: SUPER_PASSWORD });
    const superToken = ([] as string[])
      .concat(superLogin.headers['set-cookie'] ?? [])
      .find((c) => c.startsWith('oms_super_session='))!
      .split(';')[0]!
      .slice('oms_super_session='.length);
    const asUser = await request(app).get('/api/auth/me').set('Cookie', `oms_session=${superToken}`);
    expect(asUser.status).toBe(401);
  });

  it('renomeia o admin de uma lojamestre', async () => {
    const sup = await loginSuper();
    const dup = await sup
      .post('/api/super/rename-admin')
      .send({ tenant_id: f.tenantId, user_id: f.adminId, username: 'vendedor.a' });
    expect(dup.status).toBe(409);
    const wrongTenant = await sup
      .post('/api/super/rename-admin')
      .send({ tenant_id: f.tenantId + 100, user_id: f.adminId, username: 'gerente' });
    expect(wrongTenant.status).toBe(404);

    const res = await sup
      .post('/api/super/rename-admin')
      .send({ tenant_id: f.tenantId, user_id: f.adminId, username: 'gerente' });
    expect(res.status).toBe(204);
    await login(app, 'gerente');
  });
  it('lojamestre com domínio próprio: login sem informar a lojamestre', async () => {
    const sup = await loginSuper();
    const created = await sup.post('/api/super/tenants').send({
      slug: 'joao',
      name: 'Loja do João',
      admin_name: 'João',
      admin_username: 'admin',
      admin_password: 'senha-do-joao-1',
      domains: ['https://Pedidos.LojaDoJoao.com.br/login', ''],
    });
    expect(created.status).toBe(201);

    const list = await sup.get('/api/super/tenants');
    expect(list.body.items.find((t: { slug: string }) => t.slug === 'joao').domains).toEqual([
      'pedidos.lojadojoao.com.br',
    ]);

    const host = 'pedidos.lojadojoao.com.br';
    expect((await request(app).get('/api/auth/tenant').set('Host', host)).body).toEqual({
      tenant: { name: 'Loja do João' },
    });
    expect((await request(app).get('/api/auth/tenant').set('Host', `www.${host}:443`)).body.tenant).toEqual({
      name: 'Loja do João',
    });
    expect((await request(app).get('/api/auth/tenant').set('Host', 'materialconstrucao.vercel.app')).body).toEqual({
      tenant: null,
    });

    // No domínio próprio, vale a lojamestre dele, mesmo se o corpo trouxer outra.
    const agent = request.agent(app);
    const ok = await agent.post('/api/auth/login').set('Host', host).send({ username: 'admin', password: 'senha-do-joao-1' });
    expect(ok.status).toBe(200);
    expect(ok.body.user.tenant_id).toBe(created.body.tenant.id);
    expect((await agent.get('/api/auth/me').set('Host', host)).status).toBe(200);
    const forced = await request(app)
      .post('/api/auth/login')
      .set('Host', host)
      .send({ tenant_slug: f.slug, username: 'admin', password: PASSWORD });
    expect(forced.status).toBe(401);
    expect(forced.body.error).toBe('Usuário ou senha incorretos.');

    // No endereço geral, sem domínio próprio, a lojamestre continua obrigatória.
    const noSlug = await request(app).post('/api/auth/login').send({ username: 'admin', password: PASSWORD });
    expect(noSlug.status).toBe(400);
  });

  it('edita os domínios e recusa domínio inválido ou de outra lojamestre', async () => {
    const sup = await loginSuper();
    const put = (id: number, domains: string[]) =>
      sup.put(`/api/super/tenants/${id}`).send({ slug: f.slug, name: 'Loja de teste', active: true, domains });

    const saved = await put(f.tenantId, ['parceiro.com.br', 'pedidos.parceiro.com.br', 'PARCEIRO.com.br']);
    expect(saved.status).toBe(200);
    expect(saved.body.tenant.domains).toEqual(['parceiro.com.br', 'pedidos.parceiro.com.br']);

    const other = await sup.post('/api/super/tenants').send({
      slug: 'outra',
      name: 'Outra Loja',
      admin_name: 'Fulano',
      admin_username: 'admin',
      admin_password: 'senha-da-outra-1',
      domains: ['parceiro.com.br'],
    });
    expect(other.status).toBe(409);
    expect(other.body.error).toContain('Loja de teste');

    expect((await put(f.tenantId, ['não é domínio'])).status).toBe(400);
    expect((await put(f.tenantId + 100, ['x.com.br'])).status).toBe(404);

    expect((await put(f.tenantId, [])).body.tenant.domains).toEqual([]);
    expect((await request(app).get('/api/auth/tenant').set('Host', 'parceiro.com.br')).body.tenant).toBeNull();
  });

  it('edita nome, slug e situação; desativar derruba as sessões abertas', async () => {
    const sup = await loginSuper();
    const put = (id: number, body: Record<string, unknown>) =>
      sup.put(`/api/super/tenants/${id}`).send({ slug: f.slug, name: 'Loja de teste', active: true, domains: [], ...body });
    const loginAs = (slug: string) =>
      request.agent(app).post('/api/auth/login').send({ tenant_slug: slug, username: 'admin', password: PASSWORD });

    const other = await sup.post('/api/super/tenants').send({
      slug: 'outra',
      name: 'Outra Loja',
      admin_name: 'Fulano',
      admin_username: 'admin',
      admin_password: 'senha-da-outra-1',
    });
    expect(other.status).toBe(201);
    expect((await put(f.tenantId, { slug: 'OUTRA' })).status).toBe(409);
    expect((await put(f.tenantId, { slug: 'com espaço' })).status).toBe(400);
    expect((await put(f.tenantId, { name: '' })).status).toBe(400);
    expect((await put(f.tenantId + 100, {})).status).toBe(404);

    const seller = await login(app, 'vendedor.a');
    const renamed = await put(f.tenantId, { slug: 'Parceiro-Novo', name: 'Parceiro Novo' });
    expect(renamed.status).toBe(200);
    expect(renamed.body.tenant).toMatchObject({ id: f.tenantId, slug: 'parceiro-novo', name: 'Parceiro Novo', active: true });
    // O login pelo endereço geral passa a usar o slug novo; quem já estava dentro continua.
    expect((await loginAs(f.slug)).status).toBe(401);
    expect((await loginAs('parceiro-novo')).status).toBe(200);
    expect((await seller.get('/api/auth/me')).status).toBe(200);

    const deactivated = await put(f.tenantId, { slug: 'parceiro-novo', name: 'Parceiro Novo', active: false });
    expect(deactivated.status).toBe(200);
    expect((await seller.get('/api/auth/me')).status).toBe(401);
    expect((await seller.get('/api/orders')).status).toBe(401);
    expect((await loginAs('parceiro-novo')).status).toBe(403);
    // A outra lojamestre não é afetada.
    expect((await loginAs('outra')).status).toBe(401);
    const otherAdmin = await request(app)
      .post('/api/auth/login')
      .send({ tenant_slug: 'outra', username: 'admin', password: 'senha-da-outra-1' });
    expect(otherAdmin.status).toBe(200);

    const list = await sup.get('/api/super/tenants');
    expect(list.body.items.find((t: { id: number }) => t.id === f.tenantId)).toMatchObject({
      slug: 'parceiro-novo',
      name: 'Parceiro Novo',
      active: false,
    });

    expect((await put(f.tenantId, { slug: 'parceiro-novo', active: true })).status).toBe(200);
    expect((await loginAs('parceiro-novo')).status).toBe(200);
  });
});
