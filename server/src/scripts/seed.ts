/**
 * Cria o primeiro administrador e, opcionalmente, dados de exemplo.
 *
 *   npm run db:seed -- --email admin@empresa.com.br --name "Fulano" [--password "..."]
 *   npm run db:seed -- --demo
 *
 * Sem --password, gera uma senha aleatória e mostra no terminal.
 * --demo cria duas lojas, um vendedor em cada e um catálogo de exemplo
 * (só se ainda não houver lojas). Não cria clientes, para nenhum teste
 * mandar WhatsApp para um número real por engano.
 */
import { randomBytes } from 'node:crypto';
import { parseArgs } from 'node:util';
import { hashPassword } from '../auth.js';
import { loadEnvFile } from '../config.js';
import { createPool } from '../db/pool.js';
import { withTransaction } from '../db/session.js';

const { values } = parseArgs({
  options: {
    email: { type: 'string' },
    name: { type: 'string', default: 'Administrador' },
    password: { type: 'string' },
    demo: { type: 'boolean', default: false },
  },
});

loadEnvFile();
const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error('Defina DATABASE_URL.');
  process.exit(1);
}
if (!values.email && !values.demo) {
  console.error('Informe --email para criar o administrador e/ou --demo para dados de exemplo.');
  process.exit(1);
}

const DEMO_PASSWORD = 'demo1234';

const DEMO_PRODUCTS: [code: string, name: string, unit: string, price: number][] = [
  ['CIM-CP2', 'Cimento CP II-E-32 50 kg', 'SC', 38.9],
  ['CIM-CP5', 'Cimento CP V-ARI 40 kg', 'SC', 41.5],
  ['ARG-AC1', 'Argamassa AC-I interna 20 kg', 'SC', 18.5],
  ['ARG-AC3', 'Argamassa AC-III 20 kg', 'SC', 42.9],
  ['CAL-HID', 'Cal hidratada CH-III 20 kg', 'SC', 16.9],
  ['ARE-MED', 'Areia média lavada', 'M³', 145],
  ['BRI-01', 'Brita 1', 'M³', 160],
  ['TIJ-8F', 'Tijolo cerâmico 8 furos 9x19x19', 'UN', 1.35],
  ['BLO-14', 'Bloco de concreto 14x19x39', 'UN', 4.2],
  ['VER-08', 'Vergalhão CA-50 8 mm barra 12 m', 'BR', 36.5],
  ['VER-10', 'Vergalhão CA-50 10 mm barra 12 m', 'BR', 54.9],
  ['ARA-18', 'Arame recozido nº 18', 'KG', 19.9],
  ['TEL-Q92', 'Tela soldada Q-92 2 x 3 m', 'PC', 89],
  ['PRE-1727', 'Prego com cabeça 17x27', 'KG', 18.9],
  ['TUB-25', 'Tubo PVC soldável 25 mm barra 6 m', 'BR', 24.9],
  ['TUB-100', 'Tubo PVC esgoto 100 mm barra 6 m', 'BR', 69.9],
  ['JOE-25', 'Joelho PVC soldável 90° 25 mm', 'UN', 1.8],
  ['CAB-25', 'Cabo flexível 2,5 mm² rolo 100 m', 'RL', 239],
  ['CAB-40', 'Cabo flexível 4 mm² rolo 100 m', 'RL', 379],
  ['TIN-ACR18', 'Tinta acrílica fosca branco neve 18 L', 'LT', 389],
  ['MAS-COR25', 'Massa corrida PVA 25 kg', 'UN', 79.9],
  ['IMP-18', 'Impermeabilizante acrílico 18 L', 'UN', 259],
  ['POR-6060', 'Porcelanato acetinado 60x60 cm', 'M²', 79.9],
  ['REJ-CZ1', 'Rejunte flexível cinza 1 kg', 'KG', 9.9],
  ['TEL-FIB6', 'Telha de fibrocimento 2,44 x 1,10 m 6 mm', 'UN', 69.9],
  ['CXA-1000', "Caixa d'água polietileno 1.000 L", 'UN', 499],
];

const pool = createPool(databaseUrl, { caCert: process.env.DATABASE_CA_CERT });
try {
  await withTransaction(pool, async (db) => {
    if (values.demo) {
      const { rows } = await db.query('select count(*) as total from stores');
      if (Number(rows[0].total) > 0) {
        console.log('Já existem lojas cadastradas; dados de exemplo não foram criados.');
      } else {
        const stores = await db.query<{ id: number; name: string }>(
          `insert into stores (name, address, phone) values
             ('Loja Centro', 'Av. Brasil, 1500 - Centro', '(11) 3333-1000'),
             ('Loja Jardim', 'Rua das Palmeiras, 320 - Jardim América', '(11) 3333-2000')
           returning id, name`,
        );
        const demoHash = await hashPassword(DEMO_PASSWORD);
        const [centro, jardim] = stores.rows;
        await db.query(
          `insert into users (name, email, password_hash, role, store_id) values
             ('Carlos Vendedor', 'carlos@demo.local', $1, 'seller', $2),
             ('Joana Vendedora', 'joana@demo.local', $1, 'seller', $3)`,
          [demoHash, centro!.id, jardim!.id],
        );
        await db.query(
          `insert into products (code, name, unit, price)
           select * from unnest($1::text[], $2::text[], $3::text[], $4::numeric[])`,
          [
            DEMO_PRODUCTS.map((p) => p[0]),
            DEMO_PRODUCTS.map((p) => p[1]),
            DEMO_PRODUCTS.map((p) => p[2]),
            DEMO_PRODUCTS.map((p) => p[3]),
          ],
        );
        console.log(`Dados de exemplo criados: 2 lojas, ${DEMO_PRODUCTS.length} produtos e 2 vendedores.`);
        console.log(`  carlos@demo.local (Loja Centro) e joana@demo.local (Loja Jardim), senha ${DEMO_PASSWORD}`);
      }
    }

    if (values.email) {
      const email = values.email.trim().toLowerCase();
      const existing = await db.query('select 1 from users where lower(email) = $1', [email]);
      if (existing.rowCount) {
        console.log(`O usuário ${email} já existe; nada foi alterado.`);
        return;
      }
      const password = values.password ?? randomBytes(9).toString('base64url');
      if (password.length < 8) throw new Error('A senha precisa ter pelo menos 8 caracteres.');
      const firstStore = await db.query<{ id: number }>('select id from stores order by id limit 1');
      await db.query(
        `insert into users (name, email, password_hash, role, store_id) values ($1, $2, $3, 'admin', $4)`,
        [values.name, email, await hashPassword(password), firstStore.rows[0]?.id ?? null],
      );
      console.log(`Administrador criado: ${email}`);
      if (!values.password) console.log(`Senha gerada: ${password}  (troque em "Alterar senha" depois do primeiro acesso)`);
    }
  });
} catch (err) {
  console.error((err as Error).message);
  process.exitCode = 1;
} finally {
  await pool.end();
}
