# Balcão: pedidos e orçamentos

Sistema de pedidos e orçamentos para o balcão das lojas da rede. O vendedor lança o
orçamento ou pedido pelo teclado e envia o PDF ao cliente pelo WhatsApp (EvolutionAPI)
com um clique.

- **Frontend:** React 19, Vite 8, Tailwind 4, componentes no padrão shadcn/ui (`web/`)
- **API:** Node + Express 5 + `pg` (`server/`), publicada como Serverless Function na Vercel (`api/index.ts`)
- **Banco:** PostgreSQL, com Row Level Security isolando os pedidos por loja
- **PDF:** gerado no servidor com pdfkit, a partir dos dados do banco (os totais nunca vêm do navegador)

## Acesso (banco da VPS)

O banco em `76.13.237.176:15432/materialconstrucao` foi provisionado em 2026-10-07.
Senhas geradas pelo seed — **troque em "Alterar senha" depois do primeiro login**:

| Usuário | Perfil | Loja | Senha |
| --- | --- | --- | --- |
| `admin@empresa.com.br` | admin | Loja Centro | `HHgploAUoY8k` |
| `carlos@demo.local` | vendedor | Loja Centro | `demo1234` |
| `joana@demo.local` | vendedor | Loja Jardim | `demo1234` |

26 produtos de catálogo e 2 lojas (Centro / Jardim) já estão semeados. Não há clientes —
crie pelo PDV quando for testar o WhatsApp, para não mandar mensagem a um número real.

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
- WhatsApp do cliente é guardado só com dígitos e DDI (`(11) 98765-4321` vira `5511987654321`).
  Número de outro país deve começar com `+`.
- Produto usado em pedidos não pode ser excluído; desative-o para tirá-lo da busca.

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
"Alterar senha" depois do primeiro acesso. Rode `db:migrate` de novo sempre que
houver arquivo novo em `server/migrations/`.

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
5. Em **Administração → Configurações**, preencha URL, instância e API Key da
   EvolutionAPI e use **Testar conexão**.

Na Vercel o cookie de sessão é `Secure` e a API confia no proxy da Vercel
automaticamente. A função tem até 60 s, o que cobre o envio à EvolutionAPI
(timeout padrão de 30 s).

### Rodar fora da Vercel

`npm run build && npm start` sobe a API servindo também o frontend (porta `PORT`, padrão 3000).
Atrás de proxy reverso com HTTPS, defina `TRUST_PROXY=1`.

## EvolutionAPI

O envio usa a API v2: `POST {url}/message/sendMedia/{instância}` com o header `apikey`
e o PDF em base64 (`mediatype: document`). As credenciais ficam na tabela `settings`.
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
