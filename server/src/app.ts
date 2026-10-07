import cookieParser from 'cookie-parser';
import express from 'express';
import helmet from 'helmet';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { authenticate, requireAdmin } from './auth.js';
import type { AppContext } from './context.js';
import { errorHandler } from './errors.js';
import { authRouter } from './routes/auth.js';
import { clientsRouter } from './routes/clients.js';
import { dashboardRouter } from './routes/dashboard.js';
import { ordersRouter } from './routes/orders.js';
import { productsRouter } from './routes/products.js';
import { settingsRouter } from './routes/settings.js';
import { storesRouter } from './routes/stores.js';
import { usersRouter } from './routes/users.js';

// Mensagens padrão de validação em português.
z.config(z.locales.ptBR());

const DEFAULT_WEB_DIST = fileURLToPath(new URL('../../web/dist/', import.meta.url));

export function createApp(ctx: AppContext) {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', ctx.config.trustProxy);

  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          // Servido por HTTP puro (sem TLS), o upgrade quebraria o carregamento dos arquivos.
          upgradeInsecureRequests: ctx.config.cookieSecure ? [] : null,
        },
      },
    }),
  );
  app.use(express.json({ limit: '1mb' }));
  app.use(cookieParser());

  const api = express.Router();
  api.use('/auth', authRouter(ctx));
  api.use(authenticate(ctx));
  api.use('/dashboard', dashboardRouter(ctx));
  api.use('/clients', clientsRouter(ctx));
  api.use('/products', productsRouter(ctx));
  api.use('/orders', ordersRouter(ctx));
  api.use('/stores', requireAdmin, storesRouter(ctx));
  api.use('/users', requireAdmin, usersRouter(ctx));
  api.use('/settings', requireAdmin, settingsRouter(ctx));
  api.use((_req, res) => {
    res.status(404).json({ error: 'Rota não encontrada.' });
  });
  app.use('/api', api);

  // Em produção a própria API entrega o frontend (build do Vite).
  const webDist = ctx.config.webDistDir ?? DEFAULT_WEB_DIST;
  const indexHtml = path.join(webDist, 'index.html');
  if (existsSync(indexHtml)) {
    app.use('/assets', express.static(path.join(webDist, 'assets'), { immutable: true, maxAge: '1y' }));
    app.use(express.static(webDist, { index: false }));
    app.use((req, res, next) => {
      if (req.method !== 'GET' && req.method !== 'HEAD') return next();
      res.setHeader('Cache-Control', 'no-cache');
      res.sendFile(indexHtml);
    });
  }

  app.use(errorHandler);
  return app;
}
