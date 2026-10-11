import type pg from 'pg';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { createApp } from '../src/app.js';
import { hashPassword } from '../src/auth.js';
import { sealStoredSecrets } from '../src/db/sealSecrets.js';
import { initSecrets, openSecret, sealSecret } from '../src/lib/secrets.js';
import { login, PASSWORD, resetDatabase, seedFixtures, setupApp, testConfig, TEST_DATABASE_URL, type Fixtures } from './helpers.js';

const describeDb = TEST_DATABASE_URL ? describe : describe.skip;

type AuditItem = {
  id: number;
  user_name: string | null;
  area: string;
  entity: string;
  entity_id: number | null;
  label: string | null;
  action: string;
  store_name: string | null;
  changes: Record<string, [unknown, unknown]> | null;
  note: string | null;
  ip: string | null;
};

const JWT_SECRET = testConfig('postgres://x').jwtSecret;
const resetKeys = () => initSecrets({ jwtSecret: JWT_SECRET });

describe('senhas de serviços cifradas', () => {
  afterEach(resetKeys);

  it('cifra com IV novo a cada vez, abre, e recusa valor adulterado', () => {
    resetKeys();
    const a = sealSecret('segredo-da-loja')!;
    const b = sealSecret('segredo-da-loja')!;
    expect(a).toMatch(/^enc:v1:[0-9a-f]{8}:/);
    expect(a).not.toBe(b);
    expect(a).not.toContain('segredo');
    expect(openSecret(a)).toBe('segredo-da-loja');
    expect(openSecret('texto-antigo')).toBe('texto-antigo');
    expect(sealSecret('')).toBeNull();
    const tampered = a.slice(0, -3) + (a.endsWith('A') ? 'BBB' : 'AAA');
    expect(openSecret(tampered)).toBeNull();
  });

  it('SECRETS_KEY nova ainda abre o que foi cifrado com a chave derivada do JWT', () => {
    resetKeys();
    const old = sealSecret('conta-acbr')!;
    initSecrets({ jwtSecret: JWT_SECRET, secretsKey: 'chave-nova-com-mais-de-32-caracteres!!' });
    expect(openSecret(old)).toBe('conta-acbr');
    const fresh = sealSecret('conta-acbr')!;
    expect(fresh.split(':')[2]).not.toBe(old.split(':')[2]);
    // Sem a chave nova, o que foi cifrado com ela não abre (a tela pede de novo).
    resetKeys();
    expect(openSecret(fresh)).toBeNull();
  });
});

describeDb('registro de alterações', () => {
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
    resetKeys();
    await resetDatabase(pool, adminPool);
    f = await seedFixtures(pool, adminPool);
  });

  const audit = async (agent: ReturnType<typeof request.agent>, query: Record<string, unknown> = {}) => {
    const res = await agent.get('/api/audit').query(query);
    expect(res.status).toBe(200);
    return res.body as { items: AuditItem[]; next_before: number | null };
  };

  it('grava a chave da EvolutionAPI e a conta fiscal cifradas, e cifra as antigas no db:migrate', async () => {
    const admin = await login(app, 'admin');
    const saved = await admin
      .put('/api/settings')
      .send({ evolution_api_url: 'http://127.0.0.1:9', evolution_instance: 'loja', evolution_api_token: 'token-secreto-1234' });
    expect(saved.status).toBe(200);
    expect(saved.body.settings).toMatchObject({ has_token: true, token_hint: '••••1234' });
    const raw = await adminPool.query<{ evolution_api_token: string }>('select evolution_api_token from settings where tenant_id = $1', [f.tenantId]);
    expect(raw.rows[0]!.evolution_api_token).toMatch(/^enc:v1:/);
    expect(raw.rows[0]!.evolution_api_token).not.toContain('1234');
    // Em branco mantém a salva.
    const kept = await admin.put('/api/settings').send({ evolution_api_url: 'http://127.0.0.1:9', evolution_instance: 'loja2' });
    expect(kept.body.settings).toMatchObject({ has_token: true, token_hint: '••••1234' });

    // Valor de antes da criptografia: continua funcionando e o migrate cifra.
    await adminPool.query(`update settings set evolution_api_token = 'texto-puro-9876' where tenant_id = $1`, [f.tenantId]);
    await adminPool.query(
      `insert into fiscal_settings (tenant_id, acbr_client_id, acbr_client_secret, nfce_csc_id, nfce_csc) values ($1, 'conta', 'segredo-antigo', '1', 'CSC-ANTIGO-1')`,
      [f.tenantId],
    );
    expect((await admin.get('/api/settings')).body.settings).toMatchObject({ token_hint: '••••9876' });
    const before = (await audit(admin)).items.length;
    expect(await sealStoredSecrets(adminPool)).toBe(3);
    expect(await sealStoredSecrets(adminPool)).toBe(0);
    const sealed = await adminPool.query<{ token: string; secret: string; csc: string }>(
      `select s.evolution_api_token as token, f.acbr_client_secret as secret, f.nfce_csc as csc
         from settings s join fiscal_settings f using (tenant_id) where s.tenant_id = $1`,
      [f.tenantId],
    );
    for (const value of Object.values(sealed.rows[0]!)) expect(value).toMatch(/^enc:v1:/);
    expect((await admin.get('/api/settings')).body.settings).toMatchObject({ token_hint: '••••9876' });
    expect((await admin.get('/api/fiscal/settings')).body.settings).toMatchObject({
      acbr_client_secret_hint: '••••tigo',
      nfce_csc_hint: '••••GO-1',
    });
    // Cifrar o que já existia não aparece como alteração.
    expect((await audit(admin)).items.length).toBe(before);

    // Troca de chave: o migrate cifra de novo com a nova.
    initSecrets({ jwtSecret: JWT_SECRET, secretsKey: 'chave-nova-com-mais-de-32-caracteres!!' });
    expect(await sealStoredSecrets(adminPool)).toBe(3);
    // Quem não tem a chave nova não abre: a tela mostra que falta a chave.
    resetKeys();
    expect((await admin.get('/api/settings')).body.settings).toMatchObject({ has_token: false, token_hint: null });
  });

  it('produto, estoque, pedido, usuário e configuração ficam no registro, sem senha', async () => {
    const admin = await login(app, 'admin');
    const seller = await login(app, 'vendedor.a');

    const product = await admin
      .put(`/api/products/${f.products.cimento}`)
      .send({ code: 'CIM-50', name: 'Cimento CP II 50 kg', unit: 'SC', price: 41.5, active: true });
    expect(product.status).toBe(200);

    await admin.post('/api/stock/adjustments').send({
      store_id: f.storeA,
      note: 'Saco rasgado',
      items: [{ product_id: f.products.cimento, mode: 'delta', quantity: -2 }],
    });
    await admin.post('/api/stock/transfers').send({
      from_store_id: f.storeA,
      to_store_id: f.storeB,
      items: [{ product_id: f.products.tijolo, quantity: 30 }],
    });

    const order = await seller
      .post('/api/orders')
      .send({ client_id: f.clientId, status: 'order', items: [{ product_id: f.products.areia, quantity: 1 }] });
    expect(order.status).toBe(201);
    expect((await admin.post(`/api/orders/${order.body.order.id}/cancel`).send({ reason: 'Cliente desistiu' })).status).toBe(200);

    const users = (await admin.get('/api/users')).body.items as { id: number; username: string }[];
    const b = users.find((u) => u.username === 'vendedor.b')!;
    const reset = await admin.put(`/api/users/${b.id}`).send({ ...b, name: 'Vendedor B', role: 'seller', store_id: f.storeB, password: 'senha-nova-123' });
    expect(reset.status).toBe(200);

    await admin
      .put('/api/settings')
      .send({ evolution_api_url: 'http://127.0.0.1:9', evolution_instance: 'loja', evolution_api_token: 'token-secreto-1234' });

    const { items } = await audit(admin);
    const find = (entity: string, action: string) => items.find((i) => i.entity === entity && i.action === action);

    expect(find('products', 'update')).toMatchObject({
      user_name: 'Admin',
      area: 'produtos',
      label: 'Cimento CP II 50 kg',
      changes: { price: [38.9, 41.5] },
    });
    expect(find('stock_movements', 'adjust')).toMatchObject({
      area: 'estoque',
      entity_id: f.products.cimento,
      store_name: 'Loja A',
      note: 'Saco rasgado',
      changes: { quantity: [null, -2] },
    });
    expect(find('stock_movements', 'transfer')).toMatchObject({ label: 'Tijolo cerâmico 8 furos', changes: { other_store_id: [null, 'Loja B'] } });
    expect(find('orders', 'cancel')).toMatchObject({
      user_name: 'Admin',
      area: 'pedidos',
      label: `Pedido nº ${String(order.body.order.id).padStart(6, '0')}`,
      changes: { status: ['order', 'cancelled'], cancel_reason: [null, 'Cliente desistiu'] },
    });
    // Criar o pedido e as parcelas canceladas junto não viram linhas soltas.
    expect(items.filter((i) => i.entity === 'orders')).toHaveLength(1);
    expect(items.some((i) => i.entity === 'receivables')).toBe(false);
    expect(find('users', 'update')).toMatchObject({ area: 'usuarios', label: 'Vendedor B', changes: { password_hash: ['•••', '•••'] } });
    expect(find('settings', 'update')).toMatchObject({ area: 'configuracoes', changes: { evolution_api_token: [null, '•••'] } });

    // Nenhuma senha ou chave aparece no registro, nem cifrada.
    const raw = await adminPool.query<{ text: string }>('select changes::text as text from audit_log where changes is not null');
    const all = raw.rows.map((r) => r.text).join('\n');
    expect(all).not.toMatch(/\$2[aby]\$|enc:v1:|token-secreto/);

    // Filtros: histórico do produto, área, busca e usuário.
    const history = await audit(admin, { product_id: f.products.cimento });
    // O cadastro (create) veio da carga inicial dos testes.
    expect(history.items.map((i) => i.action).sort()).toEqual(['adjust', 'create', 'update']);
    expect((await audit(admin, { area: 'pedidos' })).items).toHaveLength(1);
    expect((await audit(admin, { q: 'rasgado' })).items).toHaveLength(1);
    const byAdmin = (await audit(admin, { user_id: f.adminId })).items;
    expect(byAdmin.length).toBeGreaterThan(0);
    expect(byAdmin.every((i) => i.user_name === 'Admin')).toBe(true);
    const page = await audit(admin, { limit: 2 });
    expect(page.items).toHaveLength(2);
    const next = await audit(admin, { limit: 2, before: page.next_before });
    expect(next.items[0]!.id).toBeLessThan(page.items[1]!.id);

    // Só o administrador consulta.
    expect((await seller.get('/api/audit')).status).toBe(403);
  });

  it('desconto liberado com a senha de outro; montar e confirmar orçamento não entra', async () => {
    const admin = await login(app, 'admin');
    const seller = await login(app, 'vendedor.a');
    await admin.put('/api/sales-settings').send({ max_discount_percent: 5, default_markup_percent: null });
    const items = [{ product_id: f.products.cimento, quantity: 10 }];
    const approved = await seller.post('/api/orders').send({
      client_id: f.clientId,
      status: 'order',
      items,
      discount_type: 'percent',
      discount_value: 10,
      discount_approval: { username: 'admin', password: PASSWORD },
    });
    expect(approved.status).toBe(201);

    const quote = await seller.post('/api/orders').send({ client_id: f.clientId, status: 'quote', items });
    const edited = await seller
      .put(`/api/orders/${quote.body.order.id}`)
      .send({ client_id: f.clientId, status: 'order', items: [{ product_id: f.products.cimento, quantity: 12 }] });
    expect(edited.status).toBe(200);

    const orders = (await audit(admin, { area: 'pedidos' })).items;
    expect(orders).toHaveLength(1);
    expect(orders[0]).toMatchObject({
      user_name: 'Vendedor A',
      action: 'discount',
      entity_id: approved.body.order.id,
      changes: { discount_approved_by: [null, 'Admin'], discount_approved_percent: [null, 10] },
    });
  });

  it('entrada e senha errada com o IP; o suporte aparece como suporte', async () => {
    await login(app, 'vendedor.a');
    const wrong = await request(app).post('/api/auth/login').send({ tenant_slug: f.slug, username: 'vendedor.a', password: 'errada-123' });
    expect(wrong.status).toBe(401);
    const admin = await login(app, 'admin');
    const access = (await audit(admin, { area: 'acesso' })).items;
    expect(access.map((i) => [i.label, i.action])).toEqual([
      ['Admin', 'login'],
      ['Vendedor A', 'login_failed'],
      ['Vendedor A', 'login'],
    ]);
    expect(access[1]).toMatchObject({ note: 'Senha errada.' });
    expect(access[1]!.ip).toBeTruthy();

    await adminPool.query(
      'insert into super_admins (id, email, password_hash) overriding system value values ($1, $2, $3)',
      [f.adminId, 'super@teste.local', await hashPassword(PASSWORD)],
    );
    const sup = request.agent(app);
    expect((await sup.post('/api/super/login').send({ email: 'super@teste.local', password: PASSWORD })).status).toBe(200);
    expect((await sup.post('/api/super/rename-admin').send({ tenant_id: f.tenantId, user_id: f.sellerBId, username: 'joana' })).status).toBe(204);
    expect((await audit(admin, { area: 'usuarios' })).items[0]).toMatchObject({
      user_name: 'Suporte (revenda)',
      changes: { username: ['vendedor.b', 'joana'] },
    });
  });

  it('ninguém altera nem apaga o registro, e cada lojamestre vê só o seu', async () => {
    const admin = await login(app, 'admin');
    await admin.put(`/api/products/${f.products.areia}`).send({ name: 'Areia média lavada', unit: 'M³', price: 150, active: true });

    // A app (sem política de alteração) não enxerga linhas para mudar.
    const appUpdate = await pool.query(`update audit_log set note = 'apagado'`);
    expect(appUpdate.rowCount).toBe(0);
    const appDelete = await pool.query('delete from audit_log');
    expect(appDelete.rowCount).toBe(0);
    // Nem o dono do banco.
    await expect(adminPool.query(`update audit_log set note = 'apagado'`)).rejects.toThrow(/não pode ser alterado/);
    await expect(adminPool.query('delete from audit_log')).rejects.toThrow(/não pode ser alterado/);
    await expect(adminPool.query('truncate audit_log')).rejects.toThrow(/não pode ser alterado/);

    const other = await adminPool.query<{ id: number }>(`insert into tenants (slug, name) values ('outra', 'Outra') returning id`);
    await adminPool.query('insert into settings (tenant_id) values ($1)', [other.rows[0]!.id]);
    await adminPool.query(
      `insert into users (tenant_id, name, username, password_hash, role) values ($1, 'Dona', 'dona', $2, 'admin')`,
      [other.rows[0]!.id, await hashPassword(PASSWORD)],
    );
    const agent = request.agent(app);
    expect((await agent.post('/api/auth/login').send({ tenant_slug: 'outra', username: 'dona', password: PASSWORD })).status).toBe(200);
    const theirs = (await audit(agent)).items;
    expect(theirs.length).toBeGreaterThan(0);
    expect(theirs.every((i) => i.label !== 'Areia média lavada')).toBe(true);
  });
});
