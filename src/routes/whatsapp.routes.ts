import { Response, Router } from 'express';
import { AuthenticatedRequest, requireClerkUser } from '../middleware/clerkAuth';
import { Store } from '../services/db/store';
import { MediaIndex } from '../services/whatsapp/mediaIndex';
import { SessionManager } from '../services/whatsapp/sessionManager';
import { SyncDateFilter } from '../types/models';

export const whatsappRouter = Router();

whatsappRouter.use(requireClerkUser);

/**
 * GET /api/whatsapp/status
 * Renvoie l'état actuel de la connexion WhatsApp et l'avancement du tri IA.
 */
whatsappRouter.get('/status', (req: AuthenticatedRequest, res: Response) => {
  const userId = req.userId!;
  res.json(SessionManager.getStatus(userId));
});

/**
 * POST /api/whatsapp/pair
 * Génère le code d'appairage à 8 caractères à partir du numéro de téléphone WhatsApp.
 */
whatsappRouter.post('/pair', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const userId = req.userId!;
    const phoneNumber = String(req.body?.phoneNumber || '');
    const code = await SessionManager.requestPairingCode(userId, phoneNumber);
    res.json({
      pairingCode: code === 'CONNECTED' ? null : code,
      status: SessionManager.getStatus(userId).status,
    });
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

/**
 * POST /api/whatsapp/disconnect
 * Déconnecte la session WhatsApp liée à l'utilisateur.
 */
whatsappRouter.post('/disconnect', async (req: AuthenticatedRequest, res: Response) => {
  const userId = req.userId!;
  await SessionManager.disconnect(userId, false);
  res.json({ ok: true });
});

/**
 * GET /api/whatsapp/sources
 * Liste les groupes, contacts et messages personnels disponibles (persistés dans Cloudflare D1).
 */
whatsappRouter.get('/sources', async (req: AuthenticatedRequest, res: Response) => {
  const userId = req.userId!;
  if (req.query.refresh === '1') {
    await SessionManager.refreshGroups(userId);
  }
  await Store.flushDirtySourcesToD1();
  const counts = MediaIndex.getCountsByJid(userId);
  const sources = Store.listSources(userId, counts);
  res.json({ sources });
});

/**
 * PATCH /api/whatsapp/sources
 * Active ou désactive un ou plusieurs groupes/contacts à surveiller dans Cloudflare D1.
 */
whatsappRouter.patch('/sources', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const userId = req.userId!;
    const { jid, isActive, activeJids } = req.body || {};

    if (Array.isArray(activeJids)) {
      await Store.setBulkSourcesActive(userId, activeJids.map(String));
    } else if (typeof jid === 'string' && typeof isActive === 'boolean') {
      await Store.setSourceActive(userId, jid, isActive);
    } else {
      res.status(400).json({ error: 'Paramètres invalides.' });
      return;
    }

    const counts = MediaIndex.getCountsByJid(userId);
    res.json({ sources: Store.listSources(userId, counts) });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

/**
 * GET /api/whatsapp/sync/preview?startMs=...&endMs=...
 * Calcule instantanément le nombre de fichiers présents sur la période choisie avant de lancer le tri IA.
 */
whatsappRouter.get('/sync/preview', (req: AuthenticatedRequest, res: Response) => {
  const userId = req.userId!;
  const startDateMs = Number(req.query.startMs || 0);
  const rawEnd = req.query.endMs;
  const endDateMs =
    rawEnd && rawEnd !== 'null' && rawEnd !== '' ? Number(rawEnd) : null;

  if (!Number.isFinite(startDateMs) || startDateMs <= 0) {
    res.status(400).json({ error: 'Date de début invalide.' });
    return;
  }

  const filter: SyncDateFilter = { startDateMs, endDateMs };
  const matchedCount = SessionManager.previewSyncCount(userId, filter);
  res.json({ matchedCount });
});

/**
 * POST /api/whatsapp/sync
 * Lance le tri IA uniquement sur la plage choisie ("Du X au Y" ou "Du X à maintenant").
 */
whatsappRouter.post('/sync', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const userId = req.userId!;
    const startDateMs = Number(req.body?.startDateMs || 0);
    const rawEnd = req.body?.endDateMs;
    const endDateMs =
      rawEnd !== undefined && rawEnd !== null && rawEnd !== '' ? Number(rawEnd) : null;

    if (!Number.isFinite(startDateMs) || startDateMs <= 0) {
      res.status(400).json({ error: 'Veuillez choisir une date de début valide.' });
      return;
    }
    if (endDateMs !== null && endDateMs < startDateMs) {
      res.status(400).json({ error: 'La date de fin doit être postérieure à la date de début.' });
      return;
    }

    const result = await SessionManager.startTargetedSync(userId, { startDateMs, endDateMs });
    res.json({
      ok: true,
      queued: result.queued,
      status: SessionManager.getStatus(userId),
    });
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});
