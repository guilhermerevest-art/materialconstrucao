import { createServer, type IncomingHttpHeaders } from 'node:http';
import type { AddressInfo } from 'node:net';
import type pg from 'pg';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { hashPassword } from '../src/auth.js';
import { loadEnvFile, type Config } from '../src/config.js';
import { runMigrations } from '../src/db/migrate.js';
import { createPool } from '../src/db/pool.js';

loadEnvFile();
export const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;

export const PASSWORD = 'senha-de-teste';

export function testConfig(databaseUrl: string): Config {
  return {
    env: 'test',
    port: 0,
    databaseUrl,
    jwtSecret: 'segredo-de-teste-com-pelo-menos-32-caracteres',
    cookieSecure: false,
    trustProxy: false,
    timeZone: 'America/Sao_Paulo',
    evolutionTimeoutMs: 3_000,
    webDistDir: '/caminho/inexistente',
  };
}

/** Recria o schema do zero e aplica as migrações. */
export async function resetDatabase(pool: pg.Pool) {
  await pool.query('drop schema if exists public cascade');
  await pool.query('create schema public');
  await runMigrations(pool, () => {});
}

export type Fixtures = Awaited<ReturnType<typeof seedFixtures>>;

/** Duas lojas, um admin, um vendedor em cada loja, produtos e um cliente. */
export async function seedFixtures(pool: pg.Pool) {
  const hash = await hashPassword(PASSWORD);
  const stores = await pool.query<{ id: number }>(
    `insert into stores (name, address, phone) values
       ('Loja A', 'Rua A, 1', '(11) 3333-0001'),
       ('Loja B', 'Rua B, 2', '(11) 3333-0002')
     returning id`,
  );
  const [storeA, storeB] = stores.rows.map((r) => r.id) as [number, number];
  const users = await pool.query<{ id: number }>(
    `insert into users (name, email, password_hash, role, store_id) values
       ('Admin', 'admin@teste.local', $1, 'admin', null),
       ('Vendedor A', 'vendedor.a@teste.local', $1, 'seller', $2),
       ('Vendedor B', 'vendedor.b@teste.local', $1, 'seller', $3)
     returning id`,
    [hash, storeA, storeB],
  );
  const [adminId, sellerAId, sellerBId] = users.rows.map((r) => r.id) as [number, number, number];
  const products = await pool.query<{ id: number }>(
    `insert into products (code, name, unit, price) values
       ('CIM-50', 'Cimento CP II 50 kg', 'SC', 38.90),
       ('TIJ-8F', 'Tijolo cerâmico 8 furos', 'UN', 1.35),
       ('ARE-MED', 'Areia média', 'M³', 145.00)
     returning id`,
  );
  const [cimento, tijolo, areia] = products.rows.map((r) => r.id) as [number, number, number];
  const client = await pool.query<{ id: number }>(
    `insert into clients (name, whatsapp) values ('Maria da Silva', '5511987654321') returning id`,
  );
  return {
    storeA,
    storeB,
    adminId,
    sellerAId,
    sellerBId,
    products: { cimento, tijolo, areia },
    clientId: client.rows[0]!.id,
  };
}

export function setupApp(databaseUrl: string) {
  const pool = createPool(databaseUrl);
  const app = createApp({ pool, config: testConfig(databaseUrl) });
  return { pool, app };
}

export async function login(app: ReturnType<typeof createApp>, email: string) {
  const agent = request.agent(app);
  const res = await agent.post('/api/auth/login').send({ email, password: PASSWORD });
  if (res.status !== 200) throw new Error(`login falhou para ${email}: ${res.status} ${JSON.stringify(res.body)}`);
  return agent;
}

export type CapturedRequest = { method: string; url: string; headers: IncomingHttpHeaders; body: any };

/** EvolutionAPI de mentira: registra as requisições e responde com o status configurado. */
export async function startFakeEvolution() {
  const requests: CapturedRequest[] = [];
  let status = 201;
  let responseBody: unknown = { key: { id: 'MSG1' }, status: 'PENDING' };

  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      requests.push({ method: req.method ?? '', url: req.url ?? '', headers: req.headers, body: raw ? JSON.parse(raw) : null });
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(responseBody));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    respondWith(nextStatus: number, body: unknown) {
      status = nextStatus;
      responseBody = body;
    },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
