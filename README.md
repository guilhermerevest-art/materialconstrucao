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
  por WhatsApp. Pedido com NF-e autorizada ou em processamento só é cancelado depois de cancelar a nota.
  Excluir (só admin) continua apagando de vez.
- Produto usado em pedidos não pode ser excluído; desative-o para tirá-lo da busca.
- **Forma de pagamento** (opcional) é escolhida no orçamento ou pedido e sai no PDF. O administrador
  cadastra as formas em Administração → Formas de pagamento; toda lojamestre começa com Dinheiro, PIX,
  Cartão de débito, Cartão de crédito e Boleto. O pedido guarda o nome da forma da época, e forma usada
  em pedidos não pode ser excluída, só desativada (sai da lista, mas o orçamento que já a tinha continua com ela).

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
  ligado a um produto da loja, com a conversão de unidade ("UN por MIL" = 1000 para o milheiro de tijolo). Na
  próxima nota do mesmo fornecedor, o item já vem reconhecido pelo código dele, com a mesma conversão; senão,
  pelo código ou nome do produto. O custo de cada item considera desconto, frete, seguro e outras despesas
  da nota e vira o **último custo** do produto. A mesma nota (chave de acesso) não entra duas vezes.
- **Ajuste:** "Contei, o saldo é" (inventário) ou "Somar / tirar" (quebra, avaria), sempre com motivo no extrato.
- **Mínimo por loja:** abaixo dele o produto aparece com o selo **Comprar** e no filtro **Abaixo do mínimo**.
- **Transferência entre lojas:** sai de uma e entra na outra no mesmo momento, com as duas pontas no extrato.
- **Produto sem estoque** (frete, serviço, mão de obra): marque "Não controlar o estoque" no extrato do produto.
- Tudo fica no **extrato** do produto em cada loja: tipo, quantidade, saldo depois, quem fez, pedido ou nota.

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
- O vendedor vê as entregas e romaneios da própria loja; o admin, de todas. Veículos são cadastrados pelo admin.

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

## Estrutura

```text
api/index.ts            entrada da Serverless Function (Vercel)
server/migrations/      SQL versionado (schema, RLS)
server/src/app.ts       app Express e rotas
server/src/routes/      auth, lojas, usuários, clientes, produtos, pedidos, configurações, painel
server/src/pdf/         layout A4 do pedido
server/src/lib/         EvolutionAPI, telefone, formatação, limite de login
server/test/            testes (Vitest + Supertest)
web/src/pages/          telas
web/src/components/pdv/ busca de cliente, busca de produto e carrinho do PDV
```
