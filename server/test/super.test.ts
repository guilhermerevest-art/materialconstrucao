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
});
