import { BufferJSON, WAMessage } from '@whiskeysockets/baileys';
import fs from 'fs';
import path from 'path';
import { ENV } from '../../config/env';
import { MediaEnvelopeItem, SourceType, SyncDateFilter } from '../../types/models';
import { extractMediaMetadata, extractMessageTimestampMs } from './mediaExtractor';

/**
 * Index léger en mémoire + persistance disque des enveloppes PDF uniquement par utilisateur.
 * Zéro octet binaire n'est téléchargé à l'indexation : seuls les fichiers PDF compris dans
 * la plage [Date X -> Date Y / Maintenant] choisie par l'utilisateur seront téléchargés.
 */
class UserMediaEnvelopeIndex {
  private cacheByUser = new Map<string, Map<string, MediaEnvelopeItem>>();

  private getIndexFilePath(userId: string): string {
    const safeId = userId.replace(/[^a-zA-Z0-9_-]/g, '_');
    const dir = path.join(ENV.PATHS.SESSIONS_DIR, safeId);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    return path.join(dir, 'media-index.json');
  }

  private ensureLoaded(userId: string): Map<string, MediaEnvelopeItem> {
    const existing = this.cacheByUser.get(userId);
    if (existing) return existing;

    const map = new Map<string, MediaEnvelopeItem>();
    const filePath = this.getIndexFilePath(userId);
    if (fs.existsSync(filePath)) {
      try {
        const items = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as Array<
          MediaEnvelopeItem & { isImage?: boolean }
        >;
        for (const item of items) {
          // Prise en charge stricte des PDF uniquement (filtre aussi d'éventuelles anciennes entrées)
          if (item.isPdf && !item.isImage && item.mimeType === 'application/pdf') {
            let preDownloadHash = item.preDownloadHash || null;
            if (!preDownloadHash && item.rawMessageJson) {
              try {
                const parsedMsg = JSON.parse(item.rawMessageJson, BufferJSON.reviver) as WAMessage;
                preDownloadHash = extractMediaMetadata(parsedMsg)?.preDownloadHash || null;
              } catch (_) {}
            }
            map.set(item.messageId, {
              messageId: item.messageId,
              jid: item.jid,
              sourceName: item.sourceName,
              sourceType: item.sourceType,
              timestampMs: item.timestampMs,
              originalFileName: item.originalFileName,
              caption: item.caption,
              mimeType: 'application/pdf',
              isPdf: true,
              preDownloadHash,
              rawMessageJson: item.rawMessageJson,
            });
          }
        }
      } catch (_) {}
    }

    this.cacheByUser.set(userId, map);
    return map;
  }

  public saveToDisk(userId: string): void {
    const map = this.cacheByUser.get(userId);
    if (!map) return;
    try {
      const items = Array.from(map.values());
      fs.writeFileSync(this.getIndexFilePath(userId), JSON.stringify(items), 'utf-8');
    } catch (_) {}
  }

  public indexMessageIfMedia(
    userId: string,
    msg: WAMessage,
    resolvedSourceName: string,
    sourceType: SourceType,
  ): MediaEnvelopeItem | null {
    const jid = msg.key?.remoteJid;
    const messageId = msg.key?.id;
    if (!jid || !messageId || jid === 'status@broadcast') return null;

    const meta = extractMediaMetadata(msg);
    if (!meta) return null;

    const userMap = this.ensureLoaded(userId);
    const existing = userMap.get(messageId);
    if (existing) return existing;

    const item: MediaEnvelopeItem = {
      messageId,
      jid,
      sourceName: resolvedSourceName,
      sourceType,
      timestampMs: extractMessageTimestampMs(msg),
      originalFileName: meta.originalFileName,
      caption: meta.caption,
      mimeType: 'application/pdf',
      isPdf: true,
      preDownloadHash: meta.preDownloadHash,
      rawMessageJson: JSON.stringify(msg, BufferJSON.replacer),
    };

    userMap.set(messageId, item);
    return item;
  }

  public deserializeRawMessage(item: MediaEnvelopeItem): WAMessage {
    return JSON.parse(item.rawMessageJson, BufferJSON.reviver) as WAMessage;
  }

  public getCountsByJid(userId: string): Map<string, number> {
    const map = this.ensureLoaded(userId);
    const counts = new Map<string, number>();
    for (const item of map.values()) {
      counts.set(item.jid, (counts.get(item.jid) || 0) + 1);
    }
    return counts;
  }

  /**
   * Filtre instantanément (O(N) en RAM) les fichiers PDF correspondant aux sources cochées
   * et à la période choisie ("Du X au Y" ou "Du X à maintenant"), triés du plus récent au plus ancien.
   */
  public filterBySourcesAndDates(
    userId: string,
    activeJids: Set<string>,
    filter: SyncDateFilter,
  ): MediaEnvelopeItem[] {
    const map = this.ensureLoaded(userId);
    const upperBound = filter.endDateMs !== null ? filter.endDateMs : Number.MAX_SAFE_INTEGER;

    const matched: MediaEnvelopeItem[] = [];
    for (const item of map.values()) {
      if (!item.isPdf) continue;
      if (!activeJids.has(item.jid)) continue;
      if (item.timestampMs < filter.startDateMs) continue;
      if (item.timestampMs > upperBound) continue;
      matched.push(item);
    }

    // Plus récents d'abord pour un affichage rapide sur mobile
    matched.sort((a, b) => b.timestampMs - a.timestampMs);
    return matched;
  }

  public clearUserIndex(userId: string): void {
    this.cacheByUser.delete(userId);
    const filePath = this.getIndexFilePath(userId);
    if (fs.existsSync(filePath)) {
      try {
        fs.unlinkSync(filePath);
      } catch (_) {}
    }
  }
}

export const MediaIndex = new UserMediaEnvelopeIndex();
