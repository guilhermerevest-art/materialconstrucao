import { Router } from 'express';
import type pg from 'pg';
import { z } from 'zod';
import { currentUser, requireAdmin } from '../auth.js';
import type { AppContext } from '../context.js';
import { HttpError } from '../errors.js';
import { queryAs } from '../db/session.js';
import { parseId } from '../lib/validation.js';

const paymentMethodSchema = z.object({
  name: z.string().trim().min(2, 'Informe o nome da forma de pagamento.').max(60, 'Use no máximo 60 caracteres.'),
  active: z.boolean().default(true),
});

const COLUMNS = `pm.id, pm.name, pm.active, pm.created_at,
  (select count(*) from orders o where o.payment_method_id = pm.id) as orders_count`;

const NOT_FOUND = 'Forma de pagamento não encontrada.';

/** Formas que já vêm cadastradas numa lojamestre nova (as mesmas da migração 009). */
export const DEFAULT_PAYMENT_METHODS = ['Dinheiro', 'PIX', 'Cartão de débito', 'Cartão de crédito', 'Boleto'];

/** Precisa rodar no contexto da lojamestre: payment_methods tem RLS. */
export async function insertDefaultPaymentMethods(db: pg.PoolClient, tenantId: number) {
  await db.query('insert into payment_methods (tenant_id, name) select $1, unnest($2::text[])', [
    tenantId,
    DEFAULT_PAYMENT_METHODS,
  ]);
}

/** Cadastro de formas de pagamento. Todos listam (o PDV precisa); só o administrador altera. */
export function paymentMethodsRouter(ctx: AppContext) {
  const router = Router();

  router.get('/', async (req, res) => {
    const { rows } = await queryAs(
      ctx.pool,
      currentUser(req),
      `select ${COLUMNS} from payment_methods pm order by pm.active desc, lower(pm.name)`,
    );
    res.json({ items: rows });
  });

  router.post('/', requireAdmin, async (req, res) => {
    const me = currentUser(req);
    const body = paymentMethodSchema.parse(req.body);
    const { rows } = await queryAs(
      ctx.pool,
      me,
      `with inserted as (insert into payment_methods (tenant_id, name, active) values ($1, $2, $3) returning *)
       select ${COLUMNS} from inserted pm`,
      [me.tenant_id, body.name, body.active],
    );
    res.status(201).json({ payment_method: rows[0] });
  });

  router.put('/:id', requireAdmin, async (req, res) => {
    const id = parseId(req.params.id, NOT_FOUND);
    const body = paymentMethodSchema.parse(req.body);
    const { rows } = await queryAs(
      ctx.pool,
      currentUser(req),
      `with updated as (update payment_methods set name = $2, active = $3 where id = $1 returning *)
       select ${COLUMNS} from updated pm`,
      [id, body.name, body.active],
    );
    if (!rows[0]) throw new HttpError(404, NOT_FOUND);
    res.json({ payment_method: rows[0] });
  });

  router.delete('/:id', requireAdmin, async (req, res) => {
    const id = parseId(req.params.id, NOT_FOUND);
    const { rowCount } = await queryAs(ctx.pool, currentUser(req), 'delete from payment_methods where id = $1', [id]);
    if (!rowCount) throw new HttpError(404, NOT_FOUND);
    res.status(204).end();
  });

  return router;
}
