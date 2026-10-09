import { Router } from 'express';
import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { currentUser } from '../auth.js';
import type { AppContext } from '../context.js';
import { HttpError } from '../errors.js';
import { withSession } from '../db/session.js';
import type { Db } from '../db/pool.js';
import {
  connectInstance,
  createInstance,
  deleteInstance,
  describeEvolutionError,
  EvolutionError,
  getConnectionState,
  keySourceOf,
  loadEvolutionSettings,
  type EvolutionQrCode,
} from '../lib/evolution.js';

const settingsSchema = z.object({
  evolution_api_url: z
    .string()
    .trim()
    .pipe(z.url({ protocol: /^https?$/, error: 'Informe a URL completa, começando com http:// ou https://.' }))
    .transform((url) => url.replace(/\/+$/, '')),
  evolution_instance: z.string().trim().min(1, 'Informe o nome da instância.').max(100),
  // Vazio mantém a chave já salva.
  evolution_api_token: z.preprocess(
    (v) => (typeof v === 'string' && v.trim() === '' ? undefined : v),
    z.string().trim().max(500).optional(),
  ),
});

type SettingsRow = {
  evolution_api_url: string | null;
  evolution_instance: string | null;
  evolution_api_token: string | null;
  updated_at: Date;
};

const SETTINGS_COLUMNS = 'evolution_api_url, evolution_instance, evolution_api_token, updated_at';

/** Nome da instância na EvolutionAPI: identifica a loja no painel e não colide entre conexões. */
function newInstanceName(slug: string) {
  return `${slug}-${randomBytes(3).toString('hex')}`;
}

async function saveSettings(
  db: Db,
  tenantId: number,
  values: { url: string | null; instance: string | null; token: string | null },
) {
  const { rows } = await db.query<SettingsRow>(
    `insert into settings (tenant_id, evolution_api_url, evolution_instance, evolution_api_token)
     values ($4, $1, $2, $3)
     on conflict (tenant_id) do update
        set evolution_api_url = excluded.evolution_api_url,
            evolution_instance = excluded.evolution_instance,
            evolution_api_token = excluded.evolution_api_token,
            updated_at = now()
     returning ${SETTINGS_COLUMNS}`,
    [values.url, values.instance, values.token, tenantId],
  );
  return rows[0]!;
}

/** Credenciais da EvolutionAPI. Montado só para administradores. */
export function settingsRouter(ctx: AppContext) {
  const router = Router();
  const server = ctx.config.evolutionServer;
  const timeoutMs = ctx.config.evolutionTimeoutMs;

  /** Instância criada por nós no servidor da plataforma (e não configurada à mão). */
  const isManaged = (row: Pick<SettingsRow, 'evolution_api_url' | 'evolution_instance'>) =>
    Boolean(server && row.evolution_instance && row.evolution_api_url === server.url);

  /** A chave nunca volta inteira para o navegador. */
  function toPublicSettings(row: SettingsRow) {
    const token = row.evolution_api_token;
    const managed = isManaged(row);
    return {
      // O endereço do servidor da plataforma fica só no servidor.
      evolution_api_url: managed ? null : row.evolution_api_url,
      evolution_instance: row.evolution_instance,
      has_token: Boolean(token),
      token_hint: token ? `••••${token.slice(-4)}` : null,
      updated_at: row.updated_at,
      auto_connect_available: Boolean(server),
      managed,
    };
  }

  router.get('/', async (req, res) => {
    const me = currentUser(req);
    const result = await withSession(ctx.pool, me, async (db) => {
      const { rows } = await db.query<SettingsRow>(
        `select ${SETTINGS_COLUMNS} from settings where tenant_id = $1`,
        [me.tenant_id],
      );
      if (!rows[0]) {
        // RLS nunca deixa um tenant sem settings — garantido pelo /super ao criar
        // lojamestre. Mas em migração 005 antiga, pode haver tenant sem linha:
        // devolve settings vazias sem 500.
        return { evolution_api_url: null, evolution_instance: null, evolution_api_token: null, updated_at: new Date() };
      }
      return rows[0];
    });
    res.json({ settings: toPublicSettings(result) });
  });

  router.put('/', async (req, res) => {
    const me = currentUser(req);
    const body = settingsSchema.parse(req.body);

    const result = await withSession(ctx.pool, me, async (db) => {
      let hasToken = false;
      if (!body.evolution_api_token) {
        const current = await db.query<{ has_token: boolean }>(
          'select evolution_api_token is not null as has_token from settings where tenant_id = $1',
          [me.tenant_id],
        );
        hasToken = current.rows[0]?.has_token ?? false;
        if (!hasToken) throw new HttpError(400, 'Informe a API Key da EvolutionAPI.');
      }
      const { rows } = await db.query<SettingsRow>(
        `update settings
            set evolution_api_url = $1,
                evolution_instance = $2,
                evolution_api_token = coalesce($3, evolution_api_token),
                updated_at = now()
          where tenant_id = $4
         returning ${SETTINGS_COLUMNS}`,
        [body.evolution_api_url, body.evolution_instance, body.evolution_api_token ?? null, me.tenant_id],
      );
      return rows[0]!;
    });
    res.json({ settings: toPublicSettings(result) });
  });

  router.post('/test', async (req, res) => {
    const me = currentUser(req);
    const settings = await withSession(ctx.pool, me, (db) => loadEvolutionSettings(db, me.tenant_id));
    if (!settings) throw new HttpError(422, 'Salve a URL, a instância e a API Key antes de testar.');
    try {
      const state = await getConnectionState(settings, ctx.config.evolutionTimeoutMs);
      res.json({ state });
    } catch (err) {
      throw new HttpError(502, describeEvolutionError(err, keySourceOf(settings, server)));
    }
  });

  /**
   * Conexão automática: cria a instância da loja no servidor da plataforma (ou
   * reaproveita a que já existe) e devolve o QR Code para ler no celular.
   */
  router.post('/whatsapp/connect', async (req, res) => {
    const me = currentUser(req);
    if (!server) {
      throw new HttpError(422, 'A conexão automática não está disponível. Preencha os dados da EvolutionAPI manualmente.');
    }

    const current = await withSession(ctx.pool, me, async (db) => {
      const { rows } = await db.query<SettingsRow & { slug: string }>(
        `select ${SETTINGS_COLUMNS}, t.slug
           from tenants t left join settings s on s.tenant_id = t.id
          where t.id = $1`,
        [me.tenant_id],
      );
      return rows[0]!;
    });

    let qr: EvolutionQrCode | null = null;
    try {
      if (isManaged(current)) {
        try {
          qr = await connectInstance(server, current.evolution_instance!, timeoutMs);
        } catch (err) {
          // Apagada no painel da EvolutionAPI: cria outra abaixo.
          if (!(err instanceof EvolutionError && err.status === 404)) throw err;
        }
      }
      if (!qr) {
        const name = newInstanceName(current.slug);
        const created = await createInstance(server, { name, token: randomBytes(24).toString('hex') }, timeoutMs);
        await withSession(ctx.pool, me, (db) =>
          saveSettings(db, me.tenant_id, { url: server.url, instance: name, token: created.token }),
        );
        qr = created.qrcode ? created : await connectInstance(server, name, timeoutMs);
      }
    } catch (err) {
      console.error('Falha ao conectar a instância na EvolutionAPI:', err);
      throw new HttpError(502, describeEvolutionError(err, 'platform'));
    }

    res.json({ state: qr.state, qrcode: qr.qrcode, pairing_code: qr.pairingCode });
  });

  /** Desconecta o WhatsApp: apaga a instância criada por nós e limpa as credenciais. */
  router.post('/whatsapp/disconnect', async (req, res) => {
    const me = currentUser(req);
    const current = await withSession(ctx.pool, me, async (db) => {
      const { rows } = await db.query<SettingsRow>(`select ${SETTINGS_COLUMNS} from settings where tenant_id = $1`, [
        me.tenant_id,
      ]);
      return rows[0];
    });
    if (server && current && isManaged(current)) {
      try {
        await deleteInstance(server, current.evolution_instance!, timeoutMs);
      } catch (err) {
        console.error('Falha ao apagar a instância na EvolutionAPI:', err);
        throw new HttpError(502, describeEvolutionError(err, 'platform'));
      }
    }
    const result = await withSession(ctx.pool, me, (db) =>
      saveSettings(db, me.tenant_id, { url: null, instance: null, token: null }),
    );
    res.json({ settings: toPublicSettings(result) });
  });

  return router;
}