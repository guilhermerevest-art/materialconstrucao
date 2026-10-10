import type pg from 'pg';
import request from 'supertest';
import { inflateRawSync } from 'node:zlib';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { hashPassword } from '../src/auth.js';
import { clearAcbrTokenCache } from '../src/fiscal/acbr.js';
import {
  login,
  PASSWORD,
  resetDatabase,
  seedFixtures,
  setupApp,
  startFakeAcbr,
  TEST_DATABASE_URL,
  testConfig,
  type Fixtures,
} from './helpers.js';

const describeDb = TEST_DATABASE_URL ? describe : describe.skip;

const CNPJ = '11222333000181';
/** Conta da lojamestre dos fixtures na ACBr API. Cada lojamestre tem a sua. */
const CLIENT_ID = 'conta-parceiro';
const CLIENT_SECRET = 'segredo-do-parceiro';
const ACCESS_KEY = '35261011222333000181650010000000011000000019';

type Agent = ReturnType<typeof request.agent>;

/** Lê os arquivos de um .zip (só o que o pacote do contador gera: deflate, sem ZIP64). */
function readZip(zip: Buffer) {
  const files = new Map<string, Buffer>();
  let offset = 0;
  while (zip.readUInt32LE(offset) === 0x04034b50) {
    const size = zip.readUInt32LE(offset + 18);
    const nameLength = zip.readUInt16LE(offset + 26);
    const extra = zip.readUInt16LE(offset + 28);
    const name = zip.subarray(offset + 30, offset + 30 + nameLength).toString('utf8');
    const start = offset + 30 + nameLength + extra;
    files.set(name, inflateRawSync(zip.subarray(start, start + size)));
    offset = start + size;
  }
  return files;
}

const companyBody = {
  environment: 'homologacao',
  acbr_client_id: CLIENT_ID,
  acbr_client_secret: CLIENT_SECRET,
  cnpj: '11.222.333/0001-81',
  legal_name: 'Material de Construção Exemplo LTDA',
  trade_name: 'Casa do Construtor',
  state_registration: '110.042.490.114',
  municipal_registration: '',
  cnae: '',
  tax_regime: 1,
  email: 'fiscal@exemplo.com.br',
  phone: '(11) 3333-0001',
  address_zip: '01001-000',
  address_street: 'Praça da Sé',
  address_number: '100',
  address_complement: '',
  address_district: 'Sé',
  address_city: 'São Paulo',
  address_city_code: '3550308',
  address_state: 'SP',
  operation_nature: 'Venda de mercadoria',
  additional_info: 'Documento emitido por ME ou EPP optante pelo Simples Nacional.',
  nfe_series: 1,
  nfe_next_number: 1,
  nfce_series: 1,
  nfce_next_number: 10,
  nfce_csc_id: '1',
  nfce_csc: 'CSC-DE-TESTE-123456',
  inbound_auto_distribution: true,
  inbound_auto_acknowledge: false,
};

const productFiscal = {
  gtin: '',
  ncm: '2523.29.10',
  cest: '',
  cfop: '',
  tax_origin: 0,
  icms_cst: '102',
  icms_rate: null,
  icms_base_reduction: null,
  pis_cst: '',
  pis_rate: null,
  cofins_cst: '',
  cofins_rate: null,
  ibscbs_cst: '',
  ibscbs_class: '',
  tax_benefit_code: '',
  fiscal_notes: '',
};

const clientDetails = {
  person_type: 'F',
  document: '529.982.247-25',
  trade_name: '',
  state_registration: '',
  ie_indicator: 9,
  final_consumer: true,
  email: 'maria@exemplo.com.br',
  phone: '',
  address_zip: '01310-100',
  address_street: 'Avenida Paulista',
  address_number: '1000',
  address_complement: '',
  address_district: 'Bela Vista',
  address_city: 'São Paulo',
  address_city_code: '3550308',
  address_state: 'SP',
};

function authorized(id: string, model: 55 | 65, number: number) {
  return {
    id,
    ambiente: 'homologacao',
    status: 'autorizado',
    modelo: model,
    serie: 1,
    numero: number,
    chave: ACCESS_KEY,
    autorizacao: {
      status: 'registrado',
      codigo_status: 100,
      motivo_status: 'Autorizado o uso da NF-e',
      numero_protocolo: '135260000000001',
      data_recebimento: '2026-10-10T12:00:00-03:00',
    },
  };
}

describeDb('módulo fiscal (ACBr API)', () => {
  let pool: pg.Pool;
  let adminPool: pg.Pool;
  let app: ReturnType<typeof createApp>;
  let f: Fixtures;
  let acbr: Awaited<ReturnType<typeof startFakeAcbr>>;

  beforeAll(async () => {
    ({ pool, adminPool } = setupApp(TEST_DATABASE_URL!));
    acbr = await startFakeAcbr();
    acbr.registerClient(CLIENT_ID, CLIENT_SECRET);
    app = createApp({ pool, config: { ...testConfig(TEST_DATABASE_URL!), acbr: acbr.config } });
  });

  afterAll(async () => {
    await acbr?.close();
    await pool?.end();
    await adminPool?.end();
  });

  beforeEach(async () => {
    await resetDatabase(pool, adminPool);
    f = await seedFixtures(pool, adminPool);
    acbr.reset();
    clearAcbrTokenCache();
  });

  /** Empresa salva, enviada à ACBr API e com certificado: pronta para emitir. */
  async function configureCompany(admin: Agent) {
    acbr.route('PUT', `/empresas/${CNPJ}`, { status: 404, body: { error: { message: 'Empresa não encontrada' } } });
    acbr.route('POST', '/empresas', { status: 200, body: { cpf_cnpj: CNPJ } });
    acbr.route('PUT', `/empresas/${CNPJ}/nfe`, { status: 200, body: {} });
    acbr.route('PUT', `/empresas/${CNPJ}/nfce`, { status: 200, body: {} });
    acbr.route('PUT', `/empresas/${CNPJ}/distnfe`, { status: 200, body: {} });
    acbr.route('PUT', `/empresas/${CNPJ}/certificado`, {
      status: 200,
      body: { subject_name: 'CN=EXEMPLO LTDA:11222333000181', not_valid_after: '2099-01-01T00:00:00Z', cpf_cnpj: CNPJ },
    });
    const saved = await admin.put('/api/fiscal/settings').send(companyBody);
    expect(saved.status).toBe(200);
    expect((await admin.post('/api/fiscal/settings/sync')).status).toBe(200);
    const cert = await admin
      .put('/api/fiscal/settings/certificate')
      .send({ certificate: Buffer.from('certificado-pfx-de-mentira').toString('base64'), password: '1234' });
    expect(cert.status).toBe(200);
    return cert.body.settings;
  }

  /** Produtos com NCM e CSOSN, cliente com cadastro completo. */
  async function prepareCatalog() {
    await adminPool.query(`update products set ncm = '25232910', icms_cst = '102' where tenant_id = $1`, [f.tenantId]);
    await adminPool.query(
      `update clients set person_type = 'F', document = '52998224725', ie_indicator = 9, address_zip = '01310100',
              address_street = 'Avenida Paulista', address_number = '1000', address_district = 'Bela Vista',
              address_city = 'São Paulo', address_city_code = '3550308', address_state = 'SP'
        where id = $1`,
      [f.clientId],
    );
  }

  async function createOrder(agent: Agent, status: 'quote' | 'order' = 'order') {
    const res = await agent.post('/api/orders').send({
      client_id: f.clientId,
      status,
      // O admin dos fixtures não tem loja; o vendedor sempre lança na dele.
      store_id: f.storeA,
      payment_method_id: null,
      items: [
        { product_id: f.products.cimento, quantity: 3 },
        { product_id: f.products.areia, quantity: 2.5 },
      ],
    });
    expect(res.status).toBe(201);
    return res.body.order as { id: number; total_amount: number };
  }

  describe('dados da empresa (Configurações → Fiscal)', () => {
    it('salva, envia para a ACBr API e guarda só os dados do certificado', async () => {
      const admin = await login(app, 'admin');
      const settings = await configureCompany(admin);

      expect(settings).toMatchObject({
        cnpj: CNPJ,
        state_registration: '110042490114',
        address_zip: '01001000',
        nfce_csc_hint: '••••3456',
        has_nfce_csc: true,
        acbr_client_id: CLIENT_ID,
        acbr_client_secret_hint: '••••eiro',
        acbr_configured: true,
        certificate_subject: 'CN=EXEMPLO LTDA:11222333000181',
      });
      expect(settings.certificate_valid_until).toBeTruthy();
      expect(settings.company_synced_at).toBeTruthy();
      // O CSC e os segredos nunca voltam inteiros.
      expect(JSON.stringify(settings)).not.toContain('CSC-DE-TESTE-123456');
      expect(JSON.stringify(settings)).not.toContain(CLIENT_SECRET);

      const calls = acbr.calls().map((c) => `${c.method} ${c.url}`);
      expect(calls).toEqual([
        `PUT /empresas/${CNPJ}`,
        'POST /empresas',
        `PUT /empresas/${CNPJ}/nfe`,
        `PUT /empresas/${CNPJ}/nfce`,
        `PUT /empresas/${CNPJ}/distnfe`,
        `PUT /empresas/${CNPJ}/certificado`,
      ]);
      const empresa = acbr.calls().find((c) => c.url === '/empresas')!;
      expect(empresa.account).toBe(CLIENT_ID);
      expect(empresa.body).toMatchObject({
        cpf_cnpj: CNPJ,
        nome_razao_social: 'Material de Construção Exemplo LTDA',
        email: 'fiscal@exemplo.com.br',
        endereco: { codigo_municipio: '3550308', uf: 'SP', cep: '01001000' },
      });
      expect(acbr.calls().find((c) => c.url.endsWith('/nfce'))!.body).toEqual({
        CRT: 1,
        ambiente: 'homologacao',
        sefaz: { id_csc: 1, csc: 'CSC-DE-TESTE-123456' },
      });
      // Um único token, da conta da lojamestre, para todas as chamadas.
      expect(acbr.requests.filter((r) => r.url === '/token')).toHaveLength(1);
      expect(String(acbr.requests[0]!.body)).toContain(`client_id=${CLIENT_ID}`);
      expect(new Set(acbr.calls().map((c) => c.account))).toEqual(new Set([CLIENT_ID]));
    });

    it('recusa CNPJ inválido e município de outra UF', async () => {
      const admin = await login(app, 'admin');
      const cnpj = await admin.put('/api/fiscal/settings').send({ ...companyBody, cnpj: '11.222.333/0001-82' });
      expect(cnpj.status).toBe(400);
      expect(cnpj.body.error).toMatch(/CNPJ inválido/);
      const city = await admin.put('/api/fiscal/settings').send({ ...companyBody, address_state: 'RJ' });
      expect(city.status).toBe(400);
      expect(city.body.error).toMatch(/não é de um município de RJ/);
    });

    it('é só do administrador', async () => {
      const seller = await login(app, 'vendedor.a');
      expect((await seller.get('/api/fiscal/settings')).status).toBe(403);
      expect((await seller.put('/api/fiscal/settings').send(companyBody)).status).toBe(403);
      expect((await seller.get('/api/fiscal/inbound')).status).toBe(403);
    });
  });

  describe('conta da ACBr API por lojamestre', () => {
    /** Segunda lojamestre, com loja e admin próprios. */
    async function createOtherTenant() {
      const tenant = await adminPool.query<{ id: number }>(
        `insert into tenants (slug, name) values ('outra', 'Outra lojamestre') returning id`,
      );
      const tid = tenant.rows[0]!.id;
      await adminPool.query('insert into settings (tenant_id) values ($1)', [tid]);
      const store = await adminPool.query<{ id: number }>(
        `insert into stores (tenant_id, name) values ($1, 'Loja da outra') returning id`,
        [tid],
      );
      await adminPool.query(
        `insert into users (tenant_id, name, username, password_hash, role, store_id)
         values ($1, 'Admin da outra', 'admin', $2, 'admin', $3)`,
        [tid, await hashPassword(PASSWORD), store.rows[0]!.id],
      );
      const agent = request.agent(app);
      const res = await agent.post('/api/auth/login').send({ tenant_slug: 'outra', username: 'admin', password: PASSWORD });
      expect(res.status).toBe(200);
      return agent;
    }

    const otherCompany = { ...companyBody, cnpj: '12.345.678/0001-95', legal_name: 'Outra Empresa LTDA' };

    it('cada lojamestre usa a própria conta; o client_id de outra sem o segredo certo não entra', async () => {
      const admin = await login(app, 'admin');
      await configureCompany(admin);

      const other = await createOtherTenant();
      // Tenta usar a conta da primeira lojamestre (o client_id não é segredo) com um segredo chutado.
      const guess = await other.post('/api/fiscal/settings/test-credentials').send({ acbr_client_id: CLIENT_ID, acbr_client_secret: 'chute' });
      expect(guess.status).toBe(422);
      expect(guess.body.error).toMatch(/recusou as credenciais/);
      const saved = await other.put('/api/fiscal/settings').send({ ...otherCompany, acbr_client_secret: 'chute' });
      expect(saved.status).toBe(200);
      acbr.reset();
      const sync = await other.post('/api/fiscal/settings/sync');
      expect(sync.status).toBe(502);
      expect(sync.body.error).toMatch(/recusou as credenciais/);
      // Nenhuma chamada saiu com o token já guardado da primeira lojamestre.
      expect(acbr.calls()).toEqual([]);

      // Com a conta dela, tudo vai para a conta dela.
      acbr.registerClient('conta-outra', 'segredo-da-outra');
      const ok = await other
        .post('/api/fiscal/settings/test-credentials')
        .send({ acbr_client_id: 'conta-outra', acbr_client_secret: 'segredo-da-outra' });
      expect(ok.status).toBe(200);
      const own = await other
        .put('/api/fiscal/settings')
        .send({ ...otherCompany, acbr_client_id: 'conta-outra', acbr_client_secret: 'segredo-da-outra' });
      expect(own.status).toBe(200);
      acbr.route('PUT', '/empresas/12345678000195', { status: 200, body: {} });
      acbr.route('PUT', '/empresas/12345678000195/nfe', { status: 200, body: {} });
      acbr.route('PUT', '/empresas/12345678000195/nfce', { status: 200, body: {} });
      acbr.route('PUT', '/empresas/12345678000195/distnfe', { status: 200, body: {} });
      expect((await other.post('/api/fiscal/settings/sync')).status).toBe(200);
      expect(new Set(acbr.calls().map((c) => c.account))).toEqual(new Set(['conta-outra']));

      // E a primeira continua com a dela.
      acbr.reset();
      acbr.route('GET', '/nfe/sefaz/status', { status: 200, body: { codigo_status: 107, motivo_status: 'Servico em Operacao' } });
      expect((await admin.get('/api/fiscal/settings/sefaz-status')).body.status.online).toBe(true);
      expect(acbr.calls().map((c) => c.account)).toEqual([CLIENT_ID]);
    });

    it('trocar de conta exige o segredo da nova e pede para reenviar empresa e certificado', async () => {
      const admin = await login(app, 'admin');
      await configureCompany(admin);

      const noSecret = await admin.put('/api/fiscal/settings').send({ ...companyBody, acbr_client_id: 'conta-nova', acbr_client_secret: '' });
      expect(noSecret.status).toBe(400);
      expect(noSecret.body.error).toMatch(/client_secret/);

      // Mesmo client_id com o segredo em branco mantém o salvo (e não precisa reenviar nada).
      const same = await admin.put('/api/fiscal/settings').send({ ...companyBody, acbr_client_secret: '' });
      expect(same.status).toBe(200);
      expect(same.body.settings).toMatchObject({ acbr_client_secret_hint: '••••eiro' });
      expect(same.body.settings.company_synced_at).toBeTruthy();
      expect(same.body.settings.certificate_valid_until).toBeTruthy();

      const moved = await admin
        .put('/api/fiscal/settings')
        .send({ ...companyBody, acbr_client_id: 'conta-nova', acbr_client_secret: 'segredo-novo-1234' });
      expect(moved.status).toBe(200);
      expect(moved.body.settings).toMatchObject({
        acbr_client_id: 'conta-nova',
        acbr_client_secret_hint: '••••1234',
        company_synced_at: null,
        certificate_valid_until: null,
      });

      // Sem conta, a emissão avisa onde configurar.
      const removed = await admin.put('/api/fiscal/settings').send({ ...companyBody, acbr_client_id: '', acbr_client_secret: '' });
      expect(removed.body.settings.acbr_configured).toBe(false);
      const sync = await admin.post('/api/fiscal/settings/sync');
      expect(sync.status).toBe(422);
      expect(sync.body.error).toMatch(/client_id e o client_secret da loja/);
    });
  });

  describe('cadastros', () => {
    it('produto guarda a aba fiscal e mantém os dados quando o corpo não traz o bloco', async () => {
      const admin = await login(app, 'admin');
      const saved = await admin.put(`/api/products/${f.products.cimento}`).send({
        code: 'CIM-50',
        name: 'Cimento CP II 50 kg',
        unit: 'SC',
        price: 38.9,
        active: true,
        fiscal: { ...productFiscal, gtin: '7891000315507', cest: '05.001.00' },
      });
      expect(saved.status).toBe(200);
      expect(saved.body.product.fiscal).toMatchObject({ ncm: '25232910', gtin: '7891000315507', cest: '0500100', icms_cst: '102' });

      const basic = await admin
        .put(`/api/products/${f.products.cimento}`)
        .send({ code: 'CIM-50', name: 'Cimento CP II 50 kg', unit: 'SC', price: 39.9, active: true });
      expect(basic.status).toBe(200);
      expect(basic.body.product.fiscal.ncm).toBe('25232910');

      const wrong = await admin.put(`/api/products/${f.products.cimento}`).send({
        code: 'CIM-50',
        name: 'Cimento CP II 50 kg',
        unit: 'SC',
        price: 39.9,
        fiscal: { ...productFiscal, gtin: '7891000315508' },
      });
      expect(wrong.status).toBe(400);
      expect(wrong.body.error).toMatch(/GTIN/);
    });

    it('cliente guarda o cadastro completo, valida o CPF e é encontrado pelo documento', async () => {
      const seller = await login(app, 'vendedor.a');
      const saved = await seller
        .put(`/api/clients/${f.clientId}`)
        .send({ name: 'Maria da Silva', whatsapp: '(11) 98765-4321', details: clientDetails });
      expect(saved.status).toBe(200);
      expect(saved.body.client.details).toMatchObject({ person_type: 'F', document: '52998224725', address_city_code: '3550308' });

      const found = await seller.get('/api/clients?q=529.982');
      expect(found.body.items.map((c: { id: number }) => c.id)).toEqual([f.clientId]);

      const invalid = await seller
        .put(`/api/clients/${f.clientId}`)
        .send({ name: 'Maria da Silva', whatsapp: '(11) 98765-4321', details: { ...clientDetails, document: '529.982.247-24' } });
      expect(invalid.status).toBe(400);
      expect(invalid.body.error).toBe('CPF inválido.');
    });
  });

  describe('emissão', () => {
    it('vendedor emite a NFC-e do pedido: número reservado, payload montado no servidor e nota autorizada', async () => {
      const admin = await login(app, 'admin');
      await configureCompany(admin);
      await prepareCatalog();
      const seller = await login(app, 'vendedor.a');
      const order = await createOrder(seller);
      acbr.reset();
      acbr.route('POST', '/nfce', { status: 200, body: authorized('nfce_1', 65, 10) });

      const res = await seller.post('/api/fiscal/documents').send({ order_id: order.id, model: 65 });
      expect(res.status).toBe(201);
      expect(res.body.document).toMatchObject({
        order_id: order.id,
        model: 65,
        series: 1,
        number: 10,
        status: 'autorizado',
        access_key: ACCESS_KEY,
        protocol: '135260000000001',
        status_code: 100,
        has_files: true,
        total_amount: order.total_amount,
      });
      const sent = acbr.calls().find((c) => c.url === '/nfce')!;
      expect(sent.body).toMatchObject({ ambiente: 'homologacao', referencia: `gl-${f.tenantId}-${res.body.document.id}-1` });
      expect(sent.body.infNFe.ide).toMatchObject({ mod: 65, nNF: 10, serie: 1 });
      expect(sent.body.infNFe.total.ICMSTot.vNF).toBe(order.total_amount);

      // O próximo número já é o 11 e o pedido não aceita outra nota.
      const settings = await adminPool.query('select nfce_next_number from fiscal_settings where tenant_id = $1', [f.tenantId]);
      expect(settings.rows[0].nfce_next_number).toBe(11);
      const again = await seller.post('/api/fiscal/documents').send({ order_id: order.id, model: 55 });
      expect(again.status).toBe(409);
      expect(again.body.error).toMatch(/já tem a NFC-e nº 10 autorizada/);

      // Pedido confirmado não é excluído (com nota, nem depois de cancelado: ver cancel.test.ts).
      const removed = await admin.delete(`/api/orders/${order.id}`);
      expect(removed.status).toBe(409);
      expect(removed.body.error).toMatch(/Pedido confirmado não é excluído/);

      // DANFE vem da ACBr API.
      acbr.route('GET', '/nfce/nfce_1/pdf', { status: 200, body: Buffer.from('%PDF-1.4 danfe'), contentType: 'application/pdf' });
      const pdf = await seller.get(`/api/fiscal/documents/${res.body.document.id}/pdf`);
      expect(pdf.status).toBe(200);
      expect(pdf.headers['content-type']).toBe('application/pdf');
      expect(pdf.body.toString()).toContain('%PDF-1.4');
    });

    it('cadastro incompleto devolve a lista do que falta e não gasta número', async () => {
      const admin = await login(app, 'admin');
      await configureCompany(admin);
      const order = await createOrder(admin);
      const res = await admin.post('/api/fiscal/documents').send({ order_id: order.id, model: 55 });
      expect(res.status).toBe(422);
      expect(res.body.code).toBe('FISCAL_INVALID');
      expect(res.body.problems).toEqual(
        expect.arrayContaining([
          expect.stringMatching(/CPF ou CNPJ válido/),
          expect.stringMatching(/"Cimento CP II 50 kg": informe o NCM/),
        ]),
      );
      const settings = await adminPool.query('select nfe_next_number from fiscal_settings where tenant_id = $1', [f.tenantId]);
      expect(settings.rows[0].nfe_next_number).toBe(1);
      const docs = await adminPool.query('select count(*)::int as n from fiscal_documents');
      expect(docs.rows[0].n).toBe(0);
    });

    it('orçamento não tem nota e empresa sem certificado é avisada antes', async () => {
      const admin = await login(app, 'admin');
      const quote = await createOrder(admin, 'quote');
      const notConfigured = await admin.post('/api/fiscal/documents').send({ order_id: quote.id, model: 65 });
      expect(notConfigured.status).toBe(422);
      expect(notConfigured.body.code).toBe('FISCAL_NOT_CONFIGURED');

      await configureCompany(admin);
      await prepareCatalog();
      const res = await admin.post('/api/fiscal/documents').send({ order_id: quote.id, model: 65 });
      expect(res.status).toBe(409);
      expect(res.body.error).toMatch(/Converta o orçamento/);
    });

    it('nota rejeitada é reenviada com o mesmo número depois da correção', async () => {
      const admin = await login(app, 'admin');
      await configureCompany(admin);
      await prepareCatalog();
      const order = await createOrder(admin);
      acbr.route('POST', '/nfe', {
        status: 200,
        body: {
          id: 'nfe_rej',
          status: 'rejeitado',
          autorizacao: { codigo_status: 778, motivo_status: 'Rejeição: Informado NCM inexistente' },
        },
      });
      const first = await admin.post('/api/fiscal/documents').send({ order_id: order.id, model: 55 });
      expect(first.status).toBe(201);
      expect(first.body.document).toMatchObject({ status: 'rejeitado', number: 1, status_code: 778, has_files: false });
      expect(first.body.document.status_message).toMatch(/NCM inexistente/);

      // Outra nota para o mesmo pedido fica bloqueada até corrigir ou inutilizar.
      const other = await admin.post('/api/fiscal/documents').send({ order_id: order.id, model: 65 });
      expect(other.status).toBe(409);

      await adminPool.query(`update products set ncm = '25233000' where id = $1`, [f.products.cimento]);
      acbr.route('POST', '/nfe', { status: 200, body: authorized('nfe_ok', 55, 1) });
      const retry = await admin.post(`/api/fiscal/documents/${first.body.document.id}/retry`);
      expect(retry.status).toBe(200);
      expect(retry.body.document).toMatchObject({ status: 'autorizado', number: 1, attempts: 2 });
      const sent = acbr.calls().filter((c) => c.url === '/nfe');
      expect(sent).toHaveLength(2);
      expect(sent[1]!.body.referencia).toBe(`gl-${f.tenantId}-${first.body.document.id}-2`);
      expect(sent[1]!.body.infNFe.ide.nNF).toBe(1);
      expect(sent[1]!.body.infNFe.det[0].prod.NCM).toBe('25233000');
      const settings = await adminPool.query('select nfe_next_number from fiscal_settings where tenant_id = $1', [f.tenantId]);
      expect(settings.rows[0].nfe_next_number).toBe(2);
    });

    it('envio sem resposta fica em erro e é recuperado pela referência', async () => {
      const admin = await login(app, 'admin');
      await configureCompany(admin);
      await prepareCatalog();
      const order = await createOrder(admin);
      acbr.route('POST', '/nfce', { status: 503, body: { error: { message: 'Serviço indisponível' } } });
      const res = await admin.post('/api/fiscal/documents').send({ order_id: order.id, model: 65 });
      expect(res.body.document.status).toBe('erro');
      expect(res.body.document.status_message).toMatch(/instável/);

      const reference = `gl-${f.tenantId}-${res.body.document.id}-1`;
      acbr.route('GET', '/nfce', (req) => {
        expect(req.url).toContain(`referencia=${reference}`);
        expect(req.url).toContain(`cpf_cnpj=${CNPJ}`);
        return { status: 200, body: { data: [authorized('nfce_late', 65, 10)] } };
      });
      const synced = await admin.post(`/api/fiscal/documents/${res.body.document.id}/sync`);
      expect(synced.status).toBe(200);
      expect(synced.body.document).toMatchObject({ status: 'autorizado', access_key: ACCESS_KEY });
    });

    it('cancelamento e inutilização são do administrador', async () => {
      const admin = await login(app, 'admin');
      await configureCompany(admin);
      await prepareCatalog();
      const seller = await login(app, 'vendedor.a');
      const order = await createOrder(seller);
      acbr.route('POST', '/nfe', { status: 200, body: authorized('nfe_1', 55, 1) });
      const doc = (await seller.post('/api/fiscal/documents').send({ order_id: order.id, model: 55 })).body.document;

      const reason = 'Cliente desistiu da compra no balcão';
      expect((await seller.post(`/api/fiscal/documents/${doc.id}/cancel`).send({ reason })).status).toBe(403);
      const short = await admin.post(`/api/fiscal/documents/${doc.id}/cancel`).send({ reason: 'curta' });
      expect(short.status).toBe(400);

      acbr.route('POST', '/nfe/nfe_1/cancelamento', {
        status: 200,
        body: { id: 'evt_1', status: 'registrado', codigo_status: 135, motivo_status: 'Evento registrado e vinculado a NF-e' },
      });
      const cancelled = await admin.post(`/api/fiscal/documents/${doc.id}/cancel`).send({ reason });
      expect(cancelled.status).toBe(200);
      expect(cancelled.body.document).toMatchObject({ status: 'cancelado', cancel_reason: reason });
      expect(acbr.calls().find((c) => c.url === '/nfe/nfe_1/cancelamento')!.body).toEqual({ justificativa: reason });

      // Cancelada, o pedido aceita outra nota (com número novo); rejeitada, o número é inutilizado.
      acbr.route('POST', '/nfe', { status: 200, body: { id: 'nfe_2', status: 'rejeitado', autorizacao: { codigo_status: 999 } } });
      const rejected = (await seller.post('/api/fiscal/documents').send({ order_id: order.id, model: 55 })).body.document;
      expect(rejected).toMatchObject({ status: 'rejeitado', number: 2 });
      acbr.route('POST', '/nfe/inutilizacoes', { status: 200, body: { status: 'registrado', motivo_status: 'Inutilização homologada' } });
      const discarded = await admin.post(`/api/fiscal/documents/${rejected.id}/discard`).send({ reason });
      expect(discarded.status).toBe(200);
      expect(discarded.body.document.status).toBe('inutilizado');
      expect(acbr.calls().find((c) => c.url === '/nfe/inutilizacoes')!.body).toMatchObject({
        cnpj: CNPJ,
        serie: 1,
        numero_inicial: 2,
        numero_final: 2,
        ambiente: 'homologacao',
      });
    });

    it('vendedor de outra loja não vê a nota (RLS)', async () => {
      const admin = await login(app, 'admin');
      await configureCompany(admin);
      await prepareCatalog();
      const sellerA = await login(app, 'vendedor.a');
      const order = await createOrder(sellerA);
      acbr.route('POST', '/nfce', { status: 200, body: authorized('nfce_1', 65, 10) });
      const doc = (await sellerA.post('/api/fiscal/documents').send({ order_id: order.id, model: 65 })).body.document;

      const sellerB = await login(app, 'vendedor.b');
      expect((await sellerB.get(`/api/fiscal/documents/${doc.id}`)).status).toBe(404);
      expect((await sellerB.get('/api/fiscal/documents')).body.items).toEqual([]);
      expect((await sellerB.post('/api/fiscal/documents').send({ order_id: order.id, model: 65 })).status).toBe(404);
      expect((await admin.get('/api/fiscal/documents')).body.items).toHaveLength(1);
    });
  });

  describe('monitor de notas recebidas', () => {
    function distDoc(overrides: Record<string, unknown>) {
      return {
        id: 'doc_1',
        nsu: 101,
        tipo_documento: 'nota',
        chave_acesso: '35261099888777000155550010000012341000012345',
        resumo: true,
        tipo_nfe: 1,
        valor_nfe: 1520.4,
        emitente_cpf_cnpj: '99888777000155',
        emitente_nome_razao_social: 'Votorantim Cimentos S.A.',
        data_evento: '2026-10-09T10:00:00-03:00',
        ...overrides,
      };
    }

    it('traz as notas, troca o resumo pela nota completa, marca cancelamento e manifesta', async () => {
      const admin = await login(app, 'admin');
      await configureCompany(admin);
      acbr.route('GET', '/distribuicao/nfe/documentos', {
        status: 200,
        body: {
          data: [
            distDoc({}),
            distDoc({ id: 'doc_2', nsu: 102, chave_acesso: '35261099888777000155550010000012351000012350', valor_nfe: 99.9 }),
          ],
        },
      });
      const first = await admin.post('/api/fiscal/inbound/sync').send({});
      expect(first.status).toBe(200);
      expect(first.body.created).toBe(2);
      const listing = acbr.calls().find((c) => c.url.startsWith('/distribuicao/nfe/documentos'))!;
      expect(listing.url).toContain(`cpf_cnpj=${CNPJ}`);
      expect(listing.url).toContain('ambiente=homologacao');

      const list = await admin.get('/api/fiscal/inbound?status=pending');
      expect(list.body.total).toBe(2);
      expect(list.body.meta).toMatchObject({ pending_count: 2, last_nsu: 102 });
      const note = list.body.items.find((d: { amount: number }) => d.amount === 1520.4);
      expect(note).toMatchObject({ summary: true, issuer_name: 'Votorantim Cimentos S.A.' });

      // Resumo ainda não tem DANFE.
      expect((await admin.get(`/api/fiscal/inbound/${note.id}/pdf`)).status).toBe(409);

      acbr.route('POST', '/distribuicao/nfe/manifestacoes', {
        status: 200,
        body: { id: 'man_1', status: 'registrado', motivo_status: 'Evento registrado' },
      });
      const manifested = await admin.post(`/api/fiscal/inbound/${note.id}/manifest`).send({ event: '210210' });
      expect(manifested.status).toBe(200);
      expect(manifested.body.document).toMatchObject({ manifestation: '210210', manifestation_status: 'registrado' });
      expect(acbr.calls().find((c) => c.url === '/distribuicao/nfe/manifestacoes')!.body).toMatchObject({
        cpf_cnpj: CNPJ,
        chave_acesso: note.access_key,
        tipo_evento: '210210',
      });

      const missingReason = await admin.post(`/api/fiscal/inbound/${note.id}/manifest`).send({ event: '210240' });
      expect(missingReason.status).toBe(400);

      // Depois da ciência chega a nota completa; a outra foi cancelada pelo emitente.
      acbr.route('GET', '/distribuicao/nfe/documentos', (req) => {
        expect(req.url).toContain('dist_nsu=102');
        return {
          status: 200,
          body: {
            data: [
              distDoc({ id: 'doc_full', nsu: 103, resumo: false }),
              { id: 'evt_9', nsu: 104, tipo_documento: 'evento', tipo_evento: '110111', chave_acesso: '35261099888777000155550010000012351000012350' },
            ],
          },
        };
      });
      acbr.route('POST', '/distribuicao/nfe', { status: 200, body: { status: 'concluido', motivo_status: 'Nenhum documento localizado', documentos: [] } });
      const second = await admin.post('/api/fiscal/inbound/sync').send({ sefaz: true });
      expect(second.body).toMatchObject({ created: 0, notice: 'SEFAZ: Nenhum documento localizado' });
      expect(acbr.calls().find((c) => c.method === 'POST' && c.url === '/distribuicao/nfe')!.body).toMatchObject({
        tipo_consulta: 'dist-nsu',
        dist_nsu: 102,
      });

      const all = (await admin.get('/api/fiscal/inbound')).body.items;
      expect(all.find((d: { id: number }) => d.id === note.id)).toMatchObject({ summary: false, manifestation: '210210' });
      expect(all.find((d: { amount: number }) => d.amount === 99.9)).toMatchObject({ cancelled: true });

      acbr.route('GET', '/distribuicao/nfe/documentos/doc_full/pdf', { status: 200, body: Buffer.from('%PDF danfe fornecedor'), contentType: 'application/pdf' });
      const pdf = await admin.get(`/api/fiscal/inbound/${note.id}/pdf`);
      expect(pdf.status).toBe(200);
      expect(pdf.body.toString()).toContain('%PDF');
    });
  });
  describe('pacote do contador', () => {
    it('junta os XMLs do mês (baixa os que faltam) e o resumo; só o admin', async () => {
      const admin = await login(app, 'admin');
      await configureCompany(admin);
      await prepareCatalog();
      const seller = await login(app, 'vendedor.a');
      const order = await createOrder(seller);
      acbr.route('POST', '/nfce', { status: 200, body: authorized('nfce_1', 65, 10) });
      expect((await seller.post('/api/fiscal/documents').send({ order_id: order.id, model: 65 })).status).toBe(201);

      // Nota de compra lançada pelo XML: o XML fica guardado com a entrada.
      const supplierKey = '35261012345678000199550010000045671000045678';
      const supplierXml = `<nfeProc><NFe><infNFe Id="NFe${supplierKey}"><ide><nNF>4567</nNF></ide></infNFe></NFe></nfeProc>`;
      const entry = await admin.post('/api/stock/entries').send({
        store_id: f.storeA,
        supplier_name: 'Distribuidora',
        supplier_document: '12345678000199',
        invoice_number: '4567',
        invoice_series: '1',
        access_key: supplierKey,
        issued_at: new Date().toISOString(),
        total_amount: 300,
        xml: supplierXml,
        items: [{ product_id: f.products.cimento, quantity: 10, unit_cost: 30 }],
      });
      expect(entry.status).toBe(201);

      const month = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(new Date()).slice(0, 7);
      expect((await seller.get(`/api/fiscal/accountant/summary?month=${month}`)).status).toBe(403);
      const summary = await admin.get(`/api/fiscal/accountant/summary?month=${month}`);
      expect(summary.body).toMatchObject({
        environment: 'homologacao',
        issued: { authorized: 1, cancelled: 0 },
        received: { count: 1, amount: 300 },
        to_download: 1,
        without_xml: 0,
      });

      acbr.route('GET', '/nfce/nfce_1/xml', { status: 200, body: Buffer.from(`<nfeProc><chNFe>${ACCESS_KEY}</chNFe></nfeProc>`), contentType: 'application/xml' });
      const prepared = await admin.post('/api/fiscal/accountant/prepare').send({ month });
      expect(prepared.body).toMatchObject({ saved: 1, failures: [], to_download: 0 });

      const pkg = await admin.get(`/api/fiscal/accountant/package?month=${month}`).buffer(true).parse((res, done) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => done(null, Buffer.concat(chunks)));
      });
      expect(pkg.status).toBe(200);
      expect(pkg.headers['content-type']).toBe('application/zip');
      const files = readZip(pkg.body as Buffer);
      expect([...files.keys()].sort()).toEqual([
        'LEIA-ME.txt',
        `emitidas/autorizadas/NFCe-${ACCESS_KEY}.xml`,
        `recebidas/NFe-${supplierKey}.xml`,
        'resumo.csv',
      ]);
      expect(files.get(`recebidas/NFe-${supplierKey}.xml`)!.toString()).toBe(supplierXml);
      const csv = files.get('resumo.csv')!.toString('utf8');
      expect(csv).toContain(`Saída;NFC-e;10;1;${ACCESS_KEY}`);
      expect(csv).toContain(`Entrada;NF-e;4567;1;${supplierKey}`);
      expect(files.get('LEIA-ME.txt')!.toString()).toContain('HOMOLOGAÇÃO');

      // O XML baixado fica guardado: a próxima busca não vai à ACBr API.
      acbr.reset();
      const docId = (await adminPool.query('select id from fiscal_documents where tenant_id = $1', [f.tenantId])).rows[0].id;
      const xml = await admin.get(`/api/fiscal/documents/${docId}/xml`);
      expect(xml.status).toBe(200);
      expect(acbr.calls()).toHaveLength(0);
    });
  });
});
