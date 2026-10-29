import { downloadMediaMessage, WAMessage, WASocket } from '@whiskeysockets/baileys';
import pino from 'pino';

export interface ExtractedMediaMeta {
  isPdf: true;
  mimeType: 'application/pdf';
  originalFileName: string;
  caption: string;
  preDownloadHash: string | null;
}

/**
 * Convertit le champ `fileSha256` natif de WhatsApp en empreinte hexadécimale stable
 * afin d'éliminer les doublons AVANT de télécharger le binaire PDF.
 */
export function extractWhatsAppSha256(rawSha: unknown): string | null {
  if (!rawSha) return null;
  try {
    if (Buffer.isBuffer(rawSha) || rawSha instanceof Uint8Array) {
      return rawSha.length > 0 ? `sha256:${Buffer.from(rawSha).toString('hex')}` : null;
    }
    if (typeof rawSha === 'string' && rawSha.length > 0) {
      return `sha256:${Buffer.from(rawSha, 'base64').toString('hex')}`;
    }
    if (
      typeof rawSha === 'object' &&
      rawSha !== null &&
      'data' in (rawSha as Record<string, unknown>) &&
      Array.isArray((rawSha as { data: number[] }).data)
    ) {
      const arr = (rawSha as { data: number[] }).data;
      return arr.length > 0 ? `sha256:${Buffer.from(arr).toString('hex')}` : null;
    }
  } catch (_) {}
  return null;
}

/**
 * Vérifie que le binaire téléchargé contient bien l'en-tête standard `%PDF-` dans ses 1024 premiers octets.
 */
export function isValidPdfBuffer(buffer: Buffer): boolean {
  if (!Buffer.isBuffer(buffer) || buffer.length < 5) return false;
  const headerSlice = buffer.subarray(0, Math.min(buffer.length, 1024));
  return headerSlice.indexOf('%PDF-') !== -1;
}

/**
 * Déballe récursivement les messages éphémères, vues uniques et documents légendés de WhatsApp.
 */
export function unwrapWhatsAppMessage(rawMessage: unknown): Record<string, unknown> | null {
  if (!rawMessage || typeof rawMessage !== 'object') return null;

  let current = rawMessage as Record<string, any>;
  let unwrapped = true;

  while (unwrapped) {
    unwrapped = false;
    if (current?.ephemeralMessage?.message) {
      current = current.ephemeralMessage.message;
      unwrapped = true;
    } else if (current?.viewOnceMessage?.message) {
      current = current.viewOnceMessage.message;
      unwrapped = true;
    } else if (current?.viewOnceMessageV2?.message) {
      current = current.viewOnceMessageV2.message;
      unwrapped = true;
    } else if (current?.viewOnceMessageV2Extension?.message) {
      current = current.viewOnceMessageV2Extension.message;
      unwrapped = true;
    } else if (current?.documentWithCaptionMessage?.message) {
      current = current.documentWithCaptionMessage.message;
      unwrapped = true;
    }
  }

  return current;
}

/**
 * Extrait uniquement les métadonnées des documents PDF WhatsApp (sans télécharger le binaire).
 * Tout autre format (image, vidéo, audio, Word, Excel, ZIP, etc.) est strictement ignoré.
 */
export function extractMediaMetadata(msg: WAMessage): ExtractedMediaMeta | null {
  const m = unwrapWhatsAppMessage(msg.message) as Record<string, any> | null;
  if (!m) return null;

  const docMsg = m.documentMessage;
  if (!docMsg) return null;

  const rawMime = String(docMsg.mimetype || '').trim().toLowerCase();
  const originalFileName = String(docMsg.fileName || '').trim();
  const caption = String(docMsg.caption || '').trim();

  const hasNonPdfExtension =
    originalFileName.includes('.') && !originalFileName.toLowerCase().endsWith('.pdf');
  if (hasNonPdfExtension) {
    return null;
  }

  const isPdf =
    rawMime === 'application/pdf' ||
    rawMime === 'application/x-pdf' ||
    originalFileName.toLowerCase().endsWith('.pdf');

  if (!isPdf) {
    return null;
  }

  return {
    isPdf: true,
    mimeType: 'application/pdf',
    originalFileName: originalFileName || 'document.pdf',
    caption,
    preDownloadHash: extractWhatsAppSha256(docMsg.fileSha256),
  };
}

/**
 * Convertit le timestamp WhatsApp (secondes ou objet Long) en millisecondes Unix.
 */
export function extractMessageTimestampMs(msg: WAMessage): number {
  const raw = msg.messageTimestamp as unknown;
  if (typeof raw === 'number') {
    return raw > 1e12 ? raw : raw * 1000;
  }
  if (raw && typeof raw === 'object' && 'low' in (raw as Record<string, unknown>)) {
    const low = Number((raw as { low: number }).low);
    return low * 1000;
  }
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed * 1000 : Date.now();
}

/**
 * Télécharge le binaire PDF déchiffré d'un message WhatsApp avec tentatives de secours.
 */
export async function downloadMediaBufferSafe(
  msg: WAMessage,
  sock: WASocket,
  maxRetries = 3,
): Promise<Buffer | null> {
  const silentLogger = pino({ level: 'silent' });

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const buffer = await downloadMediaMessage(
        msg,
        'buffer',
        {},
        {
          logger: silentLogger,
          reuploadRequest: sock.updateMediaMessage,
        },
      );
      if (buffer && Buffer.isBuffer(buffer) && isValidPdfBuffer(buffer)) {
        return buffer;
      }
      if (buffer && Buffer.isBuffer(buffer) && buffer.length > 0 && !isValidPdfBuffer(buffer)) {
        // Le fichier téléchargé n'est pas un vrai PDF : inutile de réessayer
        return null;
      }
    } catch (err) {
      if (attempt < maxRetries) {
        await new Promise((r) => setTimeout(r, 1500 * attempt));
      } else {
        console.warn('[WhatsApp/PDF] Échec téléchargement PDF :', (err as Error).message);
      }
    }
  }
  return null;
}
