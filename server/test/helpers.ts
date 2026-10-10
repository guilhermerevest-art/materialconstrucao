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

export const PASSWORD = 'kenha-de-teste';
const SLUG = 'parceiro';

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
    // Endereço que não responde: os testes do módulo fiscal trocam pela ACBr API falsa.
    acbr: { url: 'http://127.0.0.1:9', authUrl: 'http://127.0.0.1:9/token', scope: 'empresa nfe cep cnpj', timeoutMs: 3_000 },
  };
}

/** Recria o schema do zero e aplica as migrações (usa o pool admin). */
export async function resetDatabase(_pool: pg.Pool, adminPool?: pg.Pool) {
  const p = adminPool ?? _pool;
  // A app conecta nos testes como oms_app: usuário comum (sem superusuário nem
  // BYPASSRLS), para o RLS valer de verdade.
  await p.query(`
    do $$ begin
      if not exists (select 1 from pg_roles where rolname = 'oms_app') then
        create role oms_app login password 'oms_app' nosuperuser nobypassrls;
      end if;
    end $$`);
  await p.query('drop schema if exists public cascade');
  await p.query('create schema public');
  await runMigrations(p, () => {});
  // Re-aplica os grants depois que as tabelas foram recriadas.
  await p.query(`
    grant usage on schema public to oms_app;
    grant select, insert, update, delete on all tables in schema public to oms_app;
    grant usage, select on all sequences in schema public to oms_app;
  `);
}

export type Fixtures = Awaited<ReturnType<typeof seedFixtures>>;

/**
 * Duas lojas, um admin, um vendedor em cada loja, produtos e um cliente.
 * Tudo dentro de um único lojamestre (SLUG) — os testes legados não precisam
 * de multi-tenant. Para testes multi-tenant, os tests específicos usam
 * `createTenant` abaixo.
 */
export async function seedFixtures(_pool: pg.Pool, adminPool?: pg.Pool) {
  const p = adminPool ?? _pool;
  const hash = await hashPassword(PASSWORD);
  // Cria lojamestre padrão e uma linha de settings para não dar conflito de FK.
  // O índice único de tenants é em lower(slug), então ON CONFLICT precisa casar a expressão.
  const tenant = await p.query<{ id: number }>(
    `insert into tenants (slug, name) values ($1, 'Loja de teste')
     on conflict (lower(slug)) do update set name = excluded.name
     returning id`,
    [SLUG],
  );
  const tid = tenant.rows[0]!.id;
  await p.query('insert into settings (tenant_id) values ($1)', [tid]);

  const stores = await p.query<{ id: number }>(
    `insert into stores (tenant_id, name, address, phone) values
       ($1, 'Loja A', 'Rua A, 1', '(11) 3333-0001'),
       ($1, 'Loja B', 'Rua B, 2', '(11) 3333-0002')
     returning id`,
    [tid],
  );
  const [storeA, storeB] = stores.rows.map((r) => r.id) as [number, number];
  const users = await p.query<{ id: number }>(
    `insert into users (tenant_id, name, username, email, password_hash, role, store_id) values
       ($1, 'Admin', 'admin', 'admin@teste.local', $2, 'admin', null),
       ($1, 'Vendedor A', 'vendedor.a', 'vendedor.a@teste.local', $2, 'seller', $3),
       ($1, 'Vendedor B', 'vendedor.b', 'vendedor.b@teste.local', $2, 'seller', $4)
     returning id`,
    [tid, hash, storeA, storeB],
  );
  const [adminId, sellerAId, sellerBId] = users.rows.map((r) => r.id) as [number, number, number];
  const products = await p.query<{ id: number }>(
    `insert into products (tenant_id, code, name, unit, price) values
       ($1, 'CIM-50', 'Cimento CP II 50 kg', 'SC', 38.90),
       ($1, 'TIJ-8F', 'Tijolo cerâmico 8 furos', 'UN', 1.35),
       ($1, 'ARE-MED', 'Areia média', 'M³', 145.00)
     returning id`,
    [tid],
  );
  const [cimento, tijolo, areia] = products.rows.map((r) => r.id) as [number, number, number];
  const client = await p.query<{ id: number }>(
    `insert into clients (tenant_id, name, whatsapp) values ($1, 'Maria da Silva', '5511987654321') returning id`,
    [tid],
  );
  return {
    tenantId: tid,
    slug: SLUG,
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
  // adminPool conecta como postgres (dono do schema public) para poder dropar
  // e recriar o schema entre os testes. A app conecta com oms_app, sem
  // superuser/bypassrls, para que o RLS seja aplicado de verdade.
  const adminPool = createPool(databaseUrl.replace(/\/\/[^:]+:[^@]+@/, '//postgres:postgres@'));
  const appUrl = databaseUrl.replace(/\/\/[^:]+:[^@]+@/, '//oms_app:oms_app@');
  const pool = createPool(appUrl);
  const app = createApp({ pool, config: testConfig(databaseUrl) });
  return { pool, app, adminPool };
}

export async function login(app: ReturnType<typeof createApp>, username: string) {
  const agent = request.agent(app);
  const res = await agent.post('/api/auth/login').send({
    tenant_slug: SLUG,
    username,
    password: PASSWORD,
  });
  if (res.status !== 200) throw new Error(`login falhou para ${username}: ${res.status} ${JSON.stringify(res.body)}`);
  return agent;
}

export type CapturedRequest = { method: string; url: string; headers: IncomingHttpHeaders; body: any };

/** EvolutionAPI de mentira: registra as requisições e responde com o status configurado. */
export async function startFakeEvolution() {
  const requests: CapturedRequest[] = [];
  let status = 201;
  let responseBody: unknown = { key: { id: 'MSG1' }, status: 'PENDING' };
  // Resposta por rota (método + caminho); o que não casar usa a resposta padrão.
  const routes = new Map<string, { status: number; body: unknown }>();

  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      requests.push({ method: req.method ?? '', url: req.url ?? '', headers: req.headers, body: raw ? JSON.parse(raw) : null });
      const route = routes.get(`${req.method} ${req.url}`);
      res.writeHead(route?.status ?? status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(route ? route.body : responseBody));
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
      routes.clear();
    },
    route(method: string, path: string, nextStatus: number, body: unknown) {
      routes.set(`${method} ${path}`, { status: nextStatus, body });
    },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
type FakeResponse = { status: number; body: unknown; contentType?: string };

/**
 * ACBr API de mentira: token OAuth2 em /token e rotas configuráveis. Registra as
 * requisições (o corpo do token chega em form-urlencoded e fica como texto).
 * Cada conta (client_id + client_secret) recebe tokens próprios; a API registra
 * em `account` de qual conta era o token de cada chamada.
 */
export async function startFakeAcbr() {
  const requests: (CapturedRequest & { account?: string })[] = [];
  const routes = new Map<string, FakeResponse | ((req: CapturedRequest) => FakeResponse)>();
  const clients = new Map<string, string>();
  const tokens = new Map<string, string>();
  let tokenCount = 0;

  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      let body: unknown = raw || null;
      try {
        body = raw ? JSON.parse(raw) : null;
      } catch {
        // form-urlencoded do token
      }
      const url = req.url ?? '';
      const captured: CapturedRequest & { account?: string } = { method: req.method ?? '', url, headers: req.headers, body };
      requests.push(captured);
      if (req.method === 'POST' && url === '/token') {
        const form = new URLSearchParams(raw);
        const clientId = form.get('client_id') ?? '';
        if (!clients.has(clientId) || clients.get(clientId) !== form.get('client_secret')) {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'invalid_client', error_description: 'Invalid client or Invalid client credentials' }));
          return;
        }
        tokenCount += 1;
        const token = `token-${clientId}-${tokenCount}`;
        tokens.set(token, clientId);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ access_token: token, expires_in: 3600, token_type: 'Bearer' }));
        return;
      }
      const account = tokens.get(String(req.headers.authorization ?? '').replace(/^Bearer /, ''));
      if (!account) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'Token inválido' } }));
        return;
      }
      captured.account = account;
      const path = url.split('?')[0];
      const route = routes.get(`${req.method} ${url}`) ?? routes.get(`${req.method} ${path}`);
      const reply = typeof route === 'function' ? route(captured) : (route ?? { status: 404, body: { error: { message: 'Rota não simulada' } } });
      const isBuffer = Buffer.isBuffer(reply.body);
      res.writeHead(reply.status, { 'Content-Type': reply.contentType ?? (isBuffer ? 'application/octet-stream' : 'application/json') });
      res.end(isBuffer ? reply.body : JSON.stringify(reply.body));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  const url = `http://127.0.0.1:${port}`;

  return {
    url,
    config: { url, authUrl: `${url}/token`, scope: 'empresa nfe cep cnpj', timeoutMs: 3_000 },
    requests,
    /** Requisições à API (sem as de token). */
    calls: () => requests.filter((r) => r.url !== '/token'),
    /** Cria uma conta na ACBr API (cada lojamestre tem a sua). */
    registerClient(clientId: string, clientSecret: string) {
      clients.set(clientId, clientSecret);
    },
    route(method: string, path: string, reply: FakeResponse | ((req: CapturedRequest) => FakeResponse)) {
      routes.set(`${method} ${path}`, reply);
    },
    reset() {
      requests.length = 0;
      routes.clear();
    },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
