import crypto from 'crypto';
import { Response, Router } from 'express';
import fs from 'fs';
import path from 'path';
import { ENV } from '../config/env';
import { AuthenticatedRequest, requireClerkUser } from '../middleware/clerkAuth';
import { classifyWhatsAppDocument, slugifyText } from '../services/ai/classifier';
import { Store } from '../services/db/store';
import { isValidPdfBuffer } from '../services/whatsapp/mediaExtractor';
import {
  buildTranscript,
  forgetTranscript,
  isTranscriptLanguage,
} from '../services/transcript/transcriptService';
import { StoredFileRecord } from '../types/models';

export const filesRouter = Router();

filesRouter.use(requireClerkUser);

function isPdfRecord(item: StoredFileRecord): boolean {
  return (
    item.mimeType.toLowerCase().includes('pdf') || item.fileName.toLowerCase().endsWith('.pdf')
  );
}

function serializeFileRecord(item: StoredFileRecord) {
  return {
    id: item.id,
    folderName: item.folderName,
    docType: item.docType,
    cleanTitle: item.cleanTitle,
    fileName: item.fileName,
    mimeType: 'application/pdf',
    sizeBytes: item.sizeBytes,
    sourceName: item.sourceName,
    syncedToPhone: item.syncedToPhone,
    receivedAtMs: item.receivedAtMs,
  };
}

/**
 * GET /api/files
 * Retourne l'intégralité des fichiers PDF et dossiers de l'utilisateur stockés dans Cloudflare D1 (`wapier`).
 */
filesRouter.get('/', (req: AuthenticatedRequest, res: Response) => {
  const userId = req.userId!;
  const pdfFiles = Store.listUserFiles(userId).filter(isPdfRecord);
  const files = pdfFiles.map(serializeFileRecord);
  const pdfFolderSet = new Set(pdfFiles.map((f) => f.folderName));
  const folders = Store.listUserFolders(userId).filter((name) => pdfFolderSet.has(name));
  const settings = Store.getUserSettings(userId);
  res.json({
    files,
    folders,
    deviceFolderUri: settings.deviceFolderUri,
  });
});

/**
 * GET /api/files/pending
 * Retourne les fichiers PDF nouvellement classés par l'IA qui doivent être enregistrés localement sur le téléphone.
 */
filesRouter.get('/pending', (req: AuthenticatedRequest, res: Response) => {
  const userId = req.userId!;
  const pending = Store.listPendingDownloads(userId).filter(isPdfRecord).map(serializeFileRecord);
  res.json({ files: pending });
});

/**
 * POST /api/files/import
 * Permet d'importer et classer uniquement un document PDF via le moteur IA (Gemini / Groq)
 * puis de l'enregistrer immédiatement dans Cloudflare D1 (`wapier`).
 */
filesRouter.post('/import', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const userId = req.userId!;
    const {
      base64Content,
      originalFileName = 'document.pdf',
      mimeType = 'application/pdf',
      caption = '',
      sourceName = 'Import Direct',
    } = req.body || {};

    if (!base64Content || typeof base64Content !== 'string') {
      res.status(400).json({ error: 'Contenu base64 du fichier PDF requis.' });
      return;
    }

    const cleanMime = String(mimeType || '').trim().toLowerCase();
    const cleanOrigName = String(originalFileName || '').trim();
    const hasNonPdfExt =
      cleanOrigName.includes('.') && !cleanOrigName.toLowerCase().endsWith('.pdf');
    const declaredPdf =
      !hasNonPdfExt &&
      (cleanMime === 'application/pdf' ||
        cleanMime === 'application/x-pdf' ||
        cleanOrigName.toLowerCase().endsWith('.pdf'));

    if (!declaredPdf) {
      res.status(415).json({
        error: 'Seuls les fichiers PDF (.pdf) sont pris en charge par Wapier.',
      });
      return;
    }

    const buffer = Buffer.from(base64Content, 'base64');
    if (buffer.length === 0) {
      res.status(400).json({ error: 'Fichier PDF vide.' });
      return;
    }

    if (!isValidPdfBuffer(buffer)) {
      res.status(415).json({
        error: "Le fichier fourni n'est pas un document PDF valide (signature %PDF- manquante).",
      });
      return;
    }

    const fileHash = crypto.createHash('md5').update(buffer).digest('hex');

    const classification = await classifyWhatsAppDocument({
      buffer,
      mimeType: 'application/pdf',
      isPdf: true,
      originalFileName: cleanOrigName || 'document.pdf',
      caption,
      sourceName,
      existingFolders: Store.listUserFolders(userId),
    });

    if (classification.ignore) {
      res.status(422).json({ error: 'Ce PDF a été ignoré par le filtre IA (non pertinent).' });
      return;
    }

    const now = Date.now();
    const dateIso = new Date(now).toISOString().split('T')[0];
    const finalFileName = `${dateIso}_${slugifyText(classification.docType)}_${classification.cleanTitle}.pdf`;

    const safeUser = userId.replace(/[^a-zA-Z0-9_-]/g, '_');
    const userDir = path.join(ENV.PATHS.TEMP_FILES_DIR, safeUser);
    fs.mkdirSync(userDir, { recursive: true });
    const tempPath = path.join(userDir, `${now}_${crypto.randomBytes(3).toString('hex')}_${finalFileName}`);
    fs.writeFileSync(tempPath, buffer);

    const saved = await Store.saveClassifiedFile({
      userId,
      waMessageId: `import_${crypto.randomUUID()}`,
      fileHash,
      folderName: classification.folderName,
      docType: classification.docType,
      cleanTitle: classification.cleanTitle.replace(/_/g, ' '),
      fileName: finalFileName,
      mimeType: 'application/pdf',
      sizeBytes: buffer.length,
      sourceName,
      tempPath,
      receivedAtMs: now,
    });

    res.status(201).json({ file: serializeFileRecord(saved) });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

/**
 * GET /api/files/folders
 * Liste les noms de dossiers personnalisés connus dans Cloudflare D1 pour guider l'IA.
 */
filesRouter.get('/folders', (req: AuthenticatedRequest, res: Response) => {
  const userId = req.userId!;
  res.json({ folders: Store.listUserFolders(userId) });
});

/**
 * POST /api/files/folders
 * Ajoute un dossier personnalisé dans Cloudflare D1 pour que l'IA l'utilise en priorité.
 */
filesRouter.post('/folders', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const userId = req.userId!;
    const cleanName = slugifyText(String(req.body?.name || ''));
    if (!cleanName) {
      res.status(400).json({ error: 'Nom de dossier invalide.' });
      return;
    }
    await Store.addUserFolder(userId, cleanName);
    res.json({ folders: Store.listUserFolders(userId) });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

/**
 * PATCH /api/files/settings
 * Enregistre la préférence du dossier téléphone dans Cloudflare D1 (`wapier_users`).
 */
filesRouter.patch('/settings', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const userId = req.userId!;
    const deviceFolderUri =
      req.body?.deviceFolderUri === null ? null : String(req.body?.deviceFolderUri || '');
    await Store.saveUserDeviceFolder(userId, deviceFolderUri || null);
    res.json({ ok: true, deviceFolderUri: Store.getUserSettings(userId).deviceFolderUri });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

/**
 * GET /api/files/:id/download
 * Transfère le contenu binaire du PDF classé vers le téléphone ou l'aperçu mobile.
 */
filesRouter.get('/:id/download', (req: AuthenticatedRequest, res: Response) => {
  const userId = req.userId!;
  const record = Store.getFileById(userId, String(req.params.id));

  if (!record || !isPdfRecord(record) || !record.tempPath || !fs.existsSync(record.tempPath)) {
    res.status(404).json({ error: 'Fichier PDF introuvable sur le relais.' });
    return;
  }

  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="${record.fileName}"`);
  fs.createReadStream(record.tempPath).pipe(res);
});

/**
 * POST /api/files/ack-batch
 * Confirme en une seule requête la réception sur le téléphone d'un lot de PDF triés.
 */
filesRouter.post('/ack-batch', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const userId = req.userId!;
    const ids = Array.isArray(req.body?.ids) ? (req.body.ids as unknown[]).map(String) : [];
    const count = await Store.acknowledgeDownloadsBatch(userId, ids);
    res.json({ cleanedCount: count });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

/**
 * DELETE /api/files/:id/ack
 * Confirme que le fichier PDF a été copié sur le téléphone de l'utilisateur
 * tout en conservant l'enregistrement dans Cloudflare D1 (`wapier_files`).
 */
filesRouter.delete('/:id/ack', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const userId = req.userId!;
    const acknowledged = await Store.acknowledgeDownload(userId, String(req.params.id));
    res.json({ cleaned: acknowledged });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

/**
 * DELETE /api/files/:id
 * Supprime définitivement le fichier PDF de Cloudflare D1 (`wapier_files`) et du disque.
 */
filesRouter.delete('/:id', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const userId = req.userId!;
    const deleted = await Store.deleteFile(userId, String(req.params.id));
    if (!deleted) {
      res.status(404).json({ error: 'Fichier PDF introuvable.' });
      return;
    }
    forgetTranscript(String(req.params.id));
    res.json({ deleted: true });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

/**
 * PATCH /api/files/:id/folder
 * Déplace un fichier PDF vers un autre dossier (mise à jour Cloudflare D1 et RAM).
 */
filesRouter.patch('/:id/folder', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const userId = req.userId!;
    const fileId = String(req.params.id);
    const rawTarget = String(req.body?.targetFolder || '').trim();
    const targetFolder = slugifyText(rawTarget);
    if (!targetFolder) {
      res.status(400).json({ error: 'Nom de dossier cible requis.' });
      return;
    }
    const updated = await Store.moveFile(userId, fileId, targetFolder);
    if (!updated) {
      res.status(404).json({ error: 'Fichier PDF introuvable.' });
      return;
    }
    res.json({
      file: serializeFileRecord(updated),
      folders: Store.listUserFolders(userId),
    });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

/**
 * GET /api/files/:id/transcript?lang=fr|en|es|de|it|pt|ar
 * Transcription structurée du PDF (paragraphes minutés) pour le lecteur audio.
 * Sans `lang`, le texte est renvoyé dans sa langue d'origine.
 */
filesRouter.get('/:id/transcript', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const userId = req.userId!;
    const record = Store.getFileById(userId, String(req.params.id));
    if (!record || !isPdfRecord(record)) {
      res.status(404).json({ error: 'Fichier PDF introuvable.' });
      return;
    }

    const rawLang = req.query.lang;
    if (rawLang !== undefined && !isTranscriptLanguage(rawLang)) {
      res.status(400).json({ error: 'Langue de transcription non prise en charge.' });
      return;
    }

    const transcript = await buildTranscript(record, isTranscriptLanguage(rawLang) ? rawLang : null);
    res.json(transcript);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});