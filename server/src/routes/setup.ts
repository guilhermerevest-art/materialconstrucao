import { Router } from 'express';
import { currentUser, requireAdmin } from '../auth.js';
import type { AppContext } from '../context.js';
import { withSession } from '../db/session.js';

type Status = 'done' | 'todo' | 'warning';

/** Contagens lidas de uma vez para os passos. */
type Count =
  | 'stores'
  | 'stores_incomplete'
  | 'stores_logo'
  | 'sellers'
  | 'products'
  | 'products_without_ncm'
  | 'payment_methods'
  | 'payment_methods_typed'
  | 'clients'
  | 'clients_with_limit'
  | 'stock_moves'
  | 'stock_minimums'
  | 'suppliers'
  | 'workflows'
  | 'sectors'
  | 'vehicles'
  | 'price_lists'
  | 'users_with_commission'
  | 'homologation_invoices';

type Step = {
  key: string;
  title: string;
  description: string;
  status: Status;
  /** Passo que a loja pode pular (a venda funciona sem ele). */
  optional: boolean;
  /** Situação de agora: "3 lojas", "12 produtos sem NCM"... */
  detail: string | null;
  /** Tela onde se configura. */
  link: string;
  action: string;
};

type Area = {
  key: string;
  title: string;
  description: string;
  /** Módulo opcional: desligado, os passos ficam só de consulta. */
  module: { enabled: boolean; link: string } | null;
  steps: Step[];
};

const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;

/**
 * Implantação: o que já foi configurado na lojamestre, área por área, com o caminho para
 * configurar o resto. Tudo é lido do cadastro; nada aqui grava. O certificado e as
 * senhas continuam com a loja: a tela só diz se já foram informados.
 */
export function setupRouter(ctx: AppContext) {
  const router = Router();

  router.get('/setup', requireAdmin, async (req, res) => {
    const user = currentUser(req);
    const areas = await withSession(ctx.pool, user, async (db) => {
      const { rows } = await db.query(
        `select
           (select count(*) from stores) as stores,
           (select count(*) from stores where nullif(trim(coalesce(address, '')), '') is null or nullif(trim(coalesce(phone, '')), '') is null) as stores_incomplete,
           (select count(*) from stores where logo_data is not null) as stores_logo,
           (select count(*) from users where role = 'seller' and active) as sellers,
           (select count(*) from products where active) as products,
           (select count(*) from products where active and (ncm is null or ncm = '')) as products_without_ncm,
           (select count(*) from payment_methods where active) as payment_methods,
           (select count(*) from payment_methods where active and kind <> 'other') as payment_methods_typed,
           (select count(*) from clients) as clients,
           (select count(*) from clients where credit_limit is not null) as clients_with_limit,
           (select count(*) from stock_movements where kind in ('entry', 'adjustment')) as stock_moves,
           (select count(*) from stock_balances where min_quantity is not null) as stock_minimums,
           (select count(*) from suppliers) as suppliers,
           (select count(*) from workflows) as workflows,
           (select count(*) from sectors) as sectors,
           (select count(*) from vehicles where active) as vehicles,
           (select count(*) from price_lists where active) as price_lists,
           (select count(*) from users where commission_percent is not null) as users_with_commission,
           (select count(*) from fiscal_documents where environment = 'homologacao' and status = 'autorizado') as homologation_invoices`,
      );
      const c = rows[0] as Record<Count, number>;
      const { rows: settingsRows } = await db.query<{
        finance_enabled: boolean;
        fiado_enabled: boolean;
        pix_key: string | null;
        max_discount_percent: number | null;
        default_markup_percent: number | null;
        default_commission_percent: number | null;
        evolution: boolean;
      }>(
        `select finance_enabled, fiado_enabled, pix_key, max_discount_percent, default_markup_percent, default_commission_percent,
                (evolution_api_url is not null and evolution_instance is not null and evolution_api_token is not null) as evolution
           from settings limit 1`,
      );
      const s = settingsRows[0];
      const { rows: fiscalRows } = await db.query<{
        environment: string;
        cnpj: string | null;
        legal_name: string | null;
        address_city_code: string | null;
        acbr_client_id: string | null;
        certificate_uploaded_at: Date | null;
        certificate_valid_until: Date | null;
      }>(
        `select environment, cnpj, legal_name, address_city_code, acbr_client_id, certificate_uploaded_at, certificate_valid_until
           from fiscal_settings limit 1`,
      );
      const fiscal = fiscalRows[0];

      const step = (s: Omit<Step, 'optional' | 'detail'> & { optional?: boolean; detail?: string | null }): Step => ({
        optional: false,
        detail: null,
        ...s,
      });
      const done = (ok: boolean): Status => (ok ? 'done' : 'todo');

      const certificateDays = fiscal?.certificate_valid_until
        ? Math.floor((new Date(fiscal.certificate_valid_until).getTime() - Date.now()) / 86_400_000)
        : null;

      const result: Area[] = [
        {
          key: 'essencial',
          title: 'O essencial para vender',
          description: 'Com isto o PDV já funciona: pedido, orçamento e o PDF para o cliente.',
          module: null,
          steps: [
            step({
              key: 'lojas',
              title: 'Lojas com endereço e telefone',
              description: 'Saem no cabeçalho do PDF do pedido e no romaneio.',
              status: c.stores === 0 ? 'todo' : c.stores_incomplete > 0 ? 'warning' : 'done',
              detail: c.stores === 0 ? null : c.stores_incomplete > 0 ? `${plural(c.stores_incomplete, 'loja', 'lojas')} sem endereço ou telefone` : plural(c.stores, 'loja', 'lojas'),
              link: '/lojas',
              action: 'Abrir lojas',
            }),
            step({
              key: 'logo',
              title: 'Logo da loja',
              description: 'Aparece no PDF do pedido.',
              status: done(c.stores_logo > 0),
              optional: true,
              link: '/lojas',
              action: 'Enviar logo',
            }),
            step({
              key: 'vendedores',
              title: 'Vendedores',
              description: 'Cada um com o próprio usuário e loja. O pedido e os relatórios saem por vendedor.',
              status: done(c.sellers > 0),
              detail: c.sellers ? plural(c.sellers, 'vendedor ativo', 'vendedores ativos') : null,
              link: '/vendedores',
              action: 'Cadastrar vendedores',
            }),
            step({
              key: 'produtos',
              title: 'Produtos',
              description: 'Código, nome, unidade e preço. Os dados fiscais podem vir depois.',
              status: done(c.products > 0),
              detail: c.products ? plural(c.products, 'produto ativo', 'produtos ativos') : null,
              link: '/produtos',
              action: 'Cadastrar produtos',
            }),
            step({
              key: 'formas',
              title: 'Formas de pagamento',
              description: 'Dinheiro, PIX, cartão, crediário... Vão no pedido e nos relatórios.',
              status: done(c.payment_methods > 0),
              detail: c.payment_methods ? plural(c.payment_methods, 'forma ativa', 'formas ativas') : null,
              link: '/formas-de-pagamento',
              action: 'Cadastrar formas',
            }),
            step({
              key: 'clientes',
              title: 'Clientes',
              description: 'Só nome e WhatsApp. Também dá para cadastrar na hora, pelo PDV.',
              status: done(c.clients > 0),
              optional: true,
              detail: c.clients ? plural(c.clients, 'cliente', 'clientes') : null,
              link: '/clientes',
              action: 'Abrir clientes',
            }),
            step({
              key: 'whatsapp',
              title: 'WhatsApp da loja',
              description: 'Manda o PDF, a cobrança e o pedido de compra direto do sistema. Sem ele, baixe o PDF e mande pelo celular.',
              status: done(Boolean(s?.evolution)),
              optional: true,
              link: '/configuracoes',
              action: 'Conectar WhatsApp',
            }),
          ],
        },
        {
          key: 'estoque',
          title: 'Estoque e compras',
          description: 'A venda baixa o estoque desde o primeiro dia; para o saldo valer, lance o que tem na prateleira.',
          module: null,
          steps: [
            step({
              key: 'estoque-inicial',
              title: 'Estoque inicial',
              description: 'Conte a prateleira (Extrato e ajuste → "Contei, o saldo é") ou dê entrada nas últimas notas de compra.',
              status: done(c.stock_moves > 0),
              detail: c.stock_moves ? 'Já há entradas ou contagens lançadas' : null,
              link: '/estoque',
              action: 'Abrir estoque',
            }),
            step({
              key: 'minimos',
              title: 'Estoque mínimo',
              description: 'Abaixo dele o produto aparece em "O que comprar", que monta o pedido de compra.',
              status: done(c.stock_minimums > 0),
              optional: true,
              detail: c.stock_minimums ? plural(c.stock_minimums, 'produto com mínimo', 'produtos com mínimo') : null,
              link: '/estoque',
              action: 'Definir mínimos',
            }),
            step({
              key: 'fornecedores',
              title: 'Fornecedores',
              description: 'A nota de compra cadastra pelo CNPJ. Com o WhatsApp do vendedor dele, o pedido de compra vai direto.',
              status: done(c.suppliers > 0),
              optional: true,
              detail: c.suppliers ? plural(c.suppliers, 'fornecedor', 'fornecedores') : null,
              link: '/compras?aba=fornecedores',
              action: 'Abrir fornecedores',
            }),
          ],
        },
        {
          key: 'fluxo',
          title: 'Fluxo de pedidos e monitores',
          description: 'Etapas do pedido (separação, carregamento, entrega) e a TV da loja mostrando a fila.',
          module: null,
          steps: [
            step({
              key: 'fluxo',
              title: 'Etapas do pedido',
              description: 'Sem fluxo, o pedido confirmado não passa por etapas (tudo continua funcionando).',
              status: done(c.workflows > 0),
              optional: true,
              link: '/fluxo-de-pedidos',
              action: 'Montar o fluxo',
            }),
            step({
              key: 'setores',
              title: 'Setores',
              description: 'Quem é do setor avança os pedidos das etapas dele (pátio, balcão, entrega).',
              status: done(c.sectors > 0),
              optional: true,
              detail: c.sectors ? plural(c.sectors, 'setor', 'setores') : null,
              link: '/fluxo-de-pedidos',
              action: 'Cadastrar setores',
            }),
            step({
              key: 'veiculos',
              title: 'Veículos de entrega',
              description: 'Vão no romaneio de carga.',
              status: done(c.vehicles > 0),
              optional: true,
              detail: c.vehicles ? plural(c.vehicles, 'veículo', 'veículos') : null,
              link: '/entregas',
              action: 'Abrir entregas',
            }),
          ],
        },
        {
          key: 'fiscal',
          title: 'Nota fiscal',
          description: 'NF-e e NFC-e pela ACBr API. Comece em homologação (nota de teste, sem valor fiscal) e só depois passe para produção.',
          module: { enabled: Boolean(fiscal?.cnpj), link: '/configuracoes?aba=fiscal' },
          steps: [
            step({
              key: 'empresa',
              title: 'Dados da empresa',
              description: 'CNPJ, inscrição estadual, regime e endereço com o município.',
              status: fiscal?.cnpj && fiscal.legal_name && fiscal.address_city_code ? 'done' : fiscal?.cnpj ? 'warning' : 'todo',
              detail: fiscal?.cnpj && !fiscal.address_city_code ? 'Falta o endereço completo' : null,
              link: '/configuracoes?aba=fiscal',
              action: 'Preencher',
            }),
            step({
              key: 'acbr',
              title: 'Conta na ACBr API',
              description: 'O client_id e o client_secret da conta da loja.',
              status: done(Boolean(fiscal?.acbr_client_id)),
              link: '/configuracoes?aba=fiscal',
              action: 'Informar a conta',
            }),
            step({
              key: 'certificado',
              title: 'Certificado digital A1',
              description: 'O arquivo e a senha são da loja: envie pela tela de configuração, nesta máquina.',
              status:
                certificateDays === null ? 'todo' : certificateDays < 0 ? 'warning' : certificateDays <= 30 ? 'warning' : 'done',
              detail:
                certificateDays === null
                  ? null
                  : certificateDays < 0
                    ? 'Vencido: envie o novo'
                    : `Vence em ${plural(certificateDays, 'dia', 'dias')}`,
              link: '/configuracoes?aba=fiscal',
              action: 'Enviar certificado',
            }),
            step({
              key: 'ncm',
              title: 'NCM nos produtos',
              description: 'Sem NCM a nota é recusada. Os produtos sem NCM aparecem com um ponto na aba Fiscal.',
              status: c.products === 0 ? 'todo' : c.products_without_ncm > 0 ? 'warning' : 'done',
              detail: c.products_without_ncm > 0 ? plural(c.products_without_ncm, 'produto sem NCM', 'produtos sem NCM') : null,
              link: '/produtos',
              action: 'Abrir produtos',
            }),
            step({
              key: 'homologacao',
              title: 'Nota de teste em homologação',
              description: 'Emita uma nota de um pedido de teste para ver se a SEFAZ autoriza.',
              status: done(c.homologation_invoices > 0 || fiscal?.environment === 'producao'),
              detail: c.homologation_invoices ? plural(c.homologation_invoices, 'nota de teste autorizada', 'notas de teste autorizadas') : null,
              link: '/fiscal',
              action: 'Abrir notas fiscais',
            }),
            step({
              key: 'producao',
              title: 'Produção',
              description: 'Com o teste autorizado, troque o ambiente para produção. Daí em diante as notas valem.',
              status: done(fiscal?.environment === 'producao'),
              link: '/configuracoes?aba=fiscal',
              action: 'Trocar o ambiente',
            }),
          ],
        },
        {
          key: 'financeiro',
          title: 'Financeiro',
          description: 'Contas a receber, caixa, PIX e contas a pagar. Desligado, a venda funciona como sempre.',
          module: { enabled: Boolean(s?.finance_enabled), link: '/configuracoes?aba=financeiro' },
          steps: [
            step({
              key: 'formas-tipo',
              title: 'Tipo e condição das formas de pagamento',
              description: 'Dinheiro, PIX, cartão, crediário (parcelas e vencimentos): o caixa e as parcelas dependem disso.',
              status: done(c.payment_methods_typed > 0),
              detail: c.payment_methods ? `${c.payment_methods_typed} de ${plural(c.payment_methods, 'forma', 'formas')} com tipo` : null,
              link: '/formas-de-pagamento',
              action: 'Ajustar formas',
            }),
            step({
              key: 'pix',
              title: 'Chave PIX da loja',
              description: 'O QR Code sai no recebimento e no PDF do pedido.',
              status: done(Boolean(s?.pix_key)),
              optional: true,
              link: '/configuracoes?aba=financeiro',
              action: 'Informar a chave',
            }),
          ],
        },
        {
          key: 'fiado',
          title: 'Fiado (caderneta)',
          description: 'Conta corrente do cliente, com vencimento no mês e cobrança pelo WhatsApp.',
          module: { enabled: Boolean(s?.fiado_enabled), link: '/configuracoes?aba=fiado' },
          steps: [
            step({
              key: 'limites',
              title: 'Clientes com limite',
              description: 'Só vende fiado (e crediário) para quem tem limite, em Clientes → Crédito.',
              status: done(c.clients_with_limit > 0),
              detail: c.clients_with_limit ? plural(c.clients_with_limit, 'cliente com limite', 'clientes com limite') : null,
              link: '/clientes',
              action: 'Abrir clientes',
            }),
          ],
        },
        {
          key: 'preco',
          title: 'Preço e comissão',
          description: 'Tudo opcional: sem nada configurado, vale o preço do catálogo.',
          module: null,
          steps: [
            step({
              key: 'desconto',
              title: 'Desconto máximo e margem padrão',
              description: 'Acima do limite, o PDV pede a senha de quem libera. A margem sugere o preço na entrada de nota.',
              status: done(s?.max_discount_percent != null || s?.default_markup_percent != null),
              optional: true,
              link: '/configuracoes?aba=vendas',
              action: 'Definir',
            }),
            step({
              key: 'tabelas',
              title: 'Tabelas de preço',
              description: 'Atacado, construtora... O cliente na tabela compra pelo preço dela.',
              status: done(c.price_lists > 0),
              optional: true,
              detail: c.price_lists ? plural(c.price_lists, 'tabela', 'tabelas') : null,
              link: '/tabelas-de-preco',
              action: 'Criar tabela',
            }),
            step({
              key: 'comissao',
              title: 'Comissão',
              description: 'Percentual da loja ou de cada vendedor, sobre a venda confirmada menos devoluções.',
              status: done(s?.default_commission_percent != null || c.users_with_commission > 0),
              optional: true,
              link: '/configuracoes?aba=vendas',
              action: 'Definir',
            }),
          ],
        },
      ];
      return result;
    });
    res.json({ areas });
  });

  return router;
}
