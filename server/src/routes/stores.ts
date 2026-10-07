import { Router } from 'express';
import { z } from 'zod';
import type { AppContext } from '../context.js';
import { HttpError } from '../errors.js';
import { optionalText, parseId } from '../lib/validation.js';

const storeSchema = z.object({
  name: z.string().trim().min(2, 'Informe o nome da loja.').max(120),
  address: optionalText(300),
  phone: optionalText(40),
});

const logoSchema = z.object({
  data: z.string().trim().min(1, 'Envie a imagem da logo.'),
  mime: z.enum(['image/png', 'image/jpeg', 'image/webp'], {
    error: 'Formato de imagem não aceito. Envie a logo em PNG, JPEG ou WebP.',
  }),
});

// A API aceita 1 MB de JSON (express.json em app.ts) e o base64 infla o arquivo em
// cerca de 33%. Com 500 KB de imagem o texto tem ~667 KB e ainda sobra espaço para
// o resto do corpo.
const MAX_LOGO_BYTES = 500 * 1024;

const BASE64_PATTERN = /^[A-Za-z0-9+/]+={0,2}$/;

type StoreLogoRow = { logo_data: string | null; logo_mime: string | null };
type Logo = { data: string; bytes: Buffer };

/**
 * Lê a imagem enviada e devolve o base64 limpo e os bytes. O tamanho é medido nos
 * bytes, não na string: o base64 não confia no comprimento, e é o arquivo decodificado
 * que interessa. Buffer.from() aceita qualquer caractere inválido trocando por lixo
 * em vez de falhar, então a string é conferida antes de virar buffer.
 */
function readLogo(data: string): Logo {
  // Aceita o prefixo "data:" que o FileReader do navegador gera, mesmo que a API
  // exija base64 puro: guardar o prefixo quebraria quem lê a coluna direto.
  const base64 = data.replace(/^data:[^,]*;base64,/i, '');
  if (!BASE64_PATTERN.test(base64) || base64.length % 4 !== 0) {
    throw new HttpError(400, 'A imagem enviada não está em base64 válido.');
  }
  return { data: base64, bytes: Buffer.from(base64, 'base64') };
}

const STORE_COLUMNS = `s.id, s.name, s.address, s.phone, s.created_at,
  (s.logo_data is not null) as has_logo,
  (select count(*) from users u where u.store_id = s.id and u.active) as users_count`;

const NOT_FOUND = 'Loja não encontrada.';
const LOGO_NOT_FOUND = 'Esta loja não tem logo.';

/** Cadastro de lojas. Montado só para administradores. */
export function storesRouter(ctx: AppContext) {
  const router = Router();

  router.get('/', async (_req, res) => {
    const { rows } = await ctx.pool.query(`select ${STORE_COLUMNS} from stores s order by s.name`);
    res.json({ items: rows });
  });

  router.get('/:id', async (req, res) => {
    const id = parseId(req.params.id, NOT_FOUND);
    const { rows } = await ctx.pool.query(`select ${STORE_COLUMNS} from stores s where s.id = $1`, [id]);
    if (!rows[0]) throw new HttpError(404, NOT_FOUND);
    res.json({ store: rows[0] });
  });

  router.post('/', async (req, res) => {
    const body = storeSchema.parse(req.body);
    const { rows } = await ctx.pool.query(
      `with inserted as (insert into stores (name, address, phone) values ($1, $2, $3) returning *)
       select ${STORE_COLUMNS} from inserted s`,
      [body.name, body.address, body.phone],
    );
    res.status(201).json({ store: rows[0] });
  });

  router.put('/:id', async (req, res) => {
    const id = parseId(req.params.id, NOT_FOUND);
    const body = storeSchema.parse(req.body);
    const { rows } = await ctx.pool.query(
      `with updated as (update stores set name = $2, address = $3, phone = $4 where id = $1 returning *)
       select ${STORE_COLUMNS} from updated s`,
      [id, body.name, body.address, body.phone],
    );
    if (!rows[0]) throw new HttpError(404, NOT_FOUND);
    res.json({ store: rows[0] });
  });

  router.delete('/:id', async (req, res) => {
    const id = parseId(req.params.id, NOT_FOUND);
    const { rowCount } = await ctx.pool.query('delete from stores where id = $1', [id]);
    if (!rowCount) throw new HttpError(404, NOT_FOUND);
    res.status(204).end();
  });

  // Rota separada da logo porque a imagem sai do banco sob demanda: a listagem devolve
  // só o booleano has_logo, para a tela de clientes não baixar base64 de todas as lojas.

  router.get('/:id/logo', async (req, res) => {
    const id = parseId(req.params.id, NOT_FOUND);
    const { rows } = await ctx.pool.query<StoreLogoRow>(
      'select logo_data, logo_mime from stores where id = $1',
      [id],
    );
    const store = rows[0];
    if (!store) throw new HttpError(404, NOT_FOUND);
    if (!store.logo_data || !store.logo_mime) throw new HttpError(404, LOGO_NOT_FOUND);
    res.json({ mime: store.logo_mime, data: store.logo_data });
  });

  router.put('/:id/logo', async (req, res) => {
    const id = parseId(req.params.id, NOT_FOUND);
    const body = logoSchema.parse(req.body);
    const logo = readLogo(body.data);
    if (logo.bytes.byteLength === 0) throw new HttpError(400, 'A imagem enviada está vazia.');
    if (logo.bytes.byteLength > MAX_LOGO_BYTES) {
      throw new HttpError(400, 'A logo deve ter no máximo 500 KB.');
    }
    const { rows } = await ctx.pool.query(
      `with updated as (update stores set logo_data = $2, logo_mime = $3 where id = $1 returning *)
       select ${STORE_COLUMNS} from updated s`,
      [id, logo.data, body.mime],
    );
    if (!rows[0]) throw new HttpError(404, NOT_FOUND);
    res.json({ store: rows[0] });
  });

  router.delete('/:id/logo', async (req, res) => {
    const id = parseId(req.params.id, NOT_FOUND);
    // Update, não delete: a loja precisa existir, mas apagar a logo de uma loja que
    // já não tem logo não é erro.
    const { rowCount } = await ctx.pool.query(
      'update stores set logo_data = null, logo_mime = null where id = $1',
      [id],
    );
    if (!rowCount) throw new HttpError(404, NOT_FOUND);
    res.status(204).end();
  });

  return router;
}