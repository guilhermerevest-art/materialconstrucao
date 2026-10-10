import { Router } from 'express';
import type { AppContext } from '../context.js';
import { fiscalAccountantRouter } from './accountantRoutes.js';
import { fiscalDocumentsRouter } from './documentsRoutes.js';
import { fiscalInboundRouter } from './inboundRoutes.js';
import { fiscalLookupRouter, fiscalSettingsRouter } from './settingsRoutes.js';

/**
 * Módulo fiscal (ACBr API): dados da empresa emitente, emissão de NF-e e NFC-e a
 * partir dos pedidos e monitor das notas recebidas de fornecedores.
 */
export function fiscalRouter(ctx: AppContext) {
  const router = Router();
  router.use('/settings', fiscalSettingsRouter(ctx));
  router.use('/lookup', fiscalLookupRouter(ctx));
  router.use('/documents', fiscalDocumentsRouter(ctx));
  router.use('/inbound', fiscalInboundRouter(ctx));
  router.use('/accountant', fiscalAccountantRouter(ctx));
  return router;
}
