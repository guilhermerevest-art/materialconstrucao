import { Router } from 'express';
import { currentUser } from '../auth.js';
import type { AppContext } from '../context.js';
import { withSession } from '../db/session.js';

// Início do dia no fuso da loja, como timestamptz.
const TODAY_START = `(date_trunc('day', now() at time zone $1) at time zone $1)`;

/**
 * Resumo da tela inicial. Admin vê a rede inteira e o quadro por loja;
 * vendedor vê só os próprios números.
 */
export function dashboardRouter(ctx: AppContext) {
  const router = Router();

  router.get('/', async (req, res) => {
    const user = currentUser(req);
    const onlyUserId = user.role === 'seller' ? user.id : null;
    const tz = ctx.config.timeZone;

    const data = await withSession(ctx.pool, user, async (db) => {
      const summary = await db.query(
        `select
           count(*) filter (where status = 'order' and confirmed_at >= ${TODAY_START}) as orders_today,
           coalesce(sum(total_amount) filter (where status = 'order' and confirmed_at >= ${TODAY_START}), 0) as orders_today_amount,
           count(*) filter (where status = 'quote' and created_at >= ${TODAY_START}) as quotes_today,
           count(*) filter (where status = 'quote') as open_quotes,
           coalesce(sum(total_amount) filter (where status = 'quote'), 0) as open_quotes_amount
         from orders
         where ($2::bigint is null or user_id = $2)
           and (created_at >= ${TODAY_START} - interval '30 days' or confirmed_at >= ${TODAY_START})`,
        [tz, onlyUserId],
      );

      const recent = await db.query(
        `select o.id, o.status, o.cancelled_from, o.total_amount, o.created_at, o.sent_at,
                c.name as client_name, s.name as store_name, u.name as user_name
           from orders o
           join clients c on c.id = o.client_id
           join stores s on s.id = o.store_id
           join users u on u.id = o.user_id
          where ($1::bigint is null or o.user_id = $1)
          order by o.created_at desc, o.id desc
          limit 8`,
        [onlyUserId],
      );

      const byStore =
        user.role === 'admin'
          ? (
              await db.query(
                `select s.id, s.name,
                        count(o.id) filter (where o.status = 'order' and o.confirmed_at >= ${TODAY_START}) as orders_today,
                        coalesce(sum(o.total_amount) filter (where o.status = 'order' and o.confirmed_at >= ${TODAY_START}), 0) as orders_today_amount,
                        count(o.id) filter (where o.status = 'quote' and o.created_at >= ${TODAY_START}) as quotes_today
                   from stores s
                   left join orders o
                     on o.store_id = s.id
                    and (o.created_at >= ${TODAY_START} or o.confirmed_at >= ${TODAY_START})
                  group by s.id, s.name
                  order by s.name`,
                [tz],
              )
            ).rows
          : [];

      return { summary: summary.rows[0], recent: recent.rows, by_store: byStore };
    });

    res.json(data);
  });

  return router;
}
