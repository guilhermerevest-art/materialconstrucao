import { Router } from 'express';
import { z } from 'zod';
import { currentUser } from '../auth.js';
import type { AppContext } from '../context.js';
import { withSession } from '../db/session.js';
import { HttpError } from '../errors.js';
import { optionalQueryId } from '../lib/validation.js';

const dateParam = z.preprocess(
  (v) => (v === '' ? undefined : v),
  z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'Data inválida.')
    .optional(),
);

const querySchema = z.object({
  from: dateParam,
  to: dateParam,
  store_id: optionalQueryId,
  // Pedidos contam pela data de confirmação; orçamentos, pela de criação.
  status: z.preprocess((v) => (v === '' ? undefined : v), z.enum(['quote', 'order']).default('order')),
});

/**
 * Cada relatório agrupa os pedidos filtrados por um cadastro. `key` é a
 * expressão do agrupamento; `select` as colunas além das métricas; `join` o que
 * mais precisa entrar além de orders (alias o).
 */
const GROUPED = {
  dias: {
    select: `to_char(o.ref_date at time zone $tz, 'YYYY-MM-DD') as day`,
    key: `to_char(o.ref_date at time zone $tz, 'YYYY-MM-DD')`,
    join: '',
    order: 'day',
  },
  lojas: {
    select: 's.id, s.name',
    key: 's.id, s.name',
    join: 'join stores s on s.id = o.store_id',
    order: 'total_amount desc, s.name',
  },
  vendedores: {
    select: 'u.id, u.name, s.name as store_name',
    key: 'u.id, u.name, s.name',
    // Admin pode não ter loja: left join para as vendas dele não sumirem.
    join: 'join users u on u.id = o.user_id left join stores s on s.id = u.store_id',
    order: 'total_amount desc, u.name',
  },
  clientes: {
    select: 'c.id, c.name, c.whatsapp, max(o.ref_date) as last_date',
    key: 'c.id, c.name, c.whatsapp',
    join: 'join clients c on c.id = o.client_id',
    order: 'total_amount desc, c.name',
  },
  'formas-de-pagamento': {
    // Nome gravado no pedido: renomear a forma depois não muda o relatório.
    select: `coalesce(o.payment_method_name, 'Não informada') as name`,
    key: `coalesce(o.payment_method_name, 'Não informada')`,
    join: '',
    order: 'total_amount desc, name',
  },
} as const;

type ReportType = keyof typeof GROUPED | 'produtos';
const REPORT_TYPES = [...Object.keys(GROUPED), 'produtos'] as ReportType[];

/**
 * Relatórios por período. Tudo passa por withSession, então o RLS restringe o
 * vendedor à própria loja; o filtro de loja abaixo só deixa isso explícito.
 */
export function reportsRouter(ctx: AppContext) {
  const router = Router();
  const { pool, config } = ctx;

  router.get('/:type', async (req, res) => {
    const type = req.params.type as ReportType;
    if (!REPORT_TYPES.includes(type)) throw new HttpError(404, 'Relatório não encontrado.');
    const user = currentUser(req);
    const query = querySchema.parse(req.query);
    if (query.from && query.to && query.from > query.to) {
      throw new HttpError(400, 'A data inicial precisa ser antes da final.');
    }

    const params: unknown[] = [];
    const param = (value: unknown) => {
      params.push(value);
      return `$${params.length}`;
    };
    // Só entra nos parâmetros se for usado: o Postgres recusa parâmetro sem tipo.
    let tzParam: string | undefined;
    const tz = () => (tzParam ??= param(config.timeZone));
    const refDate = query.status === 'order' ? 'confirmed_at' : 'created_at';

    const where = [`status = ${param(query.status)}`];
    if (user.role === 'seller') where.push(`store_id = ${param(user.store_id)}`);
    else if (query.store_id) where.push(`store_id = ${param(query.store_id)}`);
    if (query.from) where.push(`${refDate} >= (${param(query.from)}::date)::timestamp at time zone ${tz()}`);
    if (query.to) where.push(`${refDate} < (${param(query.to)}::date + 1)::timestamp at time zone ${tz()}`);

    // Pedidos do filtro, com a data de referência num nome só.
    const filtered = `(select *, ${refDate} as ref_date from orders where ${where.join(' and ')}) o`;

    const data = await withSession(pool, user, async (db) => {
      const totals = await db.query(
        `select count(*) as count,
                coalesce(sum(o.total_amount), 0) as total_amount,
                coalesce(sum(o.discount_amount), 0) as discount_amount,
                coalesce(round(avg(o.total_amount), 2), 0) as average_amount
           from ${filtered}`,
        params,
      );

      if (type === 'produtos') {
        // subtotal dos itens é antes do desconto do pedido inteiro.
        const { rows } = await db.query(
          `select i.product_id as id, max(i.product_code) as code, max(i.product_name) as name, i.unit,
                  sum(i.quantity) as quantity,
                  sum(i.subtotal) as total_amount,
                  count(distinct i.order_id) as count
             from ${filtered}
             join order_items i on i.order_id = o.id
            group by i.product_id, i.unit
            order by total_amount desc, name
            limit 500`,
          params,
        );
        return { rows, totals: totals.rows[0] };
      }

      const report = GROUPED[type];
      const withTz = (sql: string) => (sql.includes('$tz') ? sql.replaceAll('$tz', tz()) : sql);
      const select = withTz(report.select);
      const key = withTz(report.key);
      const { rows } = await db.query(
        `select ${select},
                count(*) as count,
                sum(o.total_amount) as total_amount,
                sum(o.discount_amount) as discount_amount,
                round(avg(o.total_amount), 2) as average_amount
           from ${filtered}
           ${report.join}
          group by ${key}
          order by ${report.order}
          limit 500`,
        params,
      );
      return { rows, totals: totals.rows[0] };
    });

    res.json(data);
  });

  return router;
}
