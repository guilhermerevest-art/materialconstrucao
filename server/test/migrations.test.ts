import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type pg from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { hashPassword } from '../src/auth.js';
import { runMigrations } from '../src/db/migrate.js';
import { createPool } from '../src/db/pool.js';
import { TEST_DATABASE_URL, testConfig } from './helpers.js';

const describeDb = TEST_DATABASE_URL ? describe : describe.skip;

const MIGRATIONS_DIR = fileURLToPath(new URL('../migrations/', import.meta.url));
const DB_NAME = 'oms_test_upgrade';

/**
 * Banco igual ao da VPS: o dono é o usuário comum da aplicação (o do
 * TEST_DATABASE_URL), sem superusuário, e já tem os dados da v1, quando o
 * login era por e-mail. As migrações rodam com ele, como no `npm run db:migrate`.
 */
describeDb('atualização do banco da VPS', () => {
  let adminPool: pg.Pool;
  let ownerPool: pg.Pool;
  let ownerUrl: string;

  beforeAll(async () => {
    const owner = new URL(TEST_DATABASE_URL!);
    const admin = new URL(TEST_DATABASE_URL!);
    admin.username = 'postgres';
    admin.password = 'postgres';
    admin.pathname = '/postgres';
    adminPool = createPool(admin.toString());
    await adminPool.query(`drop database if exists ${DB_NAME}`);
    const { rows } = await adminPool.query<{ sql: string }>(`select format('create database %I owner %I', $1::text, $2::text) as sql`, [
      DB_NAME,
      decodeURIComponent(owner.username),
    ]);
    await adminPool.query(rows[0]!.sql);
    owner.pathname = `/${DB_NAME}`;
    ownerUrl = owner.toString();
    ownerPool = createPool(ownerUrl);
  });

  afterAll(async () => {
    await ownerPool?.end();
    await adminPool?.query(`drop database if exists ${DB_NAME}`);
    await adminPool?.end();
  });

  /** Aplica só as migrações da v1 (até a 004), registrando-as como o runner faz. */
  async function migrateToV1(db: pg.Pool) {
    await db.query('create table schema_migrations (version text primary key, applied_at timestamptz not null default now())');
    const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith('.sql') && f < '005').sort();
    for (const file of files) {
      await db.query(await readFile(path.join(MIGRATIONS_DIR, file), 'utf8'));
      await db.query('insert into schema_migrations (version) values ($1)', [file]);
    }
  }

  it('migra com o usuário comum e o admin da v1 entra pela lojamestre "default"', async () => {
    const role = await ownerPool.query('select rolsuper, rolbypassrls from pg_roles where rolname = current_user');
    expect(role.rows[0]).toEqual({ rolsuper: false, rolbypassrls: false });

    await migrateToV1(ownerPool);
    const store = await ownerPool.query<{ id: number }>(`insert into stores (name) values ('Loja Centro') returning id`);
    const storeId = store.rows[0]!.id;
    const hash = await hashPassword('senha-da-v1');
    // Dois e-mails com o mesmo começo: os dois viram "admin" no login por usuário.
    const users = await ownerPool.query<{ id: number }>(
      `insert into users (name, email, password_hash, role, store_id) values
         ('Administrador', 'admin@empresa.com.br', $1, 'admin', $2),
         ('Outro Admin', 'admin@outra.com', $1, 'seller', $2)
       returning id`,
      [hash, storeId],
    );
    const client = await ownerPool.query<{ id: number }>(
      `insert into clients (name, whatsapp) values ('Maria', '5511987654321') returning id`,
    );
    const product = await ownerPool.query<{ id: number }>(
      `insert into products (code, name, unit, price) values ('CIM-50', 'Cimento 50 kg', 'SC', 38.90) returning id`,
    );
    // Pedido da v1: orders tem RLS forçado desde a 001, então só entra com o contexto de admin.
    const db = await ownerPool.connect();
    try {
      await db.query('begin');
      await db.query(`select set_config('app.role', 'admin', true)`);
      const order = await db.query<{ id: number }>(
        `insert into orders (user_id, store_id, client_id, status, total_amount)
         values ($1, $2, $3, 'order', 77.80) returning id`,
        [users.rows[0]!.id, storeId, client.rows[0]!.id],
      );
      await db.query(
        `insert into order_items (order_id, position, product_id, product_code, product_name, unit, quantity, unit_price)
         values ($1, 1, $2, 'CIM-50', 'Cimento 50 kg', 'SC', 2, 38.90)`,
        [order.rows[0]!.id, product.rows[0]!.id],
      );
      await db.query('commit');
    } finally {
      db.release();
    }

    await runMigrations(ownerPool, () => {});

    // A app conecta com o mesmo usuário dono do banco, como na Vercel.
    const app = createApp({ pool: ownerPool, config: testConfig(ownerUrl) });
    const agent = request.agent(app);
    const res = await agent
      .post('/api/auth/login')
      .set('Host', 'materialconstrucao.vercel.app')
      .send({ tenant_slug: 'default', username: 'admin', password: 'senha-da-v1' });
    expect(res.status).toBe(200);
    expect(res.body.user).toMatchObject({ username: 'admin', role: 'admin', store_name: 'Loja Centro' });
    const me = await agent.get('/api/auth/me').set('Host', 'materialconstrucao.vercel.app');
    expect(me.status).toBe(200);

    const orders = await agent.get('/api/orders').set('Host', 'materialconstrucao.vercel.app');
    expect(orders.status).toBe(200);
    expect(orders.body.total).toBe(1);
    const detail = await agent.get(`/api/orders/${orders.body.items[0].id}`).set('Host', 'materialconstrucao.vercel.app');
    expect(detail.body.order.items).toHaveLength(1);
    // Pedido de antes do desconto: subtotal igual ao total, sem desconto.
    expect(detail.body.order).toMatchObject({ subtotal_amount: 77.8, discount_amount: 0, total_amount: 77.8 });

    const list = await agent.get('/api/users').set('Host', 'materialconstrucao.vercel.app');
    expect(list.body.items.map((u: { username: string }) => u.username).sort()).toEqual([
      'admin',
      `admin-${users.rows[1]!.id}`,
    ]);
  });
});
