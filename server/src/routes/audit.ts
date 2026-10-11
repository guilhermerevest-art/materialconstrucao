import { Router } from 'express';
import type pg from 'pg';
import { z } from 'zod';
import { currentUser } from '../auth.js';
import type { AppContext } from '../context.js';
import { setTenantContext, withSession, withTransaction } from '../db/session.js';
import { optionalQueryId } from '../lib/validation.js';

/** Entrada, senha errada e acesso negado: gravados pela app (o banco não vê o login). */
export async function recordAccess(
  pool: pg.Pool,
  entry: { tenantId: number; userId: number; action: 'login' | 'login_failed'; ip: string | undefined; note?: string },
) {
  try {
    await withTransaction(pool, async (db) => {
      await setTenantContext(db, entry.tenantId);
      await db.query(
        `insert into audit_log (tenant_id, user_id, user_name, area, entity, entity_id, label, action, ip, note)
         select $1, u.id, u.name, 'acesso', 'users', u.id, u.name, $3, $4, $5 from users u where u.id = $2`,
        [entry.tenantId, entry.userId, entry.action, entry.ip ?? null, entry.note ?? null],
      );
    });
  } catch (err) {
    // O registro não pode impedir ninguém de entrar.
    console.error('Falha ao gravar o acesso no registro de alterações:', err);
  }
}

const AREAS = ['produtos', 'estoque', 'pedidos', 'financeiro', 'fiscal', 'clientes', 'usuarios', 'configuracoes', 'acesso'] as const;

const blank = (v: unknown) => (v === '' ? undefined : v);
const dateParam = z.preprocess(blank, z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Data inválida.').optional());

const querySchema = z.object({
  from: dateParam,
  to: dateParam,
  user_id: optionalQueryId,
  store_id: optionalQueryId,
  area: z.preprocess(blank, z.enum(AREAS).optional()),
  q: z.preprocess(blank, z.string().trim().max(100).optional()),
  // Histórico de um produto: cadastro, preços e estoque dele.
  product_id: optionalQueryId,
  entity: z.preprocess(blank, z.string().regex(/^[a-z_]+$/).max(40).optional()),
  entity_id: optionalQueryId,
  before: optionalQueryId,
  limit: z.coerce.number().int().min(1).max(2000).default(100),
});

/** Colunas que guardam o id de um cadastro: na tela aparece o nome. */
const REFERENCES: Record<string, { table: string; column: string }> = {
  store_id: { table: 'stores', column: 'name' },
  other_store_id: { table: 'stores', column: 'name' },
  price_list_id: { table: 'price_lists', column: 'name' },
  client_id: { table: 'clients', column: 'name' },
  supplier_id: { table: 'suppliers', column: 'name' },
  discount_approved_by: { table: 'users', column: 'name' },
  payment_method_id: { table: 'payment_methods', column: 'name' },
};

type Row = {
  id: number;
  created_at: Date;
  user_id: number | null;
  user_name: string | null;
  area: string;
  entity: string;
  entity_id: number | null;
  label: string | null;
  action: string;
  store_id: number | null;
  store_name: string | null;
  changes: Record<string, [unknown, unknown]> | null;
  note: string | null;
  ip: string | null;
};

async function resolveReferences(db: pg.PoolClient, rows: Row[]) {
  const wanted = new Map<string, Set<number>>();
  for (const row of rows) {
    for (const [key, pair] of Object.entries(row.changes ?? {})) {
      const ref = REFERENCES[key];
      if (!ref) continue;
      for (const value of pair) if (typeof value === 'number') (wanted.get(ref.table) ?? wanted.set(ref.table, new Set()).get(ref.table)!).add(value);
    }
  }
  const names = new Map<string, string>();
  for (const [table, ids] of wanted) {
    const ref = Object.values(REFERENCES).find((r) => r.table === table)!;
    const { rows: found } = await db.query<{ id: number; name: string }>(
      `select id, ${ref.column} as name from ${table} where id = any($1::bigint[])`,
      [[...ids]],
    );
    for (const f of found) names.set(`${table}:${f.id}`, f.name);
  }
  for (const row of rows) {
    for (const [key, pair] of Object.entries(row.changes ?? {})) {
      const ref = REFERENCES[key];
      if (!ref) continue;
      row.changes![key] = pair.map((v) => (typeof v === 'number' ? (names.get(`${ref.table}:${v}`) ?? `nº ${v}`) : v)) as [unknown, unknown];
    }
  }
}

/** Registro de alterações: só o administrador consulta; ninguém altera. */
export function auditRouter(ctx: AppContext) {
  const router = Router();

  router.get('/', async (req, res) => {
    const me = currentUser(req);
    const query = querySchema.parse(req.query);
    const where = ['a.tenant_id = $1'];
    const params: unknown[] = [me.tenant_id];
    const tz = ctx.config.timeZone.replaceAll("'", "''");
    const add = (sql: string, value: unknown) => {
      params.push(value);
      where.push(sql.replaceAll('?', `$${params.length}`));
    };
    if (query.from) add(`a.created_at >= (?::date)::timestamp at time zone '${tz}'`, query.from);
    if (query.to) add(`a.created_at < (?::date + 1)::timestamp at time zone '${tz}'`, query.to);
    if (query.user_id) add('a.user_id = ?', query.user_id);
    if (query.store_id) add('a.store_id = ?', query.store_id);
    if (query.area) add('a.area = ?', query.area);
    if (query.q) add(`(search_norm(a.label) like '%' || search_norm(?) || '%' or search_norm(a.note) like '%' || search_norm(?) || '%')`, query.q);
    if (query.product_id) {
      add(`a.entity_id = ? and a.entity in ('products', 'product_price_tiers', 'price_list_items', 'stock_movements')`, query.product_id);
    }
    if (query.entity) add('a.entity = ?', query.entity);
    if (query.entity_id) add('a.entity_id = ?', query.entity_id);
    if (query.before) add('a.id < ?', query.before);
    params.push(query.limit + 1);

    const rows = await withSession(ctx.pool, me, async (db) => {
      const { rows: found } = await db.query<Row>(
        `select a.id, a.created_at, a.user_id, a.user_name, a.area, a.entity, a.entity_id, a.label, a.action,
                a.store_id, s.name as store_name, a.changes, a.note, a.ip
           from audit_log a
           left join stores s on s.id = a.store_id
          where ${where.join(' and ')}
          order by a.id desc
          limit $${params.length}`,
        params,
      );
      await resolveReferences(db, found);
      return found;
    });
    const more = rows.length > query.limit;
    const items = more ? rows.slice(0, query.limit) : rows;
    res.json({ items, next_before: more ? items.at(-1)!.id : null });
  });

  return router;
}
