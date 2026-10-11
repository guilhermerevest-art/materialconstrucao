import type pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { createApp } from '../src/app.js';
import { login, resetDatabase, seedFixtures, setupApp, TEST_DATABASE_URL, type Fixtures } from './helpers.js';

const describeDb = TEST_DATABASE_URL ? describe : describe.skip;

type Step = { key: string; status: string; optional: boolean; detail: string | null };
type Area = { key: string; module: { enabled: boolean } | null; steps: Step[] };

describeDb('implantação', () => {
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

  it('mostra o que já foi configurado e o que falta, só para o admin', async () => {
    const admin = await login(app, 'admin');
    const seller = await login(app, 'vendedor.a');
    expect((await seller.get('/api/setup')).status).toBe(403);

    const read = async () => {
      const areas = (await admin.get('/api/setup')).body.areas as Area[];
      const steps = new Map<string, Step>(areas.flatMap((a) => a.steps.map((s) => [`${a.key}.${s.key}`, s] as [string, Step])));
      return { areas, step: (key: string) => steps.get(key)! };
    };
    let { areas, step } = await read();
    expect(areas.map((a) => a.key)).toEqual(['essencial', 'estoque', 'fluxo', 'rotinas', 'fiscal', 'financeiro', 'fiado', 'preco']);
    expect(step('essencial.lojas')).toMatchObject({ status: 'done', detail: '2 lojas' });
    expect(step('essencial.vendedores')).toMatchObject({ status: 'done', detail: '2 vendedores ativos' });
    expect(step('essencial.produtos').status).toBe('done');
    expect(step('estoque.estoque-inicial').status).toBe('todo');
    expect(step('fiscal.ncm')).toMatchObject({ status: 'warning', detail: '3 produtos sem NCM' });
    expect(areas.find((a) => a.key === 'financeiro')!.module).toEqual({ enabled: false, link: '/configuracoes?aba=financeiro' });

    await admin.post('/api/stock/adjustments').send({ store_id: f.storeA, items: [{ product_id: f.products.cimento, mode: 'count', quantity: 40 }] });
    await admin.put('/api/finance/settings').send({ finance_enabled: true });
    await admin.put('/api/sales-settings').send({ max_discount_percent: 5, default_markup_percent: null, default_commission_percent: 1 });
    ({ areas, step } = await read());
    expect(step('estoque.estoque-inicial').status).toBe('done');
    expect(step('preco.comissao').status).toBe('done');
    expect(areas.find((a) => a.key === 'financeiro')!.module!.enabled).toBe(true);
  });
});
