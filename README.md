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

O `--demo` cria duas lojas, um catálogo de exemplo e dois vendedores
(`carlos@demo.local` na Loja Centro e `joana@demo.local` na Loja Jardim, senha `demo1234`).
Ele não cria clientes, para nenhum teste mandar WhatsApp a um número real por engano.
**Não use `--demo` em produção.**

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
- Sem trava de estoque (V1).
- **Desconto** vale para o pedido inteiro, em percentual (até 100%) ou em valor (até o valor dos produtos).
  O servidor calcula subtotal, desconto e total; o total da listagem, do painel e do WhatsApp já vem com desconto.
  Ao editar o orçamento, o desconto é recalculado sobre os itens novos (o percentual continua o mesmo).
- **Endereço de entrega** é opcional (em branco = cliente retira na loja) e sai no PDF.
- WhatsApp do cliente é guardado só com dígitos e DDI (`(11) 98765-4321` vira `5511987654321`).
  Número de outro país deve começar com `+`.
- **O mesmo WhatsApp não pode ficar em dois cadastros de cliente.** Ao salvar um número que
  outro cliente já usa, nada é gravado: o sistema mostra os cadastros que já têm aquele número e
  o vendedor escolhe qual usar (ou volta e corrige o número). O índice único no banco garante a
  regra mesmo quando duas pessoas salvam ao mesmo tempo — a segunda recebe o aviso em vez de criar
  a duplicata.
- Produto usado em pedidos não pode ser excluído; desative-o para tirá-lo da busca.
- **Forma de pagamento** (opcional) é escolhida no orçamento ou pedido e sai no PDF. O administrador
  cadastra as formas em Administração → Formas de pagamento; toda lojamestre começa com Dinheiro, PIX,
  Cartão de débito, Cartão de crédito e Boleto. O pedido guarda o nome da forma da época, e forma usada
  em pedidos não pode ser excluída, só desativada (sai da lista, mas o orçamento que já a tinha continua com ela).

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
  **Fiscal → Notas emitidas**, com DANFE e XML.

### Monitor de notas recebidas

**Fiscal → Notas recebidas** (admin) lista as NF-e emitidas contra o CNPJ da empresa, trazidas pela
distribuição DF-e da SEFAZ. A ACBr API consulta a SEFAZ sozinha a cada poucas horas (configurável); a
tela lê o que já chegou ao abrir, e **Buscar na SEFAZ agora** pede uma consulta na hora (a SEFAZ limita
a uma por hora quando não há nada novo). **Consultar por chave** traz uma nota específica.

Primeiro chega o **resumo**. Dar **ciência da operação** libera a nota completa (DANFE e XML) na
próxima busca; depois o admin confirma, desconhece ou registra "operação não realizada"
(com justificativa). Também dá para ligar a ciência automática. Notas canceladas pelo emitente ficam
marcadas.

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
