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
    await ownerPool.query(
      `insert into users (name, email, password_hash, role, store_id)
       values ('Administrador', 'admin@empresa.com.br', $1, 'admin', $2)`,
      [await hashPassword('senha-da-v1'), store.rows[0]!.id],
    );

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
  });
});
