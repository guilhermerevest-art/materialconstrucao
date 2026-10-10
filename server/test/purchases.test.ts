import type pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { createApp } from '../src/app.js';
import { login, resetDatabase, seedFixtures, setupApp, TEST_DATABASE_URL, type Fixtures } from './helpers.js';

const describeDb = TEST_DATABASE_URL ? describe : describe.skip;

describeDb('compras e contas a pagar', () => {
  let pool: pg.Pool;
  let adminPool: pg.Pool;
  let app: ReturnType<typeof createApp>;
  let f: Fixtures;

  beforeAll(() => {
    ({ pool, app, adminPool } = setupApp(TEST_DATABASE_URL!));
  });

  afterAll(async () => {
    await pool?.end();
    await adminPool?.end();
  });

  beforeEach(async () => {
    await resetDatabase(pool, adminPool);
    f = await seedFixtures(pool, adminPool);
  });

  const entry = (extra: Record<string, unknown>, items: { product_id: number; quantity: number; unit_cost?: number }[]) => ({
    store_id: f.storeA,
    items: items.map((i) => ({ unit_cost: null, ...i })),
    ...extra,
  });

  it('fornecedor: a nota cria pelo CNPJ e a próxima reaproveita; vendedor não entra', async () => {
    const admin = await login(app, 'admin');
    const first = await admin
      .post('/api/stock/entries')
      .send(entry({ supplier_name: 'Votorantim', supplier_document: '12.345.678/0001-90', invoice_number: '100' }, [
        { product_id: f.products.cimento, quantity: 50, unit_cost: 30 },
      ]));
    expect(first.status).toBe(201);
    await admin
      .post('/api/stock/entries')
      .send(entry({ supplier_name: 'VOTORANTIM CIMENTOS S.A.', supplier_document: '12345678000190', invoice_number: '101' }, [
        { product_id: f.products.cimento, quantity: 10, unit_cost: 31 },
      ]));
    const list = await admin.get('/api/suppliers');
    expect(list.body.items).toHaveLength(1);
    expect(list.body.items[0]).toMatchObject({ name: 'Votorantim', document: '12345678000190' });

    const dup = await admin.post('/api/suppliers').send({ name: 'Outro', document: '12345678000190' });
    expect(dup.status).toBe(409);
    const bad = await admin.post('/api/suppliers').send({ name: 'Areial', whatsapp: '123' });
    expect(bad.status).toBe(400);
    const ok = await admin.post('/api/suppliers').send({ name: 'Areial do Zé', whatsapp: '(11) 98888-7777', contact_name: 'José Souza' });
    expect(ok.status).toBe(201);
    expect(ok.body.supplier.whatsapp).toBe('5511988887777');

    const seller = await login(app, 'vendedor.a');
    expect((await seller.get('/api/suppliers')).status).toBe(403);
    expect((await seller.get('/api/purchase-orders')).status).toBe(403);
    expect((await seller.get('/api/payables')).status).toBe(403);
  });

  it('sugestão: abaixo do mínimo menos o que já foi pedido, com o último fornecedor e custo', async () => {
    const admin = await login(app, 'admin');
    await admin
      .post('/api/stock/entries')
      .send(entry({ supplier_name: 'Votorantim', supplier_document: '12345678000190' }, [{ product_id: f.products.cimento, quantity: 5, unit_cost: 32.5 }]));
    await admin.put(`/api/stock/products/${f.products.cimento}/min`).send({ store_id: f.storeA, min_quantity: 40 });
    await admin.put(`/api/stock/products/${f.products.tijolo}/min`).send({ store_id: f.storeA, min_quantity: 1000.5 });

    let suggestions = (await admin.get(`/api/purchase-orders/suggestions?store_id=${f.storeA}`)).body.items;
    expect(suggestions).toHaveLength(2);
    const cimento = suggestions.find((s: { product_id: number }) => s.product_id === f.products.cimento);
    expect(cimento).toMatchObject({ quantity: 5, min_quantity: 40, on_order: 0, suggested: 35, unit_cost: 32.5, supplier_name: 'Votorantim' });
    const tijolo = suggestions.find((s: { product_id: number }) => s.product_id === f.products.tijolo);
    expect(tijolo).toMatchObject({ suggested: 1001, supplier_id: null });

    const created = await admin.post('/api/purchase-orders').send({
      store_id: f.storeA,
      supplier_id: cimento.supplier_id,
      items: [{ product_id: f.products.cimento, quantity: 20, unit_cost: 32.5 }],
    });
    expect(created.status).toBe(201);
    expect(created.body.purchase_order).toMatchObject({ status: 'draft', total_amount: 650 });

    suggestions = (await admin.get(`/api/purchase-orders/suggestions?store_id=${f.storeA}`)).body.items;
    expect(suggestions.find((s: { product_id: number }) => s.product_id === f.products.cimento)).toMatchObject({ on_order: 20, suggested: 15 });
  });

  it('pedido de compra: envia, recebe em parte pela nota, encerra; PDF sai', async () => {
    const admin = await login(app, 'admin');
    const supplier = (await admin.post('/api/suppliers').send({ name: 'Cerâmica Boa Vista', document: '11222333000144' })).body.supplier;
    const po = (
      await admin.post('/api/purchase-orders').send({
        store_id: f.storeA,
        supplier_id: supplier.id,
        expected_date: '2026-11-20',
        items: [
          { product_id: f.products.tijolo, quantity: 1000, unit_cost: 0.8 },
          { product_id: f.products.cimento, quantity: 10, unit_cost: 30 },
        ],
      })
    ).body.purchase_order;
    const detail = (await admin.get(`/api/purchase-orders/${po.id}`)).body.purchase_order;
    expect(detail.whatsapp_message).toContain('1.000 UN - Tijolo cerâmico 8 furos (TIJ-8F)');
    expect(detail.whatsapp_message).toContain('20/11/2026');

    const pdf = await admin.get(`/api/purchase-orders/${po.id}/pdf`);
    expect(pdf.status).toBe(200);
    expect(pdf.headers['content-type']).toBe('application/pdf');

    expect((await admin.post(`/api/purchase-orders/${po.id}/sent`)).body.purchase_order.status).toBe('sent');

    // Nota de outra loja não recebe o pedido.
    const wrongStore = await admin
      .post('/api/stock/entries')
      .send({ ...entry({ purchase_order_id: po.id }, [{ product_id: f.products.tijolo, quantity: 600 }]), store_id: f.storeB });
    expect(wrongStore.status).toBe(400);

    const partial = await admin
      .post('/api/stock/entries')
      .send(entry({ purchase_order_id: po.id, supplier_id: supplier.id, invoice_number: '555' }, [
        { product_id: f.products.tijolo, quantity: 600, unit_cost: 0.8 },
        { product_id: f.products.areia, quantity: 2, unit_cost: 100 },
      ]));
    expect(partial.status).toBe(201);
    let after = (await admin.get(`/api/purchase-orders/${po.id}`)).body.purchase_order;
    expect(after.status).toBe('partial');
    expect(after.items.map((i: { received_quantity: number }) => i.received_quantity)).toEqual([600, 0]);
    expect(after.entries).toHaveLength(1);

    // Já chegou em parte: não edita nem cancela, mas encerra.
    expect((await admin.put(`/api/purchase-orders/${po.id}`).send({ store_id: f.storeA, supplier_id: supplier.id, items: [{ product_id: f.products.tijolo, quantity: 1 }] })).status).toBe(409);
    expect((await admin.post(`/api/purchase-orders/${po.id}/cancel`).send({ reason: 'Desisti' })).status).toBe(409);
    const closed = await admin.post(`/api/purchase-orders/${po.id}/close`).send({ reason: 'Cimento em falta no fornecedor' });
    expect(closed.body.purchase_order).toMatchObject({ status: 'received', closed_short: true });

    // Pedido recebido não aceita outra nota.
    const again = await admin.post('/api/stock/entries').send(entry({ purchase_order_id: po.id }, [{ product_id: f.products.tijolo, quantity: 400 }]));
    expect(again.status).toBe(409);

    // Recebendo tudo de uma vez, o pedido fica recebido.
    const po2 = (
      await admin.post('/api/purchase-orders').send({ store_id: f.storeA, supplier_id: supplier.id, items: [{ product_id: f.products.tijolo, quantity: 500 }] })
    ).body.purchase_order;
    await admin.post('/api/stock/entries').send(entry({ purchase_order_id: po2.id }, [{ product_id: f.products.tijolo, quantity: 500 }]));
    after = (await admin.get(`/api/purchase-orders/${po2.id}`)).body.purchase_order;
    expect(after).toMatchObject({ status: 'received', closed_short: false });
    expect((await admin.get('/api/purchase-orders?status=open')).body.items).toHaveLength(0);
  });

  it('unidade de compra: vende em KG, compra em saco de 50 KG', async () => {
    const admin = await login(app, 'admin');
    const created = await admin.post('/api/products').send({ name: 'Cal hidratada', unit: 'kg', price: 1.2, purchase: { unit: 'sc', factor: 20 } });
    expect(created.status).toBe(201);
    const cal = created.body.product;
    expect(cal).toMatchObject({ unit: 'KG', purchase_unit: 'SC', purchase_factor: 20 });
    // Sem mandar "purchase", o cadastro mantém; mesma unidade da venda não vale.
    await admin.put(`/api/products/${cal.id}`).send({ name: 'Cal hidratada CH-III', unit: 'KG', price: 1.3 });
    expect((await admin.get('/api/products?q=cal')).body.items[0]).toMatchObject({ purchase_unit: 'SC', purchase_factor: 20 });
    expect((await admin.put(`/api/products/${cal.id}`).send({ name: 'Cal', unit: 'KG', price: 1.3, purchase: { unit: 'KG', factor: 1 } })).status).toBe(400);

    // Nota em SC: sem vínculo do fornecedor, o fator vem do produto; em outra unidade, 1.
    const match = await admin.post('/api/stock/entries/match').send({
      supplier_document: '12345678000190',
      items: [
        { code: 'X1', name: 'Cal hidratada CH-III', unit: 'SC' },
        { code: 'X2', name: 'Cal hidratada CH-III', unit: 'KG' },
      ],
    });
    expect(match.body.matches.map((m: { factor: number }) => m.factor)).toEqual([20, 1]);

    // Pedido em sacos: guarda em KG, o fornecedor recebe em SC.
    const supplier = (await admin.post('/api/suppliers').send({ name: 'Calcário Sul' })).body.supplier;
    const po = (
      await admin.post('/api/purchase-orders').send({
        store_id: f.storeA,
        supplier_id: supplier.id,
        items: [{ product_id: cal.id, quantity: 10, unit_cost: 18, use_purchase_unit: true }],
      })
    ).body.purchase_order;
    expect(po.items[0]).toMatchObject({ quantity: 200, unit_cost: 0.9, purchase_unit: 'SC', purchase_factor: 20 });
    expect(po.total_amount).toBe(180);
    const detail = (await admin.get(`/api/purchase-orders/${po.id}`)).body.purchase_order;
    expect(detail.whatsapp_message).toContain('10 SC (20 KG cada) - Cal hidratada CH-III');
    expect((await admin.get(`/api/purchase-orders/${po.id}/pdf`)).status).toBe(200);
    const noUnit = await admin.post('/api/purchase-orders').send({
      store_id: f.storeA,
      supplier_id: supplier.id,
      items: [{ product_id: f.products.areia, quantity: 1, use_purchase_unit: true }],
    });
    expect(noUnit.status).toBe(400);

    // Recebe em KG (a tela converte os sacos): 4 sacos = 80 KG.
    await admin.post('/api/stock/entries').send(entry({ purchase_order_id: po.id }, [{ product_id: cal.id, quantity: 80, unit_cost: 0.9 }]));
    const after = (await admin.get(`/api/purchase-orders/${po.id}`)).body.purchase_order;
    expect(after).toMatchObject({ status: 'partial' });
    expect(after.items[0].received_quantity).toBe(80);
    const suggestion = await admin.put(`/api/stock/products/${cal.id}/min`).send({ store_id: f.storeA, min_quantity: 500 });
    expect(suggestion.status).toBe(204);
    // Falta 500 - 80 no estoque - 120 ainda pedidos = 300 KG = 15 sacos.
    const items = (await admin.get(`/api/purchase-orders/suggestions?store_id=${f.storeA}`)).body.items;
    expect(items.find((i: { product_id: number }) => i.product_id === cal.id)).toMatchObject({ suggested: 300, suggested_purchase: 15, purchase_unit: 'SC' });
  });

  it('contas a pagar: duplicatas da nota, pagamento pelo caixa e pelo banco, estorno e cancelamento', async () => {
    const admin = await login(app, 'admin');
    const dups = [
      { due_date: '2026-11-10', amount: 500, document_number: '555-1' },
      { due_date: '2026-12-10', amount: 500, document_number: '555-2' },
    ];
    const disabled = await admin
      .post('/api/stock/entries')
      .send(entry({ supplier_name: 'Votorantim', supplier_document: '12345678000190', invoice_number: '555', payables: dups }, [
        { product_id: f.products.cimento, quantity: 30, unit_cost: 33.33 },
      ]));
    expect(disabled.status).toBe(409);
    expect(disabled.body.code).toBe('FINANCE_DISABLED');
    expect((await admin.get('/api/payables')).status).toBe(409);

    await admin.put('/api/finance/settings').send({ finance_enabled: true });
    const res = await admin
      .post('/api/stock/entries')
      .send(entry({ supplier_name: 'Votorantim', supplier_document: '12345678000190', invoice_number: '555', payables: dups }, [
        { product_id: f.products.cimento, quantity: 30, unit_cost: 33.33 },
      ]));
    expect(res.status).toBe(201);
    const list = (await admin.get('/api/payables')).body;
    expect(list.items.map((p: { installment: number; installments: number; amount: number; document_number: string; supplier_name: string }) => [
      p.installment,
      p.installments,
      p.amount,
      p.document_number,
      p.supplier_name,
    ])).toEqual([
      [1, 2, 500, '555-1', 'Votorantim'],
      [2, 2, 500, '555-2', 'Votorantim'],
    ]);
    expect(list.summary.open_total).toBe(1000);
    const entryDetail = (await admin.get(`/api/stock/entries/${res.body.entry.id}`)).body;
    expect(entryDetail.payables).toHaveLength(2);

    // Conta lançada à mão (aluguel) vencida.
    const rent = await admin.post('/api/payables').send({
      store_id: f.storeA,
      description: 'Aluguel do galpão',
      category: 'Aluguel',
      installments: [{ due_date: '2020-01-05', amount: 2500 }],
    });
    expect(rent.status).toBe(201);
    expect((await admin.get('/api/payables?status=overdue')).body.items).toHaveLength(1);
    expect((await admin.get('/api/payables')).body.summary.overdue).toBe(2500);

    const [first] = list.items as { id: number }[];
    // Dinheiro da gaveta precisa do caixa aberto e sai do esperado.
    const closedCash = await admin.post(`/api/payables/${first!.id}/payments`).send({ amount: 200, paid_on: '2026-10-10', method: 'cash' });
    expect(closedCash.status).toBe(409);
    expect(closedCash.body.code).toBe('CASH_CLOSED');
    await admin.post('/api/cash/open').send({ store_id: f.storeA, opening_amount: 300 });
    expect((await admin.post(`/api/payables/${first!.id}/payments`).send({ amount: 200, paid_on: '2026-10-10', method: 'cash' })).status).toBe(201);
    const cash = (await admin.get('/api/cash/current')).body.current;
    expect(cash.summary).toMatchObject({ payables: 200, expected_cash: 100 });
    expect(cash.movements[0]).toMatchObject({ kind: 'payable', amount: 200, reason: 'NF 555 - Votorantim' });

    const tooMuch = await admin.post(`/api/payables/${first!.id}/payments`).send({ amount: 300.01, paid_on: '2026-10-10', method: 'bank' });
    expect(tooMuch.status).toBe(409);
    expect((await admin.post(`/api/payables/${first!.id}/payments`).send({ amount: 300, paid_on: '2026-10-11', method: 'pix' })).status).toBe(201);
    let detail = (await admin.get(`/api/payables/${first!.id}`)).body;
    expect(detail.payable).toMatchObject({ status: 'paid', remaining: 0 });
    expect(detail.payments).toHaveLength(2);

    // Conta paga não muda nem cancela; estorna e volta a ficar em aberto.
    expect((await admin.post(`/api/payables/${first!.id}/cancel`).send({ reason: 'Erro' })).status).toBe(409);
    const cashPayment = detail.payments[0];
    expect((await admin.post(`/api/payable-payments/${cashPayment.id}/reverse`).send({ reason: 'Valor errado' })).status).toBe(204);
    detail = (await admin.get(`/api/payables/${first!.id}`)).body;
    expect(detail.payable).toMatchObject({ status: 'open', paid_amount: 300 });
    expect((await admin.get('/api/cash/current')).body.current.summary.expected_cash).toBe(300);

    // Fechado o caixa, o pagamento em dinheiro dele não estorna mais.
    await admin.post(`/api/payables/${first!.id}/payments`).send({ amount: 50, paid_on: '2026-10-10', method: 'cash' });
    await admin.post('/api/cash/close').send({ counted_amount: 250 });
    const lastCash = (await admin.get(`/api/payables/${first!.id}`)).body.payments.find((p: { method: string; reversed_at: string | null }) => p.method === 'cash' && !p.reversed_at);
    expect((await admin.post(`/api/payable-payments/${lastCash.id}/reverse`).send({ reason: 'Engano' })).status).toBe(409);

    // Conta sem pagamento: corrige e cancela.
    const rentId = rent.body.ids[0];
    expect((await admin.put(`/api/payables/${rentId}`).send({ description: 'Aluguel outubro', category: 'Aluguel', due_date: '2026-10-05', amount: 2600 })).status).toBe(204);
    expect((await admin.post(`/api/payables/${rentId}/cancel`).send({ reason: 'Lançado em dobro' })).status).toBe(204);
    expect((await admin.get('/api/payables?status=cancelled')).body.items[0]).toMatchObject({ description: 'Aluguel outubro', amount: 2600 });
  });
});
