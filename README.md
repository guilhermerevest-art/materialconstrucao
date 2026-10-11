# Gestão de Loja: pedidos e orçamentos

Sistema de pedidos e orçamentos para o balcão das lojas da rede. O vendedor lança o
orçamento ou pedido pelo teclado e envia o PDF ao cliente pelo WhatsApp (EvolutionAPI)
com um clique.

- **Frontend:** React 19, Vite 8, Tailwind 4, componentes no padrão shadcn/ui (`web/`)
- **API:** Node + Express 5 + `pg` (`server/`), publicada como Serverless Function na Vercel (`api/index.ts`)
- **Banco:** PostgreSQL, com Row Level Security isolando os pedidos por loja
- **PDF:** gerado no servidor com pdfkit, a partir dos dados do banco (os totais nunca vêm do navegador)

## Acesso (banco da VPS)

O banco em `76.13.237.176:15432/materialconstrucao` foi provisionado em 2026-10-07.
Senhas geradas pelo seed — **troque em "Alterar senha" depois do primeiro login**.
O login pede lojamestre e usuário: os cadastros de antes das lojamestres ficaram na
lojamestre `default`, e o usuário é a parte do e-mail antes do `@`.

| Lojamestre | Usuário | Perfil | Loja | Senha |
| --- | --- | --- | --- | --- |
| `default` | `admin` | admin | Loja Centro | `HHgploAUoY8k` |
| `default` | `carlos` | vendedor | Loja Centro | `demo1234` |
| `default` | `joana` | vendedor | Loja Jardim | `demo1234` |

26 produtos de catálogo e 2 lojas (Centro / Jardim) já estão semeados. Não há clientes —
crie pelo PDV quando for testar o WhatsApp, para não mandar mensagem a um número real.

### Super admin (revendedor)

A primeira conta do painel `/super` precisa ser criada por SQL — `super_admins` é uma tabela
vazia por design. O primeiro super admin entra em `/super/login`, cria as lojamestres pelo
painel e entrega a senha provisória do admin de cada uma.

Gere o hash da senha que você quer usar com bcrypt (mesmo formato do projeto), na raiz do
repositório depois do `npm install`:

```bash
node -e "console.log(require('bcryptjs').hashSync('SUA_SENHA', 10))"
```

Depois:

```sql
insert into super_admins (email, password_hash)
values ('voce@empresa.com.br', 'COLE_O_HASH_AQUI');
```

### Domínio próprio por lojamestre

No painel `/super`, cada lojamestre pode ter um ou mais domínios (ex.: `pedidos.lojadojoao.com.br`).
Quem entra por um desses endereços não vê o campo "Lojamestre" no login: ela vem do domínio, e o
nome da loja aparece no topo da tela. No endereço geral (`materialconstrucao.vercel.app`) o campo
continua aparecendo. Para cada domínio:

1. Cadastre no `/super` (botão **Editar** na lista, ou no campo da lojamestre nova).
2. Na Vercel, em **Settings → Domains** do projeto, adicione o mesmo domínio.
3. No registro do domínio (Registro.br etc.), crie o apontamento DNS que a Vercel mostrar
   (normalmente um `CNAME` para `cname.vercel-dns.com`).

Lojamestres novas têm admin com senha provisória que deve ser trocada no primeiro login.
Use o painel `/super` para criá-las (não use SQL — a tela já popula `settings`).

O botão **Editar** de cada lojamestre troca nome, slug, domínios e situação. Mudar o slug muda o
que se digita no login pelo endereço geral (avise os usuários). Desativar bloqueia o login de todos
os usuários dela e derruba quem já está dentro; reativar libera de novo, sem perder nada.

> **Atenção SSL:** o Postgres desta VPS ainda está com `ssl=off`. O `npm run db:migrate`
> e a API local funcionam sem SSL, mas a `VPS_DATABASE_URL` no `.env` está sem
> `sslmode`. Antes de colocar em produção, habilite SSL no servidor e adicione
> `?sslmode=require` à URL.

## Rodar localmente

Requisitos: Node 22+, Docker.

```bash
npm install
cp .env.example .env            # ajuste o JWT_SECRET
npm run db:up                   # Postgres local na porta 5433
npm run db:migrate
npm run db:seed -- --demo --email admin@demo.local --password admin1234
npm run dev                     # API em :3000, app em http://localhost:5173
```

Entre com a lojamestre `default`, usuário `admin` e senha `admin1234`. O `--demo` cria duas lojas,
um catálogo de exemplo e dois vendedores (`carlos` na Loja Centro e `joana` na Loja Jardim, senha
`demo1234`). Ele não cria clientes, para nenhum teste mandar WhatsApp a um número real por engano.
**Não use `--demo` em produção.**

O seed também cria outra lojamestre direto pelo terminal (o caminho normal é o painel `/super`):
`npm run db:seed -- --tenant loja-do-joao --tenant-name "Loja do João" --username joao`.
Rodar de novo não duplica nada.

### Testes

```bash
npm test          # unitários + integração (usa TEST_DATABASE_URL, que é apagado)
npm run typecheck
```

Os testes de integração cobrem os critérios de aceite: total calculado no servidor,
PDF gerado, payload enviado à EvolutionAPI (com um servidor falso) e o isolamento
entre lojas, tanto na API quanto direto no banco (RLS).

## Atalhos do PDV

| Tecla | Ação |
| --- | --- |
| F4 | Buscar cliente |
| F2 | Buscar produto (nome ou código; leitor de código de barras funciona) |
| Enter | Escolhe o resultado; no campo de quantidade, adiciona ao carrinho |
| Esc | Cancela o produto escolhido |
| F9 ou Ctrl+Enter | Salvar |

## Implantação

**Administração → Implantação** (e um aviso no início do admin enquanto falta algo) mostra, área por área, o
que já está configurado e leva direto à tela de cada passo. Tudo é lido do cadastro, sem marcar nada à mão:
lojas, vendedores, produtos e formas de pagamento (o essencial); WhatsApp; estoque inicial, mínimos e
fornecedores; fluxo de pedidos, setores e veículos; nota fiscal (empresa, conta da ACBr API, certificado com o
aviso de vencimento, NCM dos produtos, nota de teste em homologação e produção); financeiro e PIX; fiado; preço
e comissão; rotinas e contagem. Os módulos desligados e os passos opcionais não contam no progresso. O certificado e as senhas
continuam com a loja: a tela só diz se já foram informados.

## Regras de negócio

- **Vendedor** vê e edita os pedidos da própria loja; só lança pedidos em seu nome e na sua loja.
  **Admin** vê a rede toda, escolhe a loja ao lançar e é o único que exclui pedidos.
- **Orçamento** pode ser editado e convertido em pedido. **Pedido** é venda confirmada e não é editado.
- Ao editar um orçamento, os itens que já estavam nele mantêm o preço da época; itens novos usam o preço atual do catálogo.
- O item do pedido guarda nome, código, unidade e preço do produto, para o pedido não mudar quando o catálogo mudar.
- Estoque: ver a seção **Estoque** abaixo. A venda não trava por falta de saldo; o PDV mostra o saldo na busca.
- **Desconto** vale para o pedido inteiro, em percentual (até 100%) ou em valor (até o valor dos produtos).
  O servidor calcula subtotal, desconto e total; o total da listagem, do painel e do WhatsApp já vem com desconto.
  Ao editar o orçamento, o desconto é recalculado sobre os itens novos (o percentual continua o mesmo).
- **Endereço de entrega** é opcional (em branco = cliente retira na loja) e sai no PDF.
- **Obras do cliente:** cada cliente pode ter várias obras (nome, endereço, contato na obra). No PDV,
  escolher a obra preenche o endereço de entrega, que continua editável; o pedido guarda o texto e a obra.
  Obra encerrada (desativada) sai da escolha; excluir a obra não muda o endereço dos pedidos que já a usaram.
  Os dados fiscais do cliente (CPF/CNPJ, IE, endereço com código IBGE) ficam com o módulo fiscal.
- **Limite de crédito** (só o admin define, em Clientes): quanto o cliente pode dever no crediário.
  Em branco, ele não compra no crediário.
- **Contato do cliente** (opcional, no cadastro): com quem falar. As mensagens (legenda do PDF, aviso de etapa,
  retomada) dizem "Olá, {contato}!"; sem contato, empresa (CNPJ no cadastro completo) é chamada pelo nome inteiro
  e pessoa pelo primeiro nome.
- WhatsApp do cliente é guardado só com dígitos e DDI (`(11) 98765-4321` vira `5511987654321`).
  Número de outro país deve começar com `+`.
- **O mesmo WhatsApp não pode ficar em dois cadastros de cliente.** Ao salvar um número que
  outro cliente já usa, nada é gravado: o sistema mostra os cadastros que já têm aquele número e
  o vendedor escolhe qual usar (ou volta e corrige o número). O índice único no banco garante a
  regra mesmo quando duas pessoas salvam ao mesmo tempo — a segunda recebe o aviso em vez de criar
  a duplicata.
- **Cancelar:** orçamento pode ser marcado como **perdido** por quem atende, com o motivo, e reaberto se foi
  engano. **Pedido confirmado só o admin cancela**, também com motivo, e não volta. O cancelado continua no
  sistema (aba Cancelados), sai do monitor, das vendas do painel e dos relatórios, não é editado nem enviado
  por WhatsApp. Com nota fiscal autorizada ou em processamento, cancele a nota antes; com nota recusada
  esperando correção, inutilize o número antes. **Excluir** (só admin) vale para orçamento e documento
  cancelado; pedido confirmado se cancela, e pedido que teve nota fiscal não é excluído.
- Produto usado em pedidos não pode ser excluído; desative-o para tirá-lo da busca.
- **Forma de pagamento** (opcional) é escolhida no orçamento ou pedido e sai no PDF. O administrador
  cadastra as formas em Administração → Formas de pagamento; toda lojamestre começa com Dinheiro, PIX,
  Cartão de débito, Cartão de crédito e Boleto. O pedido guarda o nome da forma da época, e forma usada
  em pedidos não pode ser excluída, só desativada (sai da lista, mas o orçamento que já a tinha continua com ela).

## Preço

Tudo opcional: sem tabela, faixa ou limite configurado, o pedido usa o preço do catálogo como sempre.

- **Tabelas de preço** (Administração → Tabelas de preço): varejo, atacado, construtora... Cada tabela tem um
  ajuste sobre o catálogo (ex.: 8% abaixo) e, se quiser, preço próprio por produto. O admin põe o cliente na
  tabela pelo cadastro dele; o PDV mostra "Tabela de preço: Atacado" e o preço da tabela na busca e no carrinho.
  Tabela desativada ou excluída: o cliente volta ao catálogo. O pedido guarda o nome da tabela usada.
- **Preço por quantidade** (produto → aba Preço): a partir de N unidades, o item sai pelo preço da faixa. Com
  tabela, vale o menor dos dois. O carrinho avisa a próxima faixa ("A partir de 50 SC: R$ 34,90").
- **O preço é sempre do servidor:** o PDV mostra a prévia, mas quem calcula é o servidor ao salvar. No
  orçamento editado, o item mantém o preço da época; se a quantidade ou o cliente mudar, fica o menor entre o
  da época e o de agora (nunca aumenta).
- **Desconto com liberação:** limite padrão em Configurações → Vendas e, se quiser, um limite próprio por
  vendedor. Acima do limite, o PDV pede usuário e senha de quem pode liberar (admin, ou vendedor marcado para
  liberar, até o limite dele). O pedido mostra quem liberou; editar sem passar do liberado não pede de novo.
  O admin não tem limite.
- **Margem e reajuste:** margem sobre o custo padrão (Configurações → Vendas) ou por produto. Na entrada de
  nota, cada item mostra a venda de hoje, a margem com o custo da nota e o preço sugerido, com a opção de
  atualizar o preço na hora. **Reajustar preços** (Produtos) aplica % sobre o preço atual ou a margem sobre o
  último custo, a todos ou aos da busca, com arredondamento para cima e prévia antes de gravar.
- **Histórico de preço** no produto: toda mudança, por qualquer caminho, com motivo, quem e quando.
- A venda guarda o custo de cada item na confirmação, para os relatórios de margem.

## Comissão e relatórios

- **Comissão:** percentual padrão em Configurações → Vendas e, se quiser, um próprio por vendedor
  (Administração → Vendedores). Base: venda confirmada no período menos as devoluções do período dos pedidos
  do vendedor; pedido cancelado não conta. Sem percentual configurado, não há comissão (o relatório mostra só
  as vendas). O vendedor vê só a própria comissão.
- **Relatórios** (menu Relatórios), em três áreas, todos com exportação para CSV (abre direto no Excel):
  - **Vendas:** por dia, loja, vendedor, produto, cliente e forma de pagamento (pedidos ou orçamentos);
    **conversão de orçamentos** (feitos, viraram pedido, perdidos, em aberto, taxa e dias até fechar, por
    vendedor); **comissão**; **devoluções** por produto (com o que voltou avariado).
  - **Estoque e compras:** **curva ABC** do período com giro e cobertura em dias; **estoque parado** (com saldo
    e sem venda há 30 a 365 dias, ou nunca vendido) com o valor parado a custo; **estoque valorizado** a custo
    e a preço; **margem** por produto (venda líquida menos o custo gravado na venda); **compras** por fornecedor;
    **divergências de contagem** (o que a contagem cega achou de diferença, a acurácia e o valor ajustado).
  - **Financeiro:** **inadimplência** de hoje (parcelas e fiado vencidos por faixa: até 30, 31–60, 61–90 e mais
    de 90 dias) e **fluxo de caixa** por dia (entrou, saiu, saldo, vence a receber e a pagar).
- Estoque valorizado, margem, compras e fluxo de caixa são do administrador; o vendedor vê os da própria loja.

## Estoque

Saldo por loja (não há depósito central), no menu **Estoque**. Todo mundo consulta, inclusive o saldo das
outras lojas (no extrato do produto), para dizer ao cliente onde tem; ajustar, transferir e lançar nota é
do administrador.

- **Venda baixa na confirmação do pedido** (criado como pedido, convertido ou salvo como pedido), na loja do
  pedido. **Cancelar devolve** exatamente o que saiu. Orçamento não mexe no estoque. Pedidos confirmados antes
  do estoque existir não têm baixa.
- **Excluir pedido confirmado não é mais possível:** cancele (o cancelamento devolve o estoque). Excluir
  continua valendo para orçamento e documento cancelado.
- **Sem trava:** o saldo pode ficar negativo; o PDV mostra "Est." na busca, em vermelho quando zerado ou
  negativo, e o filtro **Negativos** mostra o que precisa de acerto.
- **Entrada de nota:** importe o XML da NF-e de compra (lido no navegador) ou lance à mão. Cada item da nota é
  ligado a um produto da loja, com a conversão de unidade ("UN em cada MIL" = 1000 para o milheiro de tijolo).
  Na próxima nota do mesmo fornecedor, o item já vem reconhecido pelo código dele, com a mesma conversão; senão,
  pelo código ou nome do produto. O custo de cada item considera desconto, frete, seguro e outras despesas
  da nota e vira o **último custo** do produto. A mesma nota (chave de acesso) não entra duas vezes.
- **Compra numa unidade, venda em outra:** no cadastro do produto, a **unidade de compra** e quanto vem nela
  (vende KG, compra SC com 50). A nota em SC já vem com 50 na conversão; no lançamento à mão, escolha SC ou KG
  na linha (10 SC entram 500 KG, e o custo do saco vira o custo do KG). O estoque fica sempre na unidade de
  venda. O pedido de compra sai em sacos para o fornecedor.
- **Ajuste:** "Contei, o saldo é" (inventário) ou "Somar / tirar" (quebra, avaria), sempre com motivo no extrato.
- **Mínimo por loja:** abaixo dele o produto aparece com o selo **Comprar** e no filtro **Abaixo do mínimo**.
- **Transferência entre lojas:** sai de uma e entra na outra no mesmo momento, com as duas pontas no extrato.
- **Produto sem estoque** (frete, serviço, mão de obra): marque "Não controlar o estoque" no extrato do produto.
- Tudo fica no **extrato** do produto em cada loja: tipo, quantidade, saldo depois, quem fez, pedido ou nota.

## Registro de alterações e senhas cifradas

**Administração → Registro de alterações** mostra quem mudou o quê e quando, com filtros por período,
área, usuário e busca, e exportação para CSV. É gravado pelo próprio banco (gatilhos nas tabelas), então
nenhuma tela ou integração fica de fora, e ninguém altera nem apaga o que foi gravado: nem a aplicação,
nem o dono do banco (um gatilho recusa alteração, exclusão e `truncate`).

- **Produtos e preços:** cadastro, preço, custo, faixas por quantidade e tabelas de preço. No cadastro do
  produto, **Histórico de alterações** abre só as dele (cadastro, preço e estoque).
- **Estoque:** ajuste (inclusive o da contagem aprovada) e transferência, com o motivo.
- **Pedidos:** cancelamento e exclusão, e desconto acima do limite liberado com a senha de outro (fica
  quem lançou e quem liberou). Montar e confirmar orçamento é o dia a dia e não entra.
- **Financeiro:** estorno de recebimento e de pagamento, renegociação de parcela, conta a pagar lançada,
  alterada ou cancelada, sangria e suprimento do caixa, estorno no fiado.
- **Notas fiscais:** nota cancelada, numeração inutilizada e mudança na configuração fiscal.
- **Clientes:** limite de crédito, tabela de preço, vencimento do fiado e exclusão.
- **Usuários e configurações:** usuário criado, alterado (perfil, loja, desconto máximo, senha trocada) ou
  excluído; lojas, formas de pagamento e configurações dos módulos. O que o revendedor faz pelo painel
  aparece como "Suporte (revenda)".
- **Acesso:** cada entrada no sistema e cada tentativa recusada (senha errada, usuário desativado), com o IP.

Senhas e chaves aparecem só como "informada", "alterada" ou "removida": o valor nunca vai para o registro.
O registro começa a valer na versão que o criou.

**Senhas de serviços cifradas:** a conta da ACBr API (client_secret), o CSC da NFC-e e a chave da
EvolutionAPI ficam no banco cifrados com AES-256-GCM, com a chave da variável `SECRETS_KEY` (ou derivada do
`JWT_SECRET`, se ela não existir). Quem tiver só o banco ou um backup não usa as contas da loja. O
`db:migrate` cifra as que estavam em texto e, depois de uma troca de chave, cifra de novo com a nova (a
antiga vai em `SECRETS_KEY_PREVIOUS` até lá). Se o valor não abrir com nenhuma chave, a tela mostra o campo
vazio para informar de novo.

## Rotinas e contagem de estoque

Menu **Operação → Rotinas**, desligado de fábrica: o administrador liga na própria tela e já ganha quatro
modelos prontos para editar. Quem não liga não vê nada.

- **Checklists com agenda:** **Abertura da loja** (seg. a sáb., até 7h30, com foto da frente da loja), **Fechamento
  da loja** (até 18h30), **Recebimento de mercadoria** (quando precisar) e **Contagem de estoque** (toda
  segunda). Cada modelo tem os dias da semana ou um dia do mês, o horário-limite e a loja (ou todas). O item pode
  ser marcar feito, número, texto ou foto (tirada no celular e reduzida antes de subir), obrigatório ou não.
- **Hoje:** cada loja vê o que vence no dia (pendente, atrasada, em andamento, feita) e faz no celular: cada item
  salva na hora, quem marcou fica gravado, e **Concluir** só passa com os obrigatórios. Depois do horário, fica
  **feita com atraso**. O início do sistema avisa o que está pendente ou atrasado.
- **O sistema confere o caixa** (com o financeiro ligado): "caixa aberto hoje" só fica cumprido se houver caixa
  aberto na loja, e "caixas fechados" só quando não sobra nenhum aberto. Sem o financeiro, vale a marcação de
  quem fez.
- **Histórico:** por dia e loja, quantas venceram, quantas foram feitas, com atraso e quais ficaram sem fazer.
- **Contagem cega:** quem conta não vê o saldo do sistema. A contagem do ciclo escolhe os produtos sozinha pela
  curva ABC de 90 dias (A a cada 7 dias, B a cada 30, C a cada 90; a curva A primeiro e, em cada curva, os que
  nunca foram contados ou estão há mais tempo sem contar), até o número de itens configurado (20 de fábrica);
  também dá para montar uma contagem à mão. Busca por código ou código de barras, e cada quantidade salva ao
  sair do campo.
- **Esperado = saldo + vendido e ainda não entregue** (pedido com controle de entrega), que continua na loja.
  O esperado é gravado na hora em que cada item é contado, e o ajuste aprovado é a **diferença** (contado menos
  esperado): uma venda feita entre a contagem e a conferência não é apagada.
- **Conferência (administrador):** depois de enviada, mostra esperado, contado, diferença e valor a custo;
  marque o que ajustar e aprove com um motivo. O ajuste entra no extrato como "Contagem nº X"; o que não for
  marcado fica como ignorado. Quem criou ou o administrador pode cancelar enquanto está contando.

## Compras

Menu **Operação → Compras** (administrador). Não muda nada na venda: quem não usa, não vê.

- **Fornecedores:** a nota de compra cadastra o fornecedor sozinha pelo CNPJ (as notas que já tinham entrado
  também viram cadastro). Dá para cadastrar à mão, com contato e WhatsApp (o CNPJ busca a razão social na
  Receita, com o fiscal configurado). Inativo não aparece para pedidos novos.
- **O que comprar:** os produtos abaixo do mínimo da loja, já descontado o que foi pedido e ainda não chegou,
  com o último fornecedor e o último custo de cada um. Marque, ajuste a quantidade (em sacos, quando o produto
  tem unidade de compra) e **Montar pedido de compra**: sai um rascunho por fornecedor.
- **Pedido de compra:** rascunho → enviado → recebido em parte → recebido. Manda ao fornecedor pelo WhatsApp da
  loja (mensagem com a lista e o PDF), ou baixe o PDF; sem a EvolutionAPI, abre o WhatsApp do aparelho com a
  mensagem pronta. Edita e cancela enquanto nada chegou; recebido em parte, **Encerrar sem o resto**.
- **Receber:** o botão do pedido abre a entrada de nota com o que falta chegar. Importando o XML, o pedido
  aberto do mesmo fornecedor é escolhido sozinho. O que chega é baixado do pedido.

## Entregas e retiradas

Menu **Operação → Entregas** e o quadro **Entregas e retiradas** no detalhe do pedido. O estoque já baixou na
venda; aqui é a logística de quando e como a mercadoria sai.

- **Saldo a entregar por item:** vendido, entregue, agendado e a entregar. Vale para pedidos confirmados
  depois deste controle existir (os antigos não mostram o quadro). No estoque, a coluna **A entregar** mostra o
  que foi vendido e continua na prateleira.
- **Retirada (parcial ou total):** "Registrar retirada" no pedido, com as quantidades que o cliente leva agora.
  O resto continua no saldo (o cliente compra 200 sacos e leva 50 por semana).
- **Agendar:** entrega no endereço (do pedido ou da obra) ou retirada na loja, com dia, período (manhã/tarde) e
  as quantidades. Nunca passa do que falta entregar. Dá para reagendar enquanto não está em rota.
- **Romaneio:** na agenda do dia, marque as entregas e monte o romaneio (veículo, motorista). O PDF traz o
  resumo da carga para conferir o caminhão e cada entrega com espaço para assinatura. "Saiu para entrega" põe
  as entregas em rota; "Veículo voltou" fecha o romaneio, e o que ficou sem comprovante volta para reagendar.
- **Comprovante no celular:** o motorista abre a entrega, toca em **Abrir no mapa** ou no WhatsApp do cliente,
  registra quem recebeu, a assinatura no dedo e uma foto (reduzida no celular antes de enviar).
  **Não foi possível entregar** registra o motivo e devolve a quantidade para o saldo.
- **Estornar** uma entrega já confirmada (registrada por engano, cliente devolveu) é só do admin.
- **Etapa final do fluxo:** quando o pedido chega na última etapa ("Entregue", "Retirado"), o que ainda não tinha
  sido agendado nem entregue é registrado como entregue, para quem só usa o monitor não precisar lançar à mão.
- **Cancelar pedido** desmarca as entregas agendadas; com entrega já feita, o cancelamento é bloqueado até
  estornar as entregas (a mercadoria precisa voltar).
- Atrasadas (agendadas para antes de hoje e não feitas) aparecem em destaque na agenda.
- **Nota fiscal:** com a NF-e (ou NFC-e) do pedido autorizada, o número aparece na agenda, no comprovante (abre o
  DANFE) e em cada entrega do romaneio. Opcional, em **Configurações → Vendas → Entregas**: **exigir nota fiscal
  para o caminhão sair** bloqueia "Saiu para entrega" enquanto algum pedido do romaneio está sem nota
  autorizada (a mensagem diz quais).
- O vendedor vê as entregas e romaneios da própria loja; o admin, de todas. Veículos são cadastrados pelo admin.

## Separação e conferência

Botão **Separação** no pedido confirmado (e **Separar** em cada entrega agendada).

- **Lista de separação (PDF):** o que falta sair do pedido (vendido menos o já entregue) ou só os itens da
  entrega escolhida, sem preços, com caixa para marcar e linhas para quem separou e quem conferiu.
- **Conferência:** bipe o código de cada volume (o leitor de código de barras funciona como teclado) ou digite
  `5*CIM-50` para cinco de uma vez. Código que não é do pedido toca um bipe grave e avisa para deixar o produto
  de lado; passar da quantidade fica em vermelho. Granel sem etiqueta (areia, brita) se ajusta em +/- ou "Tudo".
- **Registrar:** a conferência fica no pedido com quem conferiu, quando e o que foi contado. Com divergência,
  é registrada assim mesmo, com a observação.
- O código lido é o **código do produto** no cadastro.

## Financeiro (opcional)

Desligado por padrão: a venda funciona como sempre. O admin liga em **Administração → Configurações → aba
Financeiro**; aí aparece o menu **Financeiro** (Caixa, Contas a receber e, para o admin, Contas a pagar).

- **Forma de pagamento com condição:** cada forma tem um tipo (dinheiro, PIX, cartão, boleto, crediário,
  outro) e a condição: número de parcelas, dias até o 1º vencimento e entre parcelas. "Crediário 3x" =
  crediário, 3 parcelas, 30 dias, 30 dias. As formas que já existiam recebem o tipo pelo nome.
- **Contas a receber:** pedido confirmado com o financeiro ligado gera as parcelas da forma escolhida (o centavo
  da divisão fica na 1ª), que aparecem no quadro **Pagamento** do pedido. Pedido sem forma gera uma parcela à
  vista; pedidos confirmados antes de ligar o financeiro não geram parcelas. Cancelar o pedido cancela as
  parcelas; com algo já recebido, o cancelamento é bloqueado até estornar o recebimento.
- **Crediário:** só para cliente com limite (em Clientes → Crédito). O pedido é recusado se o cliente tem parcela
  vencida ou se passa do limite somando o que ele já deve em todas as lojas.
- **Caixa:** cada operador abre o seu caixa (com o troco inicial) e recebe as parcelas por ele: busca o cliente
  ou o pedido, recebe parcial ou total, em qualquer forma (crediário é como se vende, não como se paga), com o
  troco calculado no dinheiro. **Sangria** e **suprimento** com motivo. No fechamento, o operador informa o
  dinheiro contado e o sistema mostra a diferença para o esperado (troco + dinheiro recebido + suprimentos −
  sangrias − devoluções e contas pagas em dinheiro). Estorno de recebimento só com o caixa ainda aberto, pelo operador ou pelo admin.
- **PIX:** com a chave PIX da loja configurada, o recebimento em PIX mostra o QR Code com o valor (e o "copia e
  cola"), e o PDF do pedido confirmado na forma PIX sai com o QR Code do que falta pagar. É o PIX estático do
  Banco Central: a confirmação é feita olhando o extrato. Baixa automática precisa de integração com o banco
  (PSP) e não faz parte desta versão.
- O vendedor vê as parcelas e caixas da própria loja; o admin, de todas.
- **Contas a pagar** (administrador): as duplicatas da nota de compra entram na entrada de nota (marcadas
  sozinhas quando o XML traz a cobrança; sem duplicata, uma parcela com o total para 30 dias, editável). Contas
  da loja (aluguel, energia, frete...) em **Nova conta**, em uma ou várias parcelas. Resumo de vencido, hoje,
  7 dias e total em aberto. Pagamento parcial ou total: em **dinheiro do caixa** sai da gaveta do caixa aberto
  (entra no fechamento como "contas pagas"); transferência, PIX, boleto ou cartão saem da conta da loja.
  Estorno volta a conta para aberto (o de dinheiro só com aquele caixa aberto). Conta sem pagamento é
  corrigida ou cancelada.

## Fiado (caderneta)

Módulo próprio, desligado por padrão e independente do financeiro. O admin liga em Configurações → aba Fiado;
aí aparece a forma de pagamento **Fiado** no PDV e o menu **Financeiro → Fiado**.

- **Limite:** o mesmo limite de crédito do cliente (Clientes → Crédito) vale para fiado e crediário juntos.
  Sem limite, o cliente não compra fiado. O PDV mostra quanto ele deve e o disponível ao escolher "Fiado".
- **Compra fiada:** o pedido confirmado na forma Fiado soma na conta do cliente e vence no **dia de vencimento
  do mês seguinte** (padrão da loja ou o do cliente; ex.: compras de outubro vencem dia 10 de novembro).
  Cancelar o pedido tira a compra da conta; se ele já tinha pago, fica com crédito.
- **Bloqueio:** com atraso além da tolerância (padrão: qualquer atraso), o cliente não compra mais fiado até
  pagar.
- **Receber:** parcial ou tudo, em qualquer forma (o troco do dinheiro é calculado). O pagamento abate sempre
  as compras mais antigas. Com o financeiro ligado, o recebimento entra no caixa aberto do operador (e no
  dinheiro esperado da gaveta); sem financeiro, fica só na conta.
- **Encargos (opcionais):** multa (%) e juros ao mês (proporcionais aos dias) sobre o que atrasou, lançados junto
  com o recebimento. Cada pagamento acerta o atraso até a data dele, então nada é cobrado duas vezes. O admin
  pode dispensar.
- **Estorno:** com caixa, pelo operador ou admin enquanto o caixa está aberto; sem caixa, só o admin. Os
  encargos cobrados junto saem também.
- **Extrato** com saldo depois de cada lançamento, em PDF, e **Cobrar**: manda pelo WhatsApp da loja a
  mensagem (editável, com `{cliente}`, `{loja}`, `{saldo}`, `{vencido}`, `{vencimento}`) e o extrato.
- **Ajuste** (admin): saldo da caderneta de papel, acerto ou dívida perdoada, sempre com motivo.

## Devolução e troca

Quadro **Devoluções** no pedido confirmado, botão **Devolução ou troca**.

- **O que volta:** só o que o cliente já levou (entregue ou retirado) e ainda não devolveu; em pedidos de antes
  do controle de entrega, o vendido. O valor de cada item já considera o desconto do pedido.
- **Estoque:** volta para a prateleira da loja do pedido; desmarque "volta" no que veio avariado.
- **Como o valor volta:** dinheiro (com o financeiro ligado, sai do caixa aberto e do dinheiro esperado da
  gaveta), PIX ou estorno no cartão (feitos por fora), **crédito para troca**, abatimento no **fiado** ou nas
  **parcelas em aberto** do pedido (da última para a primeira), ou sem devolver valor (garantia).
- **Troca:** o crédito para troca vira saldo do cliente (vale) e o sistema já abre o pedido novo com ele. No
  PDV, cliente com crédito mostra o saldo e "Usar neste pedido"; o pedido mostra "Pago com crédito" e o que
  falta pagar (também no PDF). As parcelas e o fiado do pedido novo são só do que falta. O crédito sai do
  saldo na confirmação; cancelar o pedido devolve o crédito.
- Pedido com devolução não é cancelado: o resto também se devolve.
- A NF-e de devolução (quando o pedido tem nota) ainda é emitida fora do sistema.

## Retomada de orçamentos

Aba **A retomar** em Pedidos e o aviso na tela inicial ("2 orçamentos para retomar hoje"). Funciona sem
configurar nada.

- **Quando aparece:** orçamento em aberto volta para a lista 3 dias depois do último contato (criação, envio
  do PDF pelo WhatsApp ou retomada registrada), ou no dia combinado com o cliente. Orçamento sem nenhum
  contato há mais de 60 dias sai da lista (continua na aba Orçamentos), para a lista não começar lotada.
- **Retomar:** pelo WhatsApp da loja, com a mensagem pronta (nome do cliente, número e total do orçamento, que
  o vendedor pode ajustar) e, se quiser, o PDF junto; ou registrar uma ligação, visita ou outro contato com
  uma nota. Em todos, escolha o próximo contato: o padrão, amanhã, 1 semana, 15 dias ou outra data.
  Se o WhatsApp falhar, nada é registrado.
- **Histórico:** o quadro **Retomada** no orçamento mostra quando retomar, o último contato e cada conversa
  (quem, como, nota ou mensagem enviada).
- **Fechou ou perdeu:** converter em pedido tira da lista; **Perdido** (na lista ou no orçamento) marca como
  perdido com o motivo. Reabrir o orçamento perdido traz de volta.
- O vendedor vê os orçamentos da própria loja (com "Só os meus" para os dele); o aviso da tela inicial conta
  só os dele. O admin vê a rede.
- **Configurar (opcional):** em Administração → Configurações → aba Retomada, os dias (1 a 60) e a
  mensagem, com `{cliente}`, `{vendedor}`, `{loja}`, `{pedido}` e `{total}`.

## Fluxo de pedidos e monitores

Depois de confirmado, o pedido pode percorrer etapas (ex.: Aguardando faturamento → Em separação →
Pronto para retirada → Retirado). O administrador monta isso em **Administração → Fluxo de pedidos**;
o botão **Começar com o fluxo sugerido** cria os setores Faturamento, Separação e Expedição e um fluxo
para cada tipo de entrega, para ajustar depois.

- **Sem fluxo configurado, nada muda:** o pedido não passa por etapas. Pedidos confirmados antes do
  fluxo existir também ficam sem etapa, para os monitores não começarem cheios de pedidos antigos.
- **Um fluxo por tipo de entrega:** retirada na loja (pedido sem endereço de entrega) ou entrega.
- **Por loja, com modelo da lojamestre:** o fluxo da lojamestre vale para todas as lojas. Uma loja pode
  **personalizar** (copia o modelo e ajusta) ou **montar um só dela**; **Usar o da lojamestre** apaga o
  fluxo próprio e a loja volta ao modelo. Mudar o modelo não mexe no fluxo próprio das lojas.
- **Orçamento não entra no fluxo.** O pedido entra na primeira etapa ao ser confirmado (criado como pedido,
  convertido ou salvo como pedido), no fluxo da loja e do tipo de entrega dele naquele momento.
- **A última etapa é a final:** o pedido que chega nela está concluído e sai dos monitores.
- **Setores:** cada etapa pode ter um setor responsável. Só quem é do setor (marcado no cadastro do usuário)
  avança ou devolve pedidos daquela etapa; etapa sem setor, qualquer pessoa da loja move. O administrador
  move qualquer etapa. O vendedor continua vendo só os pedidos da própria loja.
- **Avançar e voltar:** uma etapa por vez. Voltar aceita um motivo, que fica no histórico do pedido junto
  com quem moveu e quando. Se duas pessoas clicam ao mesmo tempo, só o primeiro clique vale; o segundo
  recebe aviso de que o pedido já mudou.
- **Etapa com pedido não pode ser removida** do fluxo (nem o fluxo inteiro excluído): avance ou devolva
  esses pedidos antes. Renomear e reordenar pode a qualquer momento; o histórico guarda os nomes da época.
- **Prazo (min)** é o tempo esperado na etapa. No monitor, o cartão fica amarelo a partir de 75% do prazo
  e vermelho quando passa dele.
- **Aviso por WhatsApp:** a etapa pode ter uma mensagem enviada ao cliente quando o pedido **avança** para
  ela (voltar não envia). Aceita `{cliente}` (primeiro nome), `{pedido}`, `{loja}` e `{etapa}`. Se o envio
  falhar, a etapa muda do mesmo jeito e a tela avisa que o cliente não foi avisado.

**Monitor** (menu principal): quadro com uma coluna por etapa em andamento, filtrado por setor (abre no
setor da pessoa) e, para o admin, por loja. Etapas com o mesmo nome nos fluxos de retirada e de entrega
viram uma coluna só. Atualiza sozinho a cada 10 segundos (a API é serverless na Vercel, então é consulta
periódica e não WebSocket). **Modo TV** abre o quadro em tela cheia com letras maiores; **Som** toca um bipe
quando chega pedido novo no quadro.

**Manter conectado** (marque uma vez em cada TV): com a opção ligada, o monitor renova a sessão enquanto
está aberto, e a TV não cai a cada 12 horas como as outras sessões. Se o aparelho ficar desligado, a sessão
aguenta 30 dias. Sem a opção, vale a regra normal de 12 horas, para o computador do balcão que só deu uma
olhada no monitor não ficar conectado por um mês. Desativar o usuário ou trocar a senha dele desconecta a TV
na hora. Para as TVs, prefira um usuário próprio por setor (ex.: `tv.separacao`, vendedor da loja, só com o
setor Separação), em vez do login de uma pessoa ou do administrador.

## Banco na VPS

### 1. SSL é obrigatório

Na Vercel, a API acessa o Postgres pela internet e não tem IP fixo, então a porta do banco
fica exposta. **Habilite SSL no Postgres antes de colocar no ar** (`ssl = on` com
certificado no `postgresql.conf`) e use `sslmode=require` na `DATABASE_URL`.
Para validar o certificado, use `sslmode=verify-ca` ou `verify-full` e coloque a CA em `DATABASE_CA_CERT`.

### 2. Usuário sem superpoderes

Superusuários e papéis com `BYPASSRLS` ignoram o Row Level Security; o `npm run db:migrate`
avisa se for o caso. O usuário da aplicação deve ser comum e dono do banco:

```sql
create role app_materialconstrucao login password '...';
create database materialconstrucao owner app_materialconstrucao;
```

### 3. Migrações e primeiro admin

Rodam da sua máquina, apontando para a VPS:

```bash
DATABASE_URL='postgresql://...?sslmode=require' npm run db:migrate
DATABASE_URL='postgresql://...?sslmode=require' npm run db:seed -- --email voce@empresa.com.br --name "Seu Nome"
```

O admin fica na lojamestre `default` (troque com `--tenant`), e o usuário de login é a parte do
e-mail antes do `@` (ou `--username`).

Sem `--password`, o seed gera uma senha e mostra no terminal. Troque-a em
"Alterar senha" depois do primeiro acesso.

Depois disso, as migrações novas de `server/migrations/` rodam sozinhas a cada deploy de
produção na Vercel (`scripts/vercel-build.sh`), com a `DATABASE_URL` da própria Vercel. Se uma
migração falhar, o deploy falha e a versão anterior continua no ar; o motivo aparece no log
do build. Deploys de preview não mexem no banco.

## Deploy na Vercel

1. Importe o repositório na Vercel. O `vercel.json` já define build, saída (`web/dist`),
   a função da API e os redirecionamentos.
2. Em **Settings → Environment Variables**, cadastre:
   - `DATABASE_URL` (com `sslmode=require`)
   - `JWT_SECRET` (aleatório, 32+ caracteres; diferente do local)
   - `SECRETS_KEY` (aleatório, 32+ caracteres): cifra as senhas de serviços no banco. Opcional,
     mas recomendado: sem ela, a chave sai do `JWT_SECRET`, e trocar o `JWT_SECRET` obriga a
     informar de novo a conta da ACBr, o CSC e a chave do WhatsApp
   - `APP_TIMEZONE=America/Sao_Paulo`
   - `DATABASE_CA_CERT`, se usar `verify-ca`/`verify-full`
3. **Região:** a função roda em `gru1` (São Paulo). Cada tela faz algumas consultas
   ao banco em sequência; se a VPS estiver em outra região, troque `regions` no
   `vercel.json` pela região mais próxima dela.
4. Faça o deploy e entre com o admin criado no seed.
5. Em **Administração → Configurações**, clique em **Conectar WhatsApp** e leia o
   QR Code com o celular da loja (precisa de `EVOLUTION_API_URL` e `EVOLUTION_API_KEY`).
   Sem essas variáveis, preencha URL, instância e API Key à mão e use **Testar conexão**.

Na Vercel o cookie de sessão é `Secure` e a API confia no proxy da Vercel
automaticamente. A função tem até 60 s, o que cobre o envio à EvolutionAPI
(timeout padrão de 30 s).

### Rodar fora da Vercel

`npm run build && npm start` sobe a API servindo também o frontend (porta `PORT`, padrão 3000).
Atrás de proxy reverso com HTTPS, defina `TRUST_PROXY=1`.

## EvolutionAPI

O envio usa a API v2: `POST {url}/message/sendMedia/{instância}` com o header `apikey`
e o PDF em base64 (`mediatype: document`). As credenciais ficam na tabela `settings`.

**Conexão automática.** Com `EVOLUTION_API_URL` e `EVOLUTION_API_KEY` (Global API Key)
definidas, o admin de cada loja conecta o WhatsApp sozinho: **Conectar WhatsApp** cria a
instância (`POST /instance/create`, nome `{slug}-{aleatório}`), mostra o QR Code (renovado a
cada 30 s via `GET /instance/connect`) e salva a chave da instância, que é a usada no envio.
**Desconectar** faz logout e apaga a instância. A Global API Key nunca vai para o banco
nem para o navegador. Quem tem servidor próprio ainda pode preencher os dados à mão.
A chave nunca volta inteira para o navegador. Se o envio falhar, o vendedor vê o motivo
e um botão para baixar o PDF e mandar manualmente.

## Módulo fiscal (ACBr API)

Emissão de **NF-e** (modelo 55) e **NFC-e** (modelo 65) a partir dos pedidos e **monitor das notas
recebidas** de fornecedores, tudo pela [ACBr API](https://dev.acbr.api.br/docs/api) (REST, OAuth2
`client_credentials`). A ACBr API assina com o certificado, transmite para a SEFAZ, guarda o XML e
gera o DANFE; aqui fica só o que a tela precisa para listar, numerar e chegar ao documento de lá.

### Configuração

1. **Conta da lojamestre na ACBr API.** Cada lojamestre tem a sua conta (com as próprias empresas,
   certificados, notas e créditos): o admin dela informa o `client_id` e o `client_secret` em
   Configurações → Fiscal e usa **Testar conta**. O `client_secret` nunca volta para o navegador. Não há
   conta da plataforma: sem conta informada, a emissão e o monitor daquela lojamestre ficam bloqueados.
2. **Administração → Configurações → aba Fiscal**: CNPJ (o botão de busca preenche pela Receita),
   razão social, IE, regime tributário (CRT), endereço com código IBGE (o CEP preenche), série e
   próximo número da NF-e e da NFC-e, CSC da NFC-e e o ambiente. **Salvar** grava e já envia o
   cadastro para a ACBr API (`/empresas`, configurações de NF-e, NFC-e e distribuição).
3. **Certificado A1** (.pfx/.p12) na mesma aba. Ele vai direto para a ACBr API; o arquivo e a senha
   não ficam no banco, só o titular e a validade (a tela avisa 30 dias antes de vencer).
4. Comece em **homologação**: as notas saem com "SEM VALOR FISCAL" e não contam na SEFAZ. Ao passar
   para produção, acerte o próximo número para continuar a sequência que a empresa já usa.

O token OAuth2 fica em cache por conta, e a chave do cache inclui o `client_secret` (em hash): uma
lojamestre que digite o `client_id` de outra não aproveita o token dela. Trocar de conta exige o segredo
da conta nova e pede para reenviar a empresa e o certificado, que ficaram na conta antiga.

### Cadastros

- **Produto → aba Fiscal**: NCM (obrigatório na nota), CEST, GTIN (vazio = `SEM GTIN`), CFOP
  (vazio = 5102, ou 5405 com ST), origem, CSOSN (Simples) ou CST (regime normal) com alíquotas,
  PIS/COFINS (no Simples, em branco sai CST 49), IBS/CBS (regime normal) e cBenef. A lista de produtos
  marca "Sem NCM" para o admin achar o que falta.
- **Cliente → aba Cadastro completo**: pessoa física/jurídica, CPF/CNPJ (com dígito verificador; o
  CNPJ alfanumérico de 2026 é aceito), IE e indicador, consumidor final, e-mail e endereço com código
  IBGE. A busca de clientes também acha pelo CPF/CNPJ.

### Emissão

No detalhe de um **pedido confirmado**, o quadro **Nota fiscal** emite a NFC-e (balcão) ou a NF-e.
O servidor monta a nota com os dados do banco (itens, preços e desconto do pedido, rateado entre os
itens ao centavo), nunca com o que vem do navegador.

- Cadastro incompleto devolve a **lista do que falta** (empresa, cliente, cada produto) com atalho
  para corrigir, e o número não é gasto.
- O número é reservado na mesma transação da nota: duas emissões ao mesmo tempo não repetem número, e
  um pedido só tem uma nota em aberto (índice único no banco).
- **Rejeitada** ou com **erro**: corrija o cadastro e use **Reenviar**, com o mesmo número (a SEFAZ não
  consome o número de nota rejeitada). Envio sem resposta é conferido pela referência antes de
  reenviar, para não mandar em dobro. Se o pedido não vai mais ter nota, o admin **inutiliza o número**.
- **Cancelar** é do admin, com justificativa (15 a 255 caracteres). Cancelada ou inutilizada, o pedido
  aceita outra nota. Pedido com nota não pode ser excluído.
- O vendedor emite e consulta as notas da própria loja (RLS, como os pedidos); o admin vê a rede em
  **Operação → Notas fiscais → Notas emitidas**, com DANFE e XML.

### Monitor de notas recebidas

**Operação → Notas fiscais → Notas recebidas** (admin) lista as NF-e emitidas contra o CNPJ da empresa,
trazidas pela distribuição DF-e da SEFAZ. A ACBr API consulta a SEFAZ sozinha a cada poucas horas (configurável); a
tela lê o que já chegou ao abrir, e **Buscar na SEFAZ agora** pede uma consulta na hora (a SEFAZ limita
a uma por hora quando não há nada novo). **Consultar por chave** traz uma nota específica.

Primeiro chega o **resumo**. Dar **ciência da operação** libera a nota completa (DANFE e XML) na
próxima busca; depois o admin confirma, desconhece ou registra "operação não realizada"
(com justificativa). Também dá para ligar a ciência automática. Notas canceladas pelo emitente ficam
marcadas.

Nota completa: **Dar entrada** abre a entrada de estoque já com os itens, a conversão de unidade e as
duplicatas da nota, sem baixar e importar o XML. Depois de lançada, a nota mostra **Entrada nº** no monitor.

### Pacote do contador

**Notas fiscais → Contador** (admin): escolha o mês e **Baixar o pacote** gera um ZIP com os XMLs das notas
emitidas (autorizadas e canceladas, pela data de emissão) e recebidas (as que deram entrada no estoque no mês e
as do monitor emitidas no mês), mais `resumo.csv` (uma linha por nota: tipo, modelo, número, série, chave,
datas, CNPJ/CPF, nome, valor, situação e se o XML está no pacote) e um `LEIA-ME.txt` com os totais. É o que o
escritório importa para a escrituração e o SPED.

Os XMLs ficam guardados no banco: o da nota emitida é baixado da ACBr API na primeira vez (o botão busca os que
faltam, em lotes, antes de montar o ZIP; sem a ACBr API, o pacote sai com o que já está guardado); o da nota
de compra vai junto com a entrada de estoque pelo XML. Entrada lançada à mão (sem XML) aparece só no resumo.
O pacote usa o ambiente atual: em homologação, as notas são de teste e o LEIA-ME avisa.

### Limitações desta versão

- Venda interestadual para consumidor final não contribuinte (DIFAL) e interestadual no regime normal
  (alíquota interestadual do ICMS) são recusadas com aviso; venda dentro da UF e interestadual para
  contribuinte no Simples funcionam.
- ICMS: CSOSN 101, 102, 103, 300, 400, 500 e 900; CST 00, 20, 40, 41, 50 e 60. Sem ICMS-ST próprio
  (CST 10/70), IPI e FCP.
- IBS/CBS: CST 000, 400 e 410, com as alíquotas do período de teste (2026) definidas em Configurações.
- A forma de pagamento vira o código da SEFAZ pelo nome (Dinheiro, PIX, Cartão de crédito/débito,
  Boleto, Crediário...); o que não for reconhecido sai como 99 (outros).
- Os dados da empresa são da lojamestre inteira: lojas com CNPJ próprio (filiais) ainda não emitem
  cada uma com o seu.

## Estrutura

```text
api/index.ts            entrada da Serverless Function (Vercel)
server/migrations/      SQL versionado (schema, RLS)
server/src/app.ts       app Express e rotas
server/src/routes/      auth, lojas, usuários, clientes, produtos, pedidos, configurações, painel
server/src/fiscal/      módulo fiscal: cliente da ACBr API, montagem da NF-e/NFC-e, rotas de emissão e monitor
server/src/pdf/         layout A4 do pedido
server/src/lib/         EvolutionAPI, telefone, formatação, limite de login
server/test/            testes (Vitest + Supertest)
web/src/pages/          telas
web/src/components/pdv/ busca de cliente, busca de produto e carrinho do PDV
web/src/pages/fiscal/   notas emitidas e monitor de notas recebidas
web/src/components/fiscal/ dados da empresa, nota do pedido, endereço com busca de CEP
```
