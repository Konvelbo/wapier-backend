/**
 * Modèles de données partagés du backend Wapier (100 % fichiers PDF uniquement).
 * Toutes les entités persistantes sont stockées dans Cloudflare D1 (`wapier`).
 */

export type WhatsAppStatus = 'disconnected' | 'connecting' | 'pairing' | 'connected';

export type SourceType = 'self' | 'group' | 'contact';

export interface MonitoredSource {
  jid: string;
  name: string;
  type: SourceType;
  isActive: boolean;
  detectedFilesCount: number;
}

export interface SyncDateFilter {
  /** Timestamp Unix en millisecondes du début de la période (X) */
  startDateMs: number;
  /** Timestamp Unix en millisecondes de la fin (Y), ou null pour "Du X à maintenant" */
  endDateMs: number | null;
}

export interface SyncProgress {
  isRunning: boolean;
  processed: number;
  total: number;
  classified: number;
  ignored: number;
  lastFileTitle: string | null;
  mode: 'idle' | 'range_fixed' | 'live_from_date';
}

export interface ClassificationResult {
  ignore: boolean;
  reason?: string;
  folderName: string;
  docType: 'Cours' | 'TD' | 'TP' | 'Examen' | 'Facture' | 'Administratif' | 'Livre' | 'Document';
  cleanTitle: string;
}

export interface StoredFileRecord {
  id: string;
  userId: string;
  waMessageId: string;
  fileHash: string;
  folderName: string;
  docType: string;
  cleanTitle: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  sourceName: string;
  tempPath: string;
  syncedToPhone: boolean;
  receivedAtMs: number;
  createdAtMs: number;
}

export type PendingFileRecord = StoredFileRecord;

export interface MediaEnvelopeItem {
  messageId: string;
  jid: string;
  sourceName: string;
  sourceType: SourceType;
  timestampMs: number;
  originalFileName: string;
  caption: string;
  mimeType: 'application/pdf';
  isPdf: true;
  /** Empreinte SHA-256 native WhatsApp permettant de dédupliquer avant téléchargement (0 Mo) */
  preDownloadHash?: string | null;
  /** Message brut sérialisé de Baileys (sans binaire, quelques octets seulement) */
  rawMessageJson: string;
}
