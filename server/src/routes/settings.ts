import { Router } from 'express';
import { z } from 'zod';
import { currentUser } from '../auth.js';
import type { AppContext } from '../context.js';
import { HttpError } from '../errors.js';
import { withSession } from '../db/session.js';
import { describeEvolutionError, getConnectionState, loadEvolutionSettings } from '../lib/evolution.js';

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

/** A chave nunca volta inteira para o navegador. */
function toPublicSettings(row: SettingsRow) {
  const token = row.evolution_api_token;
  return {
    evolution_api_url: row.evolution_api_url,
    evolution_instance: row.evolution_instance,
    has_token: Boolean(token),
    token_hint: token ? `••••${token.slice(-4)}` : null,
    updated_at: row.updated_at,
  };
}

/** Credenciais da EvolutionAPI. Montado só para administradores. */
export function settingsRouter(ctx: AppContext) {
  const router = Router();

  router.get('/', async (req, res) => {
    const me = currentUser(req);
    const result = await withSession(ctx.pool, me, async (db) => {
      const { rows } = await db.query<SettingsRow>(
        'select evolution_api_url, evolution_instance, evolution_api_token, updated_at from settings where tenant_id = $1',
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
         returning evolution_api_url, evolution_instance, evolution_api_token, updated_at`,
        [body.evolution_api_url, body.evolution_instance, body.evolution_api_token ?? null, me.tenant_id],
      );
      return rows[0]!;
    });
    res.json({ settings: toPublicSettings(result) });
  });

  router.post('/test', async (req, res) => {
    const me = currentUser(req);
    const settings = await loadEvolutionSettings(ctx.pool, me.tenant_id);
    if (!settings) throw new HttpError(422, 'Salve a URL, a instância e a API Key antes de testar.');
    try {
      const state = await getConnectionState(settings, ctx.config.evolutionTimeoutMs);
      res.json({ state });
    } catch (err) {
      throw new HttpError(502, describeEvolutionError(err));
    }
  });

  return router;
}