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
quando chega pedido novo no quadro. O login da TV segue a regra das outras sessões e expira em 12 horas.

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
