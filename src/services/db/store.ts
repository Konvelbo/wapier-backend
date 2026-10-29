import crypto from 'crypto';
import fs from 'fs';
import { ENV } from '../../config/env';
import {
  MonitoredSource,
  SourceType,
  StoredFileRecord,
  SyncDateFilter,
} from '../../types/models';
import { CloudflareD1 } from './cloudflareD1';

interface UserSettingsRecord {
  waPhone: string | null;
  filter: SyncDateFilter | null;
  liveMode: boolean;
  deviceFolderUri: string | null;
  email?: string | null;
  passwordHash?: string | null;
  name?: string | null;
}

interface SourceCacheEntry {
  jid: string;
  name: string;
  type: SourceType;
  isActive: boolean;
  updatedAt: number;
}

interface IgnoredMessageEntry {
  waMessageId: string;
  fileHash: string;
}

interface PendingFileRowForD1 {
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
  status: 'classified' | 'ignored';
  syncedToPhone: number;
  receivedAtMs: number;
  createdAtMs: number;
}

export function isValidSourceJid(jid: string): boolean {
  if (!jid || typeof jid !== 'string') return false;
  if (jid.endsWith('@lid')) return false; // ID d'appareil interne Baileys/WhatsApp, pas un contact
  if (jid === 'status@broadcast' || jid.endsWith('@broadcast')) return false;
  if (jid.startsWith('0@s.whatsapp.net')) return false;
  return jid.endsWith('@g.us') || jid.endsWith('@s.whatsapp.net');
}

export function formatCleanContactName(jid: string, rawName: string): string {
  const clean = (rawName || '').trim();
  // Si un vrai nom existe (non numérique pur de plus de 6 chiffres)
  if (clean && !/^\d{6,16}$/.test(clean)) {
    return clean;
  }
  const phone = clean || jid.split('@')[0].split(':')[0];
  if (/^\d{8,16}$/.test(phone)) {
    // Format Burkina Faso (+226 XX XX XX XX)
    if (phone.startsWith('226') && phone.length === 11) {
      return `+226 ${phone.slice(3, 5)} ${phone.slice(5, 7)} ${phone.slice(7, 9)} ${phone.slice(9)}`;
    }
    // Format France (+33 X XX XX XX XX)
    if (phone.startsWith('33') && phone.length === 11) {
      return `+33 ${phone.slice(2, 3)} ${phone.slice(3, 5)} ${phone.slice(5, 7)} ${phone.slice(7, 9)} ${phone.slice(9)}`;
    }
    // Format Côte d'Ivoire (+225 XX XX XX XX XX)
    if (phone.startsWith('225') && phone.length === 13) {
      return `+225 ${phone.slice(3, 5)} ${phone.slice(5, 7)} ${phone.slice(7, 9)} ${phone.slice(9, 11)} ${phone.slice(11)}`;
    }
    return `+${phone}`;
  }
  return clean || jid;
}

/**
 * Store central 100 % adossé à Cloudflare D1 (`wapier`) + index O(1) en mémoire
 * et écritures groupées (Batch SQL) pour maximiser le débit lors du tri parallèle.
 */
class CloudflareBackedStore {
  private users = new Map<string, UserSettingsRecord>();
  private sources = new Map<string, Map<string, SourceCacheEntry>>();
  private folders = new Map<string, Set<string>>();
  private files = new Map<string, Map<string, StoredFileRecord>>();
  private ignored = new Map<string, IgnoredMessageEntry[]>();

  // Index O(1) pour la déduplication instantanée avant et après téléchargement
  private processedMessageIds = new Map<string, Set<string>>();
  private processedHashes = new Map<string, Set<string>>();

  // Files d'attente d'écritures groupées vers Cloudflare D1
  private dirtySources = new Map<string, Map<string, SourceCacheEntry>>();
  private pendingFoldersForD1: Array<{ userId: string; folderName: string; createdAt: number }> = [];
  private pendingFilesForD1: PendingFileRowForD1[] = [];

  private sourcesFlushTimer: NodeJS.Timeout | null = null;
  private filesFlushTimer: NodeJS.Timeout | null = null;
  private activeFilesFlushPromise: Promise<void> | null = null;
  private initialized = false;

  private trackProcessedInMemory(userId: string, messageId?: string, fileHash?: string | null): void {
    if (messageId) {
      let msgSet = this.processedMessageIds.get(userId);
      if (!msgSet) {
        msgSet = new Set();
        this.processedMessageIds.set(userId, msgSet);
      }
      msgSet.add(messageId);
    }
    if (fileHash) {
      let hashSet = this.processedHashes.get(userId);
      if (!hashSet) {
        hashSet = new Set();
        this.processedHashes.set(userId, hashSet);
      }
      for (const token of fileHash.split('|')) {
        if (token) hashSet.add(token);
      }
    }
  }

  public registerAdditionalHash(userId: string, hash: string | null | undefined): void {
    if (!hash) return;
    this.trackProcessedInMemory(userId, undefined, hash);
  }

  public async initFromCloudflareD1(): Promise<void> {
    if (fs.existsSync(ENV.PATHS.DATA_DIR)) {
      try {
        fs.rmSync(ENV.PATHS.DATA_DIR, { recursive: true, force: true });
      } catch (_) {}
    }

    if (!CloudflareD1.isConfigured()) {
      console.warn('[Store] Cloudflare D1 non configuré — fonctionnement en mémoire uniquement.');
      return;
    }

    const state = await CloudflareD1.loadAllState();

    // Nettoyage automatique immédiat des junk @lid et status@broadcast dans Cloudflare D1
    try {
      await CloudflareD1.query(
        "DELETE FROM wapier_sources WHERE jid LIKE '%@lid' OR jid = 'status@broadcast' OR jid LIKE '0@%';",
      );
    } catch (_) {}

    for (const u of state.users) {
      this.users.set(u.user_id, {
        email: u.email || null,
        passwordHash: u.password_hash || null,
        name: u.name || null,
        waPhone: u.wa_phone,
        filter:
          u.sync_start_ms !== null && u.sync_start_ms !== undefined
            ? {
                startDateMs: Number(u.sync_start_ms),
                endDateMs: u.sync_end_ms !== null ? Number(u.sync_end_ms) : null,
              }
            : null,
        liveMode: Boolean(u.live_mode),
        deviceFolderUri: u.device_folder_uri || null,
      });
    }

    for (const s of state.sources) {
      if (!isValidSourceJid(s.jid)) {
        continue; // Ignorer immédiatement les 348 junk @lid
      }
      let userSources = this.sources.get(s.user_id);
      if (!userSources) {
        userSources = new Map();
        this.sources.set(s.user_id, userSources);
      }
      userSources.set(s.jid, {
        jid: s.jid,
        name: formatCleanContactName(s.jid, s.name),
        type: s.source_type as SourceType,
        isActive: Boolean(s.is_active),
        updatedAt: Number(s.updated_at || Date.now()),
      });
    }

    for (const f of state.folders) {
      let set = this.folders.get(f.user_id);
      if (!set) {
        set = new Set();
        this.folders.set(f.user_id, set);
      }
      set.add(f.folder_name);
    }

    for (const row of state.files) {
      this.trackProcessedInMemory(row.user_id, row.wa_message_id, row.file_hash);

      if (row.status === 'ignored') {
        const list = this.ignored.get(row.user_id) || [];
        list.push({ waMessageId: row.wa_message_id, fileHash: row.file_hash });
        this.ignored.set(row.user_id, list);
        continue;
      }

      let userFiles = this.files.get(row.user_id);
      if (!userFiles) {
        userFiles = new Map();
        this.files.set(row.user_id, userFiles);
      }
      userFiles.set(row.id, {
        id: row.id,
        userId: row.user_id,
        waMessageId: row.wa_message_id,
        fileHash: row.file_hash,
        folderName: row.folder_name,
        docType: row.doc_type,
        cleanTitle: row.clean_title,
        fileName: row.file_name,
        mimeType: row.mime_type,
        sizeBytes: Number(row.size_bytes),
        sourceName: row.source_name,
        tempPath: row.temp_path,
        syncedToPhone: Boolean(row.synced_to_phone),
        receivedAtMs: Number(row.received_at_ms),
        createdAtMs: Number(row.created_at_ms),
      });
    }

    this.initialized = true;
    console.log(
      `☁️ Cloudflare D1 (wapier) prêt : ${state.users.length} utilisateur(s), ${state.folders.length} dossier(s), ${state.files.length} fichier(s) chargés.`,
    );
  }

  public isInitialized(): boolean {
    return this.initialized;
  }

  private getOrCreateUserSettings(userId: string): UserSettingsRecord {
    let settings = this.users.get(userId);
    if (!settings) {
      settings = {
        waPhone: null,
        filter: null,
        liveMode: false,
        deviceFolderUri: null,
      };
      this.users.set(userId, settings);
    }
    return settings;
  }

  public getUserSettings(userId: string): UserSettingsRecord {
    return this.getOrCreateUserSettings(userId);
  }

  private async persistUserSettingsToD1(userId: string): Promise<void> {
    if (!CloudflareD1.isConfigured()) return;
    const s = this.getOrCreateUserSettings(userId);
    await CloudflareD1.query(
      `INSERT INTO wapier_users (user_id, email, password_hash, name, wa_phone, sync_start_ms, sync_end_ms, live_mode, device_folder_uri, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(user_id) DO UPDATE SET
         email = COALESCE(excluded.email, wapier_users.email),
         password_hash = COALESCE(excluded.password_hash, wapier_users.password_hash),
         name = COALESCE(excluded.name, wapier_users.name),
         wa_phone = COALESCE(excluded.wa_phone, wapier_users.wa_phone),
         sync_start_ms = excluded.sync_start_ms,
         sync_end_ms = excluded.sync_end_ms,
         live_mode = excluded.live_mode,
         device_folder_uri = excluded.device_folder_uri,
         updated_at = excluded.updated_at;`,
      [
        userId,
        s.email || null,
        s.passwordHash || null,
        s.name || null,
        s.waPhone,
        s.filter ? s.filter.startDateMs : null,
        s.filter ? s.filter.endDateMs : null,
        s.liveMode ? 1 : 0,
        s.deviceFolderUri,
        Date.now(),
      ],
    );
  }

  public getUserByEmail(email: string): {
    userId: string;
    email: string;
    passwordHash: string | null;
    name: string | null;
  } | null {
    const normalized = email.trim().toLowerCase();
    for (const [userId, user] of this.users.entries()) {
      if (user.email && user.email.toLowerCase() === normalized) {
        return {
          userId,
          email: user.email,
          passwordHash: user.passwordHash || null,
          name: user.name || null,
        };
      }
    }
    return null;
  }

  public async registerOrUpdateCredentials(
    userId: string,
    email: string,
    passwordHash: string,
    name?: string,
  ): Promise<{ userId: string; email: string; name?: string }> {
    const s = this.getOrCreateUserSettings(userId);
    s.email = email.trim().toLowerCase();
    s.passwordHash = passwordHash;
    if (name) s.name = name.trim();
    await this.persistUserSettingsToD1(userId);
    return { userId, email: s.email, name: s.name || undefined };
  }

  public async deleteUserFromD1(userId: string): Promise<void> {
    this.users.delete(userId);
    this.sources.delete(userId);
    this.folders.delete(userId);
    this.files.delete(userId);
    this.ignored.delete(userId);
    this.processedMessageIds.delete(userId);
    this.processedHashes.delete(userId);

    if (CloudflareD1.isConfigured()) {
      await Promise.all([
        CloudflareD1.query(`DELETE FROM wapier_users WHERE user_id = ?;`, [userId]),
        CloudflareD1.query(`DELETE FROM wapier_sources WHERE user_id = ?;`, [userId]),
        CloudflareD1.query(`DELETE FROM wapier_folders WHERE user_id = ?;`, [userId]),
        CloudflareD1.query(`DELETE FROM wapier_files WHERE user_id = ?;`, [userId]),
      ]);
    }
  }

  public async upsertUserPhone(userId: string, phone: string): Promise<void> {
    const s = this.getOrCreateUserSettings(userId);
    s.waPhone = phone;
    await this.persistUserSettingsToD1(userId);
  }

  public async saveUserDateFilter(userId: string, filter: SyncDateFilter): Promise<void> {
    const s = this.getOrCreateUserSettings(userId);
    s.filter = filter;
    s.liveMode = filter.endDateMs === null;
    await this.persistUserSettingsToD1(userId);
  }

  public async saveUserDeviceFolder(userId: string, folderUri: string | null): Promise<void> {
    const s = this.getOrCreateUserSettings(userId);
    s.deviceFolderUri = folderUri;
    await this.persistUserSettingsToD1(userId);
  }

  public upsertDiscoveredSource(
    userId: string,
    jid: string,
    name: string,
    type: SourceType,
    defaultActive = false,
  ): void {
    if (!isValidSourceJid(jid)) return;

    let userSources = this.sources.get(userId);
    if (!userSources) {
      userSources = new Map();
      this.sources.set(userId, userSources);
    }

    const cleanName = formatCleanContactName(jid, name);
    const existing = userSources.get(jid);
    const updatedName = cleanName || existing?.name || jid.split('@')[0];
    const nextIsActive = existing ? existing.isActive : defaultActive;

    if (existing && existing.name === updatedName && existing.type === type) {
      return;
    }

    const entry: SourceCacheEntry = {
      jid,
      name: updatedName,
      type,
      isActive: nextIsActive,
      updatedAt: Date.now(),
    };
    userSources.set(jid, entry);

    let dirtyForUser = this.dirtySources.get(userId);
    if (!dirtyForUser) {
      dirtyForUser = new Map();
      this.dirtySources.set(userId, dirtyForUser);
    }
    dirtyForUser.set(jid, entry);
    this.scheduleSourcesFlush();
  }

  private scheduleSourcesFlush(): void {
    if (this.sourcesFlushTimer || !CloudflareD1.isConfigured()) return;
    this.sourcesFlushTimer = setTimeout(() => {
      this.sourcesFlushTimer = null;
      void this.flushDirtySourcesToD1();
    }, 600);
  }

  public async flushDirtySourcesToD1(): Promise<void> {
    if (!CloudflareD1.isConfigured() || this.dirtySources.size === 0) return;

    const batchRows: Array<{ userId: string; entry: SourceCacheEntry }> = [];
    for (const [userId, map] of this.dirtySources.entries()) {
      for (const entry of map.values()) {
        batchRows.push({ userId, entry });
      }
    }
    this.dirtySources.clear();

    const chunkSize = 12;
    for (let i = 0; i < batchRows.length; i += chunkSize) {
      const slice = batchRows.slice(i, i + chunkSize);
      const placeholders = slice.map(() => '(?, ?, ?, ?, ?, ?)').join(', ');
      const params: Array<string | number> = [];
      for (const item of slice) {
        params.push(
          item.userId,
          item.entry.jid,
          item.entry.name,
          item.entry.type,
          item.entry.isActive ? 1 : 0,
          item.entry.updatedAt,
        );
      }
      try {
        await CloudflareD1.query(
          `INSERT INTO wapier_sources (user_id, jid, name, source_type, is_active, updated_at)
           VALUES ${placeholders}
           ON CONFLICT(user_id, jid) DO UPDATE SET
             name = CASE WHEN excluded.name != '' THEN excluded.name ELSE wapier_sources.name END,
             source_type = excluded.source_type,
             updated_at = excluded.updated_at;`,
          params,
        );
      } catch (err) {
        console.warn('[Store/D1] Avertissement synchronisation sources :', (err as Error).message);
      }
    }
  }

  public async setSourceActive(userId: string, jid: string, isActive: boolean): Promise<void> {
    const userSources = this.sources.get(userId);
    const entry = userSources?.get(jid);
    if (entry) {
      entry.isActive = isActive;
      entry.updatedAt = Date.now();
    }
    if (CloudflareD1.isConfigured()) {
      await this.flushDirtySourcesToD1();
      await CloudflareD1.query(
        `UPDATE wapier_sources SET is_active = ?, updated_at = ? WHERE user_id = ? AND jid = ?;`,
        [isActive ? 1 : 0, Date.now(), userId, jid],
      );
    }
  }

  public async setBulkSourcesActive(userId: string, activeJids: string[]): Promise<void> {
    const activeSet = new Set(activeJids);
    const userSources = this.sources.get(userId);
    if (userSources) {
      for (const entry of userSources.values()) {
        entry.isActive = activeSet.has(entry.jid);
        entry.updatedAt = Date.now();
      }
    }

    if (CloudflareD1.isConfigured()) {
      await this.flushDirtySourcesToD1();
      const now = Date.now();
      await CloudflareD1.query(
        `UPDATE wapier_sources SET is_active = 0, updated_at = ? WHERE user_id = ?;`,
        [now, userId],
      );
      if (activeJids.length > 0) {
        const chunkSize = 40;
        for (let i = 0; i < activeJids.length; i += chunkSize) {
          const chunk = activeJids.slice(i, i + chunkSize);
          const inPlaceholders = chunk.map(() => '?').join(', ');
          await CloudflareD1.query(
            `UPDATE wapier_sources SET is_active = 1, updated_at = ? WHERE user_id = ? AND jid IN (${inPlaceholders});`,
            [now, userId, ...chunk],
          );
        }
      }
    }
  }

  public listSources(userId: string, countsByJid: Map<string, number> = new Map()): MonitoredSource[] {
    const userSources = this.sources.get(userId);
    if (!userSources) return [];

    const orderWeight: Record<SourceType, number> = { self: 0, group: 1, contact: 2 };
    return Array.from(userSources.values())
      .filter((s) => isValidSourceJid(s.jid))
      .sort((a, b) => {
        if (a.isActive !== b.isActive) return a.isActive ? -1 : 1;
        if (orderWeight[a.type] !== orderWeight[b.type]) {
          return orderWeight[a.type] - orderWeight[b.type];
        }
        return a.name.localeCompare(b.name, 'fr');
      })
      .map((s) => ({
        jid: s.jid,
        name: formatCleanContactName(s.jid, s.name),
        type: s.type,
        isActive: s.isActive,
        detectedFilesCount: countsByJid.get(s.jid) || 0,
      }));
  }

  public getActiveJids(userId: string): Set<string> {
    const userSources = this.sources.get(userId);
    if (!userSources) return new Set();
    const set = new Set<string>();
    for (const s of userSources.values()) {
      if (s.isActive) set.add(s.jid);
    }
    return set;
  }

  public listUserFolders(userId: string): string[] {
    const set = this.folders.get(userId);
    return set ? Array.from(set).sort((a, b) => a.localeCompare(b)) : [];
  }

  public async addUserFolder(
    userId: string,
    folderName: string,
    flushImmediate = true,
  ): Promise<void> {
    if (!folderName) return;
    let set = this.folders.get(userId);
    if (!set) {
      set = new Set();
      this.folders.set(userId, set);
    }
    const isNew = !set.has(folderName);
    set.add(folderName);

    if (isNew && CloudflareD1.isConfigured()) {
      if (flushImmediate) {
        await CloudflareD1.query(
          `INSERT OR IGNORE INTO wapier_folders (user_id, folder_name, created_at) VALUES (?, ?, ?);`,
          [userId, folderName, Date.now()],
        );
      } else {
        this.pendingFoldersForD1.push({ userId, folderName, createdAt: Date.now() });
        this.scheduleFilesFlush();
      }
    }
  }

  /**
   * Vérification O(1) instantanée (messageId + SHA-256 avant téléchargement + MD5 après téléchargement),
   * couvrant à la fois les PDF déjà classés et les PDF ignorés.
   */
  public isAlreadyProcessed(userId: string, messageId?: string, fileHash?: string | null): boolean {
    if (messageId && this.processedMessageIds.get(userId)?.has(messageId)) {
      return true;
    }
    if (fileHash) {
      const hashSet = this.processedHashes.get(userId);
      if (hashSet) {
        for (const token of fileHash.split('|')) {
          if (token && hashSet.has(token)) return true;
        }
      }
    }
    return false;
  }

  private scheduleFilesFlush(): void {
    if (this.filesFlushTimer || !CloudflareD1.isConfigured()) return;
    this.filesFlushTimer = setTimeout(() => {
      this.filesFlushTimer = null;
      void this.flushPendingRecordsToD1();
    }, 350);
  }

  public async flushPendingRecordsToD1(): Promise<void> {
    if (!CloudflareD1.isConfigured()) return;

    if (this.activeFilesFlushPromise) {
      await this.activeFilesFlushPromise;
    }

    if (this.pendingFoldersForD1.length === 0 && this.pendingFilesForD1.length === 0) {
      return;
    }

    const runFlush = async () => {
      if (this.pendingFoldersForD1.length > 0) {
        const folderBatch = this.pendingFoldersForD1.splice(0, this.pendingFoldersForD1.length);
        const folderChunkSize = 25;
        for (let i = 0; i < folderBatch.length; i += folderChunkSize) {
          const slice = folderBatch.slice(i, i + folderChunkSize);
          const placeholders = slice.map(() => '(?, ?, ?)').join(', ');
          const params: Array<string | number> = [];
          for (const f of slice) {
            params.push(f.userId, f.folderName, f.createdAt);
          }
          try {
            await CloudflareD1.query(
              `INSERT OR IGNORE INTO wapier_folders (user_id, folder_name, created_at) VALUES ${placeholders};`,
              params,
            );
          } catch (err) {
            console.warn('[Store/D1] Avertissement batch dossiers :', (err as Error).message);
          }
        }
      }

      if (this.pendingFilesForD1.length > 0) {
        const fileBatch = this.pendingFilesForD1.splice(0, this.pendingFilesForD1.length);
        // 16 colonnes par ligne -> 5 lignes = 80 paramètres liés (<= limite 100 de D1/SQLite)
        const fileChunkSize = 5;
        for (let i = 0; i < fileBatch.length; i += fileChunkSize) {
          const slice = fileBatch.slice(i, i + fileChunkSize);
          const placeholders = slice
            .map(() => '(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
            .join(', ');
          const params: Array<string | number> = [];
          for (const row of slice) {
            params.push(
              row.id,
              row.userId,
              row.waMessageId,
              row.fileHash,
              row.folderName,
              row.docType,
              row.cleanTitle,
              row.fileName,
              row.mimeType,
              row.sizeBytes,
              row.sourceName,
              row.tempPath,
              row.status,
              row.syncedToPhone,
              row.receivedAtMs,
              row.createdAtMs,
            );
          }
          try {
            await CloudflareD1.query(
              `INSERT OR REPLACE INTO wapier_files (
                id, user_id, wa_message_id, file_hash, folder_name, doc_type, clean_title, file_name,
                mime_type, size_bytes, source_name, temp_path, status, synced_to_phone, received_at_ms, created_at_ms
              ) VALUES ${placeholders};`,
              params,
            );
          } catch (err) {
            console.warn('[Store/D1] Avertissement batch fichiers :', (err as Error).message);
          }
        }
      }
    };

    this.activeFilesFlushPromise = runFlush();
    try {
      await this.activeFilesFlushPromise;
    } finally {
      this.activeFilesFlushPromise = null;
    }
  }

  public async flushAllPendingToD1(): Promise<void> {
    if (this.sourcesFlushTimer) {
      clearTimeout(this.sourcesFlushTimer);
      this.sourcesFlushTimer = null;
    }
    if (this.filesFlushTimer) {
      clearTimeout(this.filesFlushTimer);
      this.filesFlushTimer = null;
    }
    await Promise.all([this.flushDirtySourcesToD1(), this.flushPendingRecordsToD1()]);
  }

  public async markIgnored(
    userId: string,
    messageId: string,
    fileHash: string,
    originalName: string,
    flushImmediate = true,
  ): Promise<void> {
    const list = this.ignored.get(userId) || [];
    list.push({ waMessageId: messageId, fileHash });
    this.ignored.set(userId, list);
    this.trackProcessedInMemory(userId, messageId, fileHash);

    if (CloudflareD1.isConfigured()) {
      const now = Date.now();
      const pendingRow: PendingFileRowForD1 = {
        id: `ign_${crypto.randomUUID()}`,
        userId,
        waMessageId: messageId,
        fileHash,
        folderName: 'Ignore',
        docType: 'Ignore',
        cleanTitle: originalName,
        fileName: originalName,
        mimeType: 'application/pdf',
        sizeBytes: 0,
        sourceName: 'WhatsApp',
        tempPath: '',
        status: 'ignored',
        syncedToPhone: 1,
        receivedAtMs: now,
        createdAtMs: now,
      };
      this.pendingFilesForD1.push(pendingRow);
      if (flushImmediate) {
        await this.flushPendingRecordsToD1();
      } else {
        this.scheduleFilesFlush();
      }
    }
  }

  public async saveClassifiedFile(
    record: Omit<StoredFileRecord, 'id' | 'createdAtMs' | 'syncedToPhone'>,
    options: { flushImmediate?: boolean } = {},
  ): Promise<StoredFileRecord> {
    const flushImmediate = options.flushImmediate !== false;

    const fullRecord: StoredFileRecord = {
      ...record,
      id: crypto.randomUUID(),
      syncedToPhone: false,
      createdAtMs: Date.now(),
    };

    let userFiles = this.files.get(record.userId);
    if (!userFiles) {
      userFiles = new Map();
      this.files.set(record.userId, userFiles);
    }
    userFiles.set(fullRecord.id, fullRecord);
    this.trackProcessedInMemory(record.userId, fullRecord.waMessageId, fullRecord.fileHash);

    await this.addUserFolder(record.userId, record.folderName, flushImmediate);

    if (CloudflareD1.isConfigured()) {
      this.pendingFilesForD1.push({
        id: fullRecord.id,
        userId: fullRecord.userId,
        waMessageId: fullRecord.waMessageId,
        fileHash: fullRecord.fileHash,
        folderName: fullRecord.folderName,
        docType: fullRecord.docType,
        cleanTitle: fullRecord.cleanTitle,
        fileName: fullRecord.fileName,
        mimeType: fullRecord.mimeType,
        sizeBytes: fullRecord.sizeBytes,
        sourceName: fullRecord.sourceName,
        tempPath: fullRecord.tempPath,
        status: 'classified',
        syncedToPhone: 0,
        receivedAtMs: fullRecord.receivedAtMs,
        createdAtMs: fullRecord.createdAtMs,
      });

      if (flushImmediate) {
        await this.flushPendingRecordsToD1();
      } else {
        this.scheduleFilesFlush();
      }
    }

    return fullRecord;
  }

  public listUserFiles(userId: string): StoredFileRecord[] {
    const userFiles = this.files.get(userId);
    if (!userFiles) return [];
    return Array.from(userFiles.values()).sort((a, b) => b.receivedAtMs - a.receivedAtMs);
  }

  public listPendingDownloads(userId: string): StoredFileRecord[] {
    return this.listUserFiles(userId).filter(
      (f) => !f.syncedToPhone && f.tempPath && fs.existsSync(f.tempPath),
    );
  }

  public getFileById(userId: string, fileId: string): StoredFileRecord | null {
    return this.files.get(userId)?.get(fileId) || null;
  }

  public async acknowledgeDownload(userId: string, fileId: string): Promise<boolean> {
    return (await this.acknowledgeDownloadsBatch(userId, [fileId])) > 0;
  }

  public async acknowledgeDownloadsBatch(userId: string, fileIds: string[]): Promise<number> {
    const validIds: string[] = [];
    for (const fileId of fileIds) {
      const record = this.getFileById(userId, fileId);
      if (record && !record.syncedToPhone) {
        record.syncedToPhone = true;
        validIds.push(fileId);
      }
    }

    if (validIds.length > 0 && CloudflareD1.isConfigured()) {
      await this.flushPendingRecordsToD1();
      const chunkSize = 40;
      for (let i = 0; i < validIds.length; i += chunkSize) {
        const slice = validIds.slice(i, i + chunkSize);
        const placeholders = slice.map(() => '?').join(', ');
        await CloudflareD1.query(
          `UPDATE wapier_files SET synced_to_phone = 1 WHERE user_id = ? AND id IN (${placeholders});`,
          [userId, ...slice],
        );
      }
    }

    return validIds.length;
  }

  public async deleteFile(userId: string, fileId: string): Promise<boolean> {
    const userFiles = this.files.get(userId);
    const record = userFiles?.get(fileId);
    if (!record) return false;

    if (record.tempPath && fs.existsSync(record.tempPath)) {
      try {
        fs.unlinkSync(record.tempPath);
      } catch (_) {}
    }

    userFiles!.delete(fileId);

    const hasRemainingInFolder = Array.from(userFiles!.values()).some(
      (f) => f.folderName === record.folderName,
    );
    if (!hasRemainingInFolder) {
      this.folders.get(userId)?.delete(record.folderName);
    }

    if (CloudflareD1.isConfigured()) {
      await this.flushPendingRecordsToD1();
      await CloudflareD1.query(`DELETE FROM wapier_files WHERE id = ? AND user_id = ?;`, [
        fileId,
        userId,
      ]);
      if (!hasRemainingInFolder) {
        await CloudflareD1.query(
          `DELETE FROM wapier_folders WHERE user_id = ? AND folder_name = ?;`,
          [userId, record.folderName],
        );
      }
    }
    return true;
  }

  public async moveFile(
    userId: string,
    fileId: string,
    targetFolderName: string,
  ): Promise<StoredFileRecord | null> {
    const userFiles = this.files.get(userId);
    const record = userFiles?.get(fileId);
    if (!record) return null;

    const oldFolder = record.folderName;
    record.folderName = targetFolderName;

    let userFolders = this.folders.get(userId);
    if (!userFolders) {
      userFolders = new Set();
      this.folders.set(userId, userFolders);
    }
    userFolders.add(targetFolderName);

    const hasRemainingInOld = Array.from(userFiles!.values()).some(
      (f) => f.folderName === oldFolder,
    );
    if (!hasRemainingInOld) {
      userFolders.delete(oldFolder);
    }

    if (CloudflareD1.isConfigured()) {
      await this.flushPendingRecordsToD1();
      await CloudflareD1.query(
        `UPDATE wapier_files SET folder_name = ? WHERE id = ? AND user_id = ?;`,
        [targetFolderName, fileId, userId],
      );
      await CloudflareD1.query(
        `INSERT OR IGNORE INTO wapier_folders (user_id, folder_name) VALUES (?, ?);`,
        [userId, targetFolderName],
      );
      if (!hasRemainingInOld) {
        await CloudflareD1.query(
          `DELETE FROM wapier_folders WHERE user_id = ? AND folder_name = ?;`,
          [userId, oldFolder],
        );
      }
    }

    return record;
  }
}

export const Store = new CloudflareBackedStore();
