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
  // Para o financeiro: o que é dinheiro na gaveta, o que é crediário, e em quantas parcelas.
  // Ausentes: na criação valem o padrão (à vista); na edição, ficam como estão.
  kind: z.enum(['cash', 'pix', 'card', 'boleto', 'store_credit', 'fiado', 'other'], 'Tipo inválido.').optional(),
  installments: z.number('Informe as parcelas.').int().min(1, 'No mínimo 1 parcela.').max(48, 'No máximo 48 parcelas.').optional(),
  first_due_days: z.number().int().min(0).max(365, 'O 1º vencimento vai até 365 dias.').optional(),
  interval_days: z.number().int().min(1).max(365).optional(),
});

const COLUMNS = `pm.id, pm.name, pm.active, pm.kind, pm.installments, pm.first_due_days, pm.interval_days, pm.created_at,
  (select count(*) from orders o where o.payment_method_id = pm.id) as orders_count`;

const NOT_FOUND = 'Forma de pagamento não encontrada.';

/** Formas que já vêm cadastradas numa lojamestre nova (as mesmas da migração 009), com o tipo. */
export const DEFAULT_PAYMENT_METHODS: [name: string, kind: string][] = [
  ['Dinheiro', 'cash'],
  ['PIX', 'pix'],
  ['Cartão de débito', 'card'],
  ['Cartão de crédito', 'card'],
  ['Boleto', 'boleto'],
];

/** Precisa rodar no contexto da lojamestre: payment_methods tem RLS. */
export async function insertDefaultPaymentMethods(db: pg.PoolClient, tenantId: number) {
  await db.query('insert into payment_methods (tenant_id, name, kind) select $1, * from unnest($2::text[], $3::text[])', [
    tenantId,
    DEFAULT_PAYMENT_METHODS.map((m) => m[0]),
    DEFAULT_PAYMENT_METHODS.map((m) => m[1]),
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
      `with inserted as (
         insert into payment_methods (tenant_id, name, active, kind, installments, first_due_days, interval_days)
         values ($1, $2, $3, $4, $5, $6, $7) returning *)
       select ${COLUMNS} from inserted pm`,
      [
        me.tenant_id,
        body.name,
        body.active,
        body.kind ?? 'other',
        body.installments ?? 1,
        body.first_due_days ?? 0,
        body.interval_days ?? 30,
      ],
    );
    res.status(201).json({ payment_method: rows[0] });
  });

  router.put('/:id', requireAdmin, async (req, res) => {
    const id = parseId(req.params.id, NOT_FOUND);
    const body = paymentMethodSchema.parse(req.body);
    const { rows } = await queryAs(
      ctx.pool,
      currentUser(req),
      `with updated as (
         update payment_methods
            set name = $2, active = $3, kind = coalesce($4, kind), installments = coalesce($5, installments),
                first_due_days = coalesce($6, first_due_days), interval_days = coalesce($7, interval_days)
          where id = $1 returning *)
       select ${COLUMNS} from updated pm`,
      [id, body.name, body.active, body.kind ?? null, body.installments ?? null, body.first_due_days ?? null, body.interval_days ?? null],
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
