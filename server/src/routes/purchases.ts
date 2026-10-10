import { Router } from 'express';
import type pg from 'pg';
import { z } from 'zod';
import { currentUser, requireAdmin, type AuthUser } from '../auth.js';
import type { AppContext } from '../context.js';
import { withSession } from '../db/session.js';
import { HttpError } from '../errors.js';
import { describeEvolutionError, keySourceOf, loadEvolutionSettings, sendPdfDocument, sendTextMessage } from '../lib/evolution.js';
import { formatDay, formatQuantity } from '../lib/format.js';
import { normalizeWhatsapp } from '../lib/phone.js';
import { likePattern, optionalQuery, optionalQueryId, optionalText, pagination, parseId } from '../lib/validation.js';
import { purchaseOrderNumber, renderPurchaseOrderPdf, type PurchaseOrderPdfData } from '../pdf/purchaseOrderPdf.js';

const documentDigits = z.preprocess(
  (v) => (typeof v === 'string' ? v.replace(/\D/g, '') || null : (v ?? null)),
  z
    .string()
    .regex(/^(\d{11}|\d{14})$/, 'CNPJ ou CPF incompleto.')
    .nullable(),
);

const supplierSchema = z.object({
  name: z.string('Informe o nome do fornecedor.').trim().min(2, 'Informe o nome do fornecedor.').max(120),
  document: documentDigits,
  contact_name: optionalText(80),
  whatsapp: optionalText(30),
  email: optionalText(120),
  notes: optionalText(500),
  active: z.boolean().default(true),
});

const supplierListSchema = z.object({
  q: optionalQuery,
  status: z.enum(['active', 'inactive', 'all']).default('active'),
  ...pagination,
});

const purchaseSchema = z.object({
  store_id: z.number('Escolha a loja.').int().positive(),
  supplier_id: z.number('Escolha o fornecedor.').int().positive('Escolha o fornecedor.'),
  expected_date: z.iso.date().nullable().default(null),
  notes: optionalText(500),
  items: z
    .array(
      z.object({
        product_id: z.number().int().positive(),
        quantity: z
          .number('Informe a quantidade.')
          .positive('A quantidade precisa ser maior que zero.')
          .max(9_999_999)
          .transform((v) => Math.round(v * 1000) / 1000),
        unit_cost: z
          .number()
          .min(0)
          .max(9_999_999)
          .transform((v) => Math.round(v * 10_000) / 10_000)
          .nullable()
          .default(null),
        // Quantidade e custo na unidade de compra do produto (ex.: sacos); o servidor converte.
        use_purchase_unit: z.boolean().default(false),
      }),
    )
    .min(1, 'O pedido precisa de pelo menos um produto.')
    .max(300),
});

const purchaseListSchema = z.object({
  status: z.enum(['open', 'draft', 'sent', 'partial', 'received', 'cancelled', 'all']).default('open'),
  supplier_id: optionalQueryId,
  store_id: optionalQueryId,
  ...pagination,
});

const reasonSchema = z.object({ reason: z.string('Informe o motivo.').trim().min(3, 'Informe o motivo.').max(200) });

const whatsappSchema = z.object({
  message: optionalText(2000),
  with_pdf: z.boolean().default(true),
});

const SUPPLIER_NOT_FOUND = 'Fornecedor não encontrado.';
const PURCHASE_NOT_FOUND = 'Pedido de compra não encontrado.';

const SUPPLIER_COLUMNS = 'id, name, document, contact_name, whatsapp, email, notes, active, created_at';

function normalizeSupplier(body: z.infer<typeof supplierSchema>) {
  let whatsapp: string | null = null;
  if (body.whatsapp) {
    whatsapp = normalizeWhatsapp(body.whatsapp);
    if (!whatsapp) throw new HttpError(400, 'WhatsApp do fornecedor inválido. Use DDD + número.');
  }
  return { ...body, whatsapp };
}

function duplicateDocument(err: unknown): never {
  if (err && typeof err === 'object' && 'code' in err && err.code === '23505') {
    throw new HttpError(409, 'Já existe um fornecedor com este CNPJ/CPF.');
  }
  throw err;
}

type PurchaseRow = {
  id: number;
  store_id: number;
  store_name: string;
  supplier_id: number;
  supplier_name: string;
  status: 'draft' | 'sent' | 'partial' | 'received' | 'cancelled';
  expected_date: string | null;
  notes: string | null;
  total_amount: number;
  created_at: Date;
  sent_at: Date | null;
  received_at: Date | null;
  closed_short: boolean;
  cancelled_at: Date | null;
  cancel_reason: string | null;
  user_name: string;
};

const PURCHASE_COLUMNS = `po.id, po.store_id, s.name as store_name, po.supplier_id, sp.name as supplier_name,
  sp.document as supplier_document, po.status, po.expected_date,
  po.notes, po.total_amount, po.created_at, po.sent_at, po.received_at, po.closed_short, po.cancelled_at, po.cancel_reason,
  u.name as user_name`;
const PURCHASE_FROM = `purchase_orders po
  join stores s on s.id = po.store_id
  join suppliers sp on sp.id = po.supplier_id
  join users u on u.id = po.user_id`;

async function loadPurchase(db: pg.PoolClient, id: number) {
  const { rows } = await db.query<PurchaseRow>(`select ${PURCHASE_COLUMNS} from ${PURCHASE_FROM} where po.id = $1`, [id]);
  const order = rows[0];
  if (!order) throw new HttpError(404, PURCHASE_NOT_FOUND);
  const { rows: items } = await db.query<{
    id: number;
    product_id: number;
    code: string | null;
    product_name: string;
    unit: string;
    quantity: number;
    unit_cost: number | null;
    received_quantity: number;
    purchase_unit: string | null;
    purchase_factor: number | null;
  }>(
    `select i.id, i.product_id, p.code, i.product_name, i.unit, i.quantity, i.unit_cost, i.received_quantity,
            i.purchase_unit, i.purchase_factor
       from purchase_order_items i join products p on p.id = i.product_id
      where i.purchase_order_id = $1
      order by i.position, i.id`,
    [id],
  );
  const { rows: supplier } = await db.query(`select ${SUPPLIER_COLUMNS} from suppliers where id = $1`, [order.supplier_id]);
  const { rows: entries } = await db.query(
    `select e.id, e.invoice_number, e.invoice_series, e.total_amount, e.created_at, u.name as user_name
       from stock_entries e join users u on u.id = e.user_id
      where e.purchase_order_id = $1
      order by e.created_at`,
    [id],
  );
  const { rows: payables } = await db.query(
    `select id, installment, installments, due_date, amount, paid_amount, status
       from payables where purchase_order_id = $1 and status <> 'cancelled'
      order by due_date, id`,
    [id],
  );
  return { ...order, supplier: supplier[0], items, entries, payables };
}

/**
 * Produtos e custos do pedido: o nome e a unidade ficam gravados como no dia do pedido.
 * Item pedido na unidade de compra (sacos) é convertido para a unidade de venda, e a
 * unidade de compra fica gravada para o fornecedor receber o pedido em sacos.
 */
async function writeItems(db: pg.PoolClient, user: AuthUser, purchaseId: number, items: z.infer<typeof purchaseSchema>['items']) {
  const ids = items.map((i) => i.product_id);
  if (new Set(ids).size !== ids.length) throw new HttpError(400, 'O mesmo produto aparece duas vezes no pedido.');
  const { rows } = await db.query<{ id: number; name: string; purchase_unit: string | null; purchase_factor: number | null }>(
    'select id, name, purchase_unit, purchase_factor from products where id = any($1::bigint[])',
    [ids],
  );
  if (rows.length !== ids.length) throw new HttpError(400, 'Um dos produtos não existe mais. Atualize a página.');
  const products = new Map(rows.map((p) => [p.id, p]));
  const lines = items.map((item) => {
    const product = products.get(item.product_id)!;
    if (!item.use_purchase_unit) return { ...item, purchase_unit: null, purchase_factor: null };
    if (!product.purchase_unit || !product.purchase_factor) {
      throw new HttpError(400, `O produto "${product.name}" não tem unidade de compra cadastrada.`);
    }
    const factor = product.purchase_factor;
    return {
      ...item,
      quantity: Math.round(item.quantity * factor * 1000) / 1000,
      unit_cost: item.unit_cost === null ? null : Math.round((item.unit_cost / factor) * 10_000) / 10_000,
      purchase_unit: product.purchase_unit,
      purchase_factor: factor,
    };
  });
  await db.query('delete from purchase_order_items where purchase_order_id = $1', [purchaseId]);
  await db.query(
    `insert into purchase_order_items (tenant_id, purchase_order_id, product_id, product_name, unit, quantity, unit_cost,
                                       purchase_unit, purchase_factor, position)
     select $1, $2, p.id, p.name, p.unit, c.quantity, c.unit_cost, c.purchase_unit, c.purchase_factor, c.n
       from unnest($3::bigint[], $4::numeric[], $5::numeric[], $6::text[], $7::numeric[])
              with ordinality as c(product_id, quantity, unit_cost, purchase_unit, purchase_factor, n)
       join products p on p.id = c.product_id`,
    [
      user.tenant_id,
      purchaseId,
      ids,
      lines.map((i) => i.quantity),
      lines.map((i) => i.unit_cost),
      lines.map((i) => i.purchase_unit),
      lines.map((i) => i.purchase_factor),
    ],
  );
  // O total sai do que foi digitado (sem o arredondamento do custo por unidade de venda).
  const total = items.reduce((sum, i) => sum + i.quantity * (i.unit_cost ?? 0), 0);
  await db.query('update purchase_orders set total_amount = $2, updated_at = now() where id = $1', [
    purchaseId,
    Math.round(total * 100) / 100,
  ]);
}

async function assertSupplier(db: pg.PoolClient, supplierId: number) {
  const { rows } = await db.query<{ active: boolean }>('select active from suppliers where id = $1', [supplierId]);
  if (!rows[0]) throw new HttpError(400, SUPPLIER_NOT_FOUND);
  if (!rows[0].active) throw new HttpError(400, 'Este fornecedor está inativo.');
}

async function assertStore(db: pg.PoolClient, storeId: number) {
  const { rowCount } = await db.query('select 1 from stores where id = $1', [storeId]);
  if (!rowCount) throw new HttpError(400, 'Loja não encontrada.');
}

/** Mensagem para o fornecedor: a lista do que a loja quer (o PDF vai junto, se quiser). */
function supplierMessage(order: Awaited<ReturnType<typeof loadPurchase>>) {
  const greeting = order.supplier.contact_name ? `Olá, ${String(order.supplier.contact_name).split(/\s+/)[0]}!` : 'Olá!';
  const lines = order.items.map((i) => {
    const amount = i.purchase_unit && i.purchase_factor
      ? `${formatQuantity(Math.round((i.quantity / i.purchase_factor) * 1000) / 1000)} ${i.purchase_unit} (${formatQuantity(i.purchase_factor)} ${i.unit} cada)`
      : `${formatQuantity(i.quantity)} ${i.unit}`;
    return `• ${amount} - ${i.product_name}${i.code ? ` (${i.code})` : ''}`;
  });
  return [
    greeting,
    `Segue o pedido de compra ${purchaseOrderNumber(order.id)} da ${order.store_name}:`,
    '',
    ...lines,
    '',
    order.expected_date ? `Precisamos receber até ${formatDay(order.expected_date)}.` : null,
    order.notes ? `Obs.: ${order.notes}` : null,
    'Pode confirmar o preço e o prazo de entrega? Obrigado!',
  ]
    .filter((l): l is string => l !== null)
    .join('\n');
}

async function pdfData(db: pg.PoolClient, order: Awaited<ReturnType<typeof loadPurchase>>): Promise<PurchaseOrderPdfData> {
  const { rows } = await db.query<{ name: string; address: string | null; phone: string | null }>(
    'select name, address, phone from stores where id = $1',
    [order.store_id],
  );
  return {
    id: order.id,
    created_at: order.created_at,
    expected_date: order.expected_date,
    notes: order.notes,
    total_amount: order.total_amount,
    store: rows[0]!,
    supplier: order.supplier,
    items: order.items,
  };
}

/**
 * Compras: fornecedores, pedido de compra (sugerido pelo que está abaixo do mínimo) e o
 * envio ao fornecedor. O recebimento é a entrada de nota ligada ao pedido. Só o administrador.
 */
export function purchasesRouter(ctx: AppContext) {
  const router = Router();
  const { pool, config } = ctx;
  router.use(['/suppliers', '/purchase-orders'], requireAdmin);

  // ---- Fornecedores

  router.get('/suppliers', async (req, res) => {
    const user = currentUser(req);
    const query = supplierListSchema.parse(req.query);
    const digits = query.q?.replace(/\D/g, '') ?? '';
    const { rows } = await withSession(pool, user, (db) =>
      db.query(
        `select s.id, s.name, s.document, s.contact_name, s.whatsapp, s.email, s.notes, s.active, s.created_at,
                (select count(*) from purchase_orders po where po.supplier_id = s.id and po.status in ('draft', 'sent', 'partial')) as open_orders,
                (select coalesce(sum(p.amount - p.paid_amount), 0) from payables p where p.supplier_id = s.id and p.status = 'open') as open_payables,
                (select max(e.created_at) from stock_entries e where e.supplier_id = s.id) as last_entry_at,
                count(*) over () as total_count
           from suppliers s
          where ($1 = 'all' or s.active = ($1 = 'active'))
            and ($2::text is null or search_norm(s.name) like search_norm($2) or search_norm(coalesce(s.contact_name, '')) like search_norm($2)
                 or ($3::text <> '' and s.document like $3 || '%'))
          order by s.active desc, s.name, s.id
          limit $4 offset $5`,
        [query.status, query.q ? likePattern(query.q) : null, digits, query.page_size, (query.page - 1) * query.page_size],
      ),
    );
    res.json({
      items: rows.map(({ total_count: _, ...row }) => row),
      total: rows[0]?.total_count ?? 0,
      page: query.page,
      page_size: query.page_size,
    });
  });

  router.post('/suppliers', async (req, res) => {
    const user = currentUser(req);
    const body = normalizeSupplier(supplierSchema.parse(req.body));
    const supplier = await withSession(pool, user, (db) =>
      db
        .query(
          `insert into suppliers (tenant_id, name, document, contact_name, whatsapp, email, notes, active)
           values ($1, $2, $3, $4, $5, $6, $7, $8)
           returning ${SUPPLIER_COLUMNS}`,
          [user.tenant_id, body.name, body.document, body.contact_name, body.whatsapp, body.email, body.notes, body.active],
        )
        .catch(duplicateDocument),
    );
    res.status(201).json({ supplier: supplier.rows[0] });
  });

  router.put('/suppliers/:id', async (req, res) => {
    const user = currentUser(req);
    const id = parseId(req.params.id, SUPPLIER_NOT_FOUND);
    const body = normalizeSupplier(supplierSchema.parse(req.body));
    const { rows } = await withSession(pool, user, (db) =>
      db
        .query(
          `update suppliers
              set name = $2, document = $3, contact_name = $4, whatsapp = $5, email = $6, notes = $7, active = $8, updated_at = now()
            where id = $1
            returning ${SUPPLIER_COLUMNS}`,
          [id, body.name, body.document, body.contact_name, body.whatsapp, body.email, body.notes, body.active],
        )
        .catch(duplicateDocument),
    );
    if (!rows[0]) throw new HttpError(404, SUPPLIER_NOT_FOUND);
    res.json({ supplier: rows[0] });
  });

  // ---- Sugestão de compra

  /**
   * O que está abaixo do mínimo na loja, descontado o que já foi pedido e ainda não chegou.
   * Sugere o último fornecedor e o último custo de cada produto.
   */
  router.get('/purchase-orders/suggestions', async (req, res) => {
    const user = currentUser(req);
    const { store_id } = z.object({ store_id: optionalQueryId }).parse(req.query);
    const data = await withSession(pool, user, async (db) => {
      const storeId = store_id ?? user.store_id ?? (await db.query<{ id: number }>('select id from stores order by name limit 1')).rows[0]?.id;
      if (!storeId) throw new HttpError(400, 'Cadastre uma loja primeiro.');
      const { rows } = await db.query(
        `with on_order as (
           select i.product_id, sum(greatest(i.quantity - i.received_quantity, 0)) as quantity
             from purchase_order_items i join purchase_orders po on po.id = i.purchase_order_id
            where po.store_id = $1 and po.status in ('draft', 'sent', 'partial')
            group by i.product_id
         ), below as (
           select p.id as product_id, p.code, p.name, p.unit, b.quantity, b.min_quantity, coalesce(oo.quantity, 0) as on_order,
                  ceil(b.min_quantity - b.quantity - coalesce(oo.quantity, 0)) as suggested, p.cost_price,
                  p.purchase_unit, p.purchase_factor,
                  -- Na unidade de compra, sacos inteiros que cobrem o que falta.
                  case when p.purchase_factor is not null
                    then ceil((b.min_quantity - b.quantity - coalesce(oo.quantity, 0)) / p.purchase_factor) end as suggested_purchase
             from stock_balances b
             join products p on p.id = b.product_id
             left join on_order oo on oo.product_id = p.id
            where b.store_id = $1 and p.active and p.track_stock and b.min_quantity is not null
              and b.quantity < b.min_quantity
         )
         select bl.*, coalesce(ls.unit_cost, bl.cost_price) as unit_cost, sp.id as supplier_id, sp.name as supplier_name
           from below bl
           left join lateral (
             select e.supplier_id, m.unit_cost
               from stock_movements m join stock_entries e on e.id = m.entry_id
              where m.product_id = bl.product_id and m.kind = 'entry' and e.supplier_id is not null
              order by m.created_at desc, m.id desc
              limit 1
           ) ls on true
           left join lateral (
             select s.id from supplier_products x join suppliers s on s.document = x.supplier_document
              where x.product_id = bl.product_id
              order by x.updated_at desc limit 1
           ) mapped on true
           left join suppliers sp on sp.id = coalesce(ls.supplier_id, mapped.id) and sp.active
          where bl.suggested > 0
          order by sp.name nulls last, bl.name`,
        [storeId],
      );
      return { store_id: storeId, items: rows.map(({ cost_price: _, ...row }) => row) };
    });
    res.json(data);
  });

  // ---- Pedidos de compra

  router.get('/purchase-orders', async (req, res) => {
    const user = currentUser(req);
    const query = purchaseListSchema.parse(req.query);
    const { rows } = await withSession(pool, user, (db) =>
      db.query(
        `select ${PURCHASE_COLUMNS},
                (select count(*) from purchase_order_items i where i.purchase_order_id = po.id) as items_count,
                count(*) over () as total_count
           from ${PURCHASE_FROM}
          where ($1 = 'all' or ($1 = 'open' and po.status in ('draft', 'sent', 'partial')) or po.status = $1)
            and ($2::bigint is null or po.supplier_id = $2)
            and ($3::bigint is null or po.store_id = $3)
          order by po.created_at desc, po.id desc
          limit $4 offset $5`,
        [query.status, query.supplier_id ?? null, query.store_id ?? null, query.page_size, (query.page - 1) * query.page_size],
      ),
    );
    res.json({
      items: rows.map(({ total_count: _, ...row }) => row),
      total: rows[0]?.total_count ?? 0,
      page: query.page,
      page_size: query.page_size,
    });
  });

  router.get('/purchase-orders/:id', async (req, res) => {
    const user = currentUser(req);
    const id = parseId(req.params.id, PURCHASE_NOT_FOUND);
    const order = await withSession(pool, user, async (db) => {
      const loaded = await loadPurchase(db, id);
      return { ...loaded, whatsapp_message: supplierMessage(loaded) };
    });
    res.json({ purchase_order: order });
  });

  router.post('/purchase-orders', async (req, res) => {
    const user = currentUser(req);
    const body = purchaseSchema.parse(req.body);
    const order = await withSession(pool, user, async (db) => {
      await assertStore(db, body.store_id);
      await assertSupplier(db, body.supplier_id);
      const { rows } = await db.query<{ id: number }>(
        `insert into purchase_orders (tenant_id, store_id, supplier_id, user_id, expected_date, notes)
         values ($1, $2, $3, $4, $5, $6) returning id`,
        [user.tenant_id, body.store_id, body.supplier_id, user.id, body.expected_date, body.notes],
      );
      await writeItems(db, user, rows[0]!.id, body.items);
      return loadPurchase(db, rows[0]!.id);
    });
    res.status(201).json({ purchase_order: order });
  });

  /** Edita o pedido enquanto nada chegou. */
  router.put('/purchase-orders/:id', async (req, res) => {
    const user = currentUser(req);
    const id = parseId(req.params.id, PURCHASE_NOT_FOUND);
    const body = purchaseSchema.parse(req.body);
    const order = await withSession(pool, user, async (db) => {
      const { rows } = await db.query<{ status: string }>('select status from purchase_orders where id = $1 for update', [id]);
      if (!rows[0]) throw new HttpError(404, PURCHASE_NOT_FOUND);
      if (!['draft', 'sent'].includes(rows[0].status)) {
        throw new HttpError(409, 'Pedido que já começou a chegar (ou foi encerrado) não muda mais.');
      }
      await assertStore(db, body.store_id);
      await assertSupplier(db, body.supplier_id);
      await db.query(
        'update purchase_orders set store_id = $2, supplier_id = $3, expected_date = $4, notes = $5, updated_at = now() where id = $1',
        [id, body.store_id, body.supplier_id, body.expected_date, body.notes],
      );
      await writeItems(db, user, id, body.items);
      return loadPurchase(db, id);
    });
    res.json({ purchase_order: order });
  });

  /** Marca como enviado ao fornecedor (mandado por fora: e-mail, telefone, PDF impresso). */
  router.post('/purchase-orders/:id/sent', async (req, res) => {
    const user = currentUser(req);
    const id = parseId(req.params.id, PURCHASE_NOT_FOUND);
    const order = await withSession(pool, user, async (db) => {
      const { rowCount } = await db.query(
        `update purchase_orders set status = 'sent', sent_at = now(), updated_at = now() where id = $1 and status = 'draft'`,
        [id],
      );
      if (!rowCount) await loadPurchase(db, id); // 404 se não existe; senão já estava enviado
      return loadPurchase(db, id);
    });
    res.json({ purchase_order: order });
  });

  router.post('/purchase-orders/:id/cancel', async (req, res) => {
    const user = currentUser(req);
    const id = parseId(req.params.id, PURCHASE_NOT_FOUND);
    const { reason } = reasonSchema.parse(req.body);
    const order = await withSession(pool, user, async (db) => {
      const { rows } = await db.query<{ status: string }>('select status from purchase_orders where id = $1 for update', [id]);
      if (!rows[0]) throw new HttpError(404, PURCHASE_NOT_FOUND);
      if (!['draft', 'sent'].includes(rows[0].status)) {
        throw new HttpError(409, 'Pedido que já começou a chegar não é cancelado: use "Encerrar" para não esperar o resto.');
      }
      await db.query(
        `update purchase_orders set status = 'cancelled', cancelled_at = now(), cancel_reason = $2, updated_at = now() where id = $1`,
        [id, reason],
      );
      return loadPurchase(db, id);
    });
    res.json({ purchase_order: order });
  });

  /** O fornecedor não vai mandar o resto: o pedido fica recebido com o que chegou. */
  router.post('/purchase-orders/:id/close', async (req, res) => {
    const user = currentUser(req);
    const id = parseId(req.params.id, PURCHASE_NOT_FOUND);
    const { reason } = reasonSchema.parse(req.body);
    const order = await withSession(pool, user, async (db) => {
      const { rows } = await db.query<{ status: string }>('select status from purchase_orders where id = $1 for update', [id]);
      if (!rows[0]) throw new HttpError(404, PURCHASE_NOT_FOUND);
      if (rows[0].status !== 'partial') throw new HttpError(409, 'Só o pedido recebido em parte é encerrado.');
      await db.query(
        `update purchase_orders
            set status = 'received', closed_short = true, received_at = now(), cancel_reason = $2, updated_at = now()
          where id = $1`,
        [id, reason],
      );
      return loadPurchase(db, id);
    });
    res.json({ purchase_order: order });
  });

  router.get('/purchase-orders/:id/pdf', async (req, res) => {
    const user = currentUser(req);
    const id = parseId(req.params.id, PURCHASE_NOT_FOUND);
    const data = await withSession(pool, user, async (db) => pdfData(db, await loadPurchase(db, id)));
    const pdf = await renderPurchaseOrderPdf(data, config.timeZone);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader(
      'Content-Disposition',
      `${req.query.download === '1' ? 'attachment' : 'inline'}; filename="pedido-de-compra-${id}.pdf"`,
    );
    res.setHeader('Cache-Control', 'no-store');
    res.send(pdf);
  });

  /** Manda o pedido pelo WhatsApp da loja ao fornecedor e marca como enviado. */
  router.post('/purchase-orders/:id/whatsapp', async (req, res) => {
    const user = currentUser(req);
    const id = parseId(req.params.id, PURCHASE_NOT_FOUND);
    const body = whatsappSchema.parse(req.body);
    const prepared = await withSession(pool, user, async (db) => {
      const order = await loadPurchase(db, id);
      if (order.status === 'cancelled') throw new HttpError(409, 'Este pedido de compra foi cancelado.');
      return { order, data: await pdfData(db, order), evolution: await loadEvolutionSettings(db, user.tenant_id) };
    });
    if (!prepared.evolution) {
      throw new HttpError(422, 'O envio por WhatsApp ainda não foi configurado. Baixe o PDF e mande pelo celular.', 'WHATSAPP_NOT_CONFIGURED');
    }
    const number = prepared.order.supplier.whatsapp;
    if (!number) throw new HttpError(422, 'Cadastre o WhatsApp do fornecedor para mandar o pedido.', 'WHATSAPP_INVALID_NUMBER');
    const message = body.message ?? supplierMessage(prepared.order);
    try {
      if (body.with_pdf) {
        const pdf = await renderPurchaseOrderPdf(prepared.data, config.timeZone);
        await sendPdfDocument(
          prepared.evolution,
          { number, pdf, fileName: `pedido-de-compra-${id}.pdf`, caption: message },
          config.evolutionTimeoutMs,
        );
      } else {
        await sendTextMessage(prepared.evolution, { number, text: message }, config.evolutionTimeoutMs);
      }
    } catch (err) {
      console.error(`Falha ao mandar o pedido de compra ${id} pela EvolutionAPI:`, err);
      throw new HttpError(502, describeEvolutionError(err, keySourceOf(prepared.evolution, config.evolutionServer)), 'WHATSAPP_FAILED');
    }
    await withSession(pool, user, (db) =>
      db.query(`update purchase_orders set status = 'sent', sent_at = now(), updated_at = now() where id = $1 and status = 'draft'`, [id]),
    );
    res.json({ sent: true });
  });

  return router;
}
