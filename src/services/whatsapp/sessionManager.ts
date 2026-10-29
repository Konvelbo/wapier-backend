import { Boom } from '@hapi/boom';
import makeWASocket, {
  DisconnectReason,
  jidNormalizedUser,
  useMultiFileAuthState,
  WAMessage,
  WASocket,
} from '@whiskeysockets/baileys';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import pino from 'pino';

import { ENV } from '../../config/env';
import {
  MediaEnvelopeItem,
  SourceType,
  SyncDateFilter,
  SyncProgress,
  WhatsAppStatus,
} from '../../types/models';
import { classifyWhatsAppDocument, slugifyText } from '../ai/classifier';
import { Store } from '../db/store';
import { downloadMediaBufferSafe } from './mediaExtractor';
import { MediaIndex } from './mediaIndex';

interface UserRuntimeSession {
  sock: WASocket | null;
  status: WhatsAppStatus;
  phoneNumber: string | null;
  pairingCode: string | null;
  lastError: string | null;
  selfJid: string | null;
  contactNames: Map<string, string>;
  reconnectTimer: NodeJS.Timeout | null;
  progress: SyncProgress;
}

const SYNC_CONCURRENCY = 4;

class WhatsAppSessionManager {
  private sessions = new Map<string, UserRuntimeSession>();
  private inFlightLocks = new Set<string>();

  private getOrCreateRuntime(userId: string): UserRuntimeSession {
    let runtime = this.sessions.get(userId);
    if (!runtime) {
      const saved = Store.getUserSettings(userId);
      runtime = {
        sock: null,
        status: 'disconnected',
        phoneNumber: saved.waPhone,
        pairingCode: null,
        lastError: null,
        selfJid: null,
        contactNames: new Map(),
        reconnectTimer: null,
        progress: {
          isRunning: false,
          processed: 0,
          total: 0,
          classified: 0,
          ignored: 0,
          lastFileTitle: null,
          mode: saved.liveMode ? 'live_from_date' : 'idle',
        },
      };
      this.sessions.set(userId, runtime);
    }
    return runtime;
  }

  private getSessionFolder(userId: string): string {
    const safeId = userId.replace(/[^a-zA-Z0-9_-]/g, '_');
    return path.join(ENV.PATHS.SESSIONS_DIR, safeId, 'baileys_auth');
  }

  private getUserTempFolder(userId: string): string {
    const safeId = userId.replace(/[^a-zA-Z0-9_-]/g, '_');
    const dir = path.join(ENV.PATHS.TEMP_FILES_DIR, safeId);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    return dir;
  }

  /**
   * Nettoie le numéro de téléphone au format strict exigé par Baileys v7 :
   * chiffres uniquement avec indicatif pays (sans '+', espaces ni tirets).
   */
  public sanitizePhoneNumber(rawPhone: string): string {
    return (rawPhone || '').replace(/\D/g, '');
  }

  public getStatus(userId: string) {
    const runtime = this.getOrCreateRuntime(userId);
    const saved = Store.getUserSettings(userId);

    // Si des clés existent sur disque mais que la session n'a pas encore été relancée au démarrage
    const authDir = this.getSessionFolder(userId);
    if (
      runtime.status === 'disconnected' &&
      !runtime.sock &&
      fs.existsSync(path.join(authDir, 'creds.json'))
    ) {
      void this.startSocket(userId, null);
    }

    return {
      status: runtime.status,
      phoneNumber: runtime.phoneNumber,
      pairingCode: runtime.pairingCode,
      lastError: runtime.lastError,
      progress: runtime.progress,
      activeFilter: saved.filter,
      pendingDownloadsCount: Store.listPendingDownloads(userId).length,
    };
  }

  /**
   * Démarre une liaison par numéro et renvoie le code à 8 caractères dès qu'il est généré.
   */
  public async requestPairingCode(userId: string, rawPhone: string): Promise<string> {
    const digits = this.sanitizePhoneNumber(rawPhone);
    if (digits.length < 8 || digits.length > 15) {
      throw new Error(
        'Numéro invalide. Entrez le numéro complet avec indicatif pays (ex: 22670000000).',
      );
    }

    // Réinitialiser toute ancienne session non valide avant un nouvel appairage
    await this.disconnect(userId, true);

    await Store.upsertUserPhone(userId, digits);
    const runtime = this.getOrCreateRuntime(userId);
    runtime.phoneNumber = digits;
    runtime.pairingCode = null;
    runtime.lastError = null;

    return await this.startSocket(userId, digits);
  }

  private async startSocket(userId: string, phoneForPairing: string | null): Promise<string> {
    const runtime = this.getOrCreateRuntime(userId);
    if (runtime.reconnectTimer) {
      clearTimeout(runtime.reconnectTimer);
      runtime.reconnectTimer = null;
    }

    if (runtime.sock) {
      try {
        runtime.sock.ev.removeAllListeners('connection.update');
        runtime.sock.end(undefined);
      } catch (_) {}
      runtime.sock = null;
    }

    const authDir = this.getSessionFolder(userId);
    fs.mkdirSync(authDir, { recursive: true });
    const { state, saveCreds } = await useMultiFileAuthState(authDir);

    runtime.status = phoneForPairing ? 'pairing' : 'connecting';

    const sock = makeWASocket({
      auth: state,
      printQRInTerminal: false,
      logger: pino({ level: 'silent' }),
      browser: ['Ubuntu', 'Chrome', '20.0.04'],
      syncFullHistory: true,
    });

    runtime.sock = sock;
    sock.ev.on('creds.update', saveCreds);

    // Résolution des noms de contacts et conversations pour un affichage propre sur mobile
    sock.ev.on('contacts.upsert', (contacts) => {
      for (const c of contacts) {
        if (!c.id || c.id.endsWith('@lid') || c.id === 'status@broadcast') continue;
        const normJid = jidNormalizedUser(c.id);
        const label = (c.name || c.notify || c.verifiedName || '').trim();
        if (label) {
          runtime.contactNames.set(normJid, label);
        }
        if (!normJid.endsWith('@g.us')) {
          Store.upsertDiscoveredSource(userId, normJid, label, 'contact', false);
        }
      }
    });

    sock.ev.on('contacts.update', (updates) => {
      for (const c of updates) {
        if (!c.id || c.id.endsWith('@lid') || c.id === 'status@broadcast') continue;
        const normJid = jidNormalizedUser(c.id);
        const label = (c.name || c.notify || c.verifiedName || '').trim();
        if (label) {
          runtime.contactNames.set(normJid, label);
          if (!normJid.endsWith('@g.us')) {
            Store.upsertDiscoveredSource(userId, normJid, label, 'contact', false);
          }
        }
      }
    });

    sock.ev.on('chats.upsert', (chats) => {
      for (const chat of chats || []) {
        if (!chat.id || chat.id.endsWith('@lid') || chat.id === 'status@broadcast') continue;
        const normJid = jidNormalizedUser(chat.id);
        const isGroup = normJid.endsWith('@g.us');
        const name = (chat.name || runtime.contactNames.get(normJid) || '').trim();
        if (name) {
          runtime.contactNames.set(normJid, name);
        }
        Store.upsertDiscoveredSource(userId, normJid, name, isGroup ? 'group' : 'contact', false);
      }
    });

    sock.ev.on('chats.update', (updates) => {
      for (const chat of updates || []) {
        if (!chat.id || chat.id.endsWith('@lid') || chat.id === 'status@broadcast') continue;
        const normJid = jidNormalizedUser(chat.id);
        if (chat.name) {
          const isGroup = normJid.endsWith('@g.us');
          runtime.contactNames.set(normJid, chat.name.trim());
          Store.upsertDiscoveredSource(userId, normJid, chat.name.trim(), isGroup ? 'group' : 'contact', false);
        }
      }
    });

    // Indexation légère de l'historique (0 Mo téléchargé ici)
    sock.ev.on('messaging-history.set', ({ messages, chats, contacts }) => {
      for (const c of contacts || []) {
        if (!c.id || c.id.endsWith('@lid') || c.id === 'status@broadcast') continue;
        const normJid = jidNormalizedUser(c.id);
        const label = (c.name || c.notify || '').trim();
        if (label) {
          runtime.contactNames.set(normJid, label);
        }
      }
      for (const chat of chats || []) {
        if (!chat.id || chat.id.endsWith('@lid') || chat.id === 'status@broadcast') continue;
        const normJid = jidNormalizedUser(chat.id);
        const name = (chat.name || runtime.contactNames.get(normJid) || '').trim();
        const type: SourceType = normJid.endsWith('@g.us') ? 'group' : 'contact';
        Store.upsertDiscoveredSource(userId, normJid, name, type, false);
      }
      for (const msg of messages || []) {
        this.indexIncomingMessage(userId, runtime, msg, false);
      }
      MediaIndex.saveToDisk(userId);
    });

    // Messages reçus en direct
    sock.ev.on('messages.upsert', ({ messages }) => {
      for (const msg of messages || []) {
        this.indexIncomingMessage(userId, runtime, msg, true);
      }
      MediaIndex.saveToDisk(userId);
    });

    return await new Promise<string>((resolve, reject) => {
      let pairingRequested = false;
      let settled = false;

      const finishResolve = (code: string) => {
        if (!settled) {
          settled = true;
          if (pairTimeout) clearTimeout(pairTimeout);
          if (backupTimer) clearTimeout(backupTimer);
          resolve(code);
        }
      };

      const finishReject = (err: Error) => {
        if (!settled) {
          settled = true;
          if (pairTimeout) clearTimeout(pairTimeout);
          if (backupTimer) clearTimeout(backupTimer);
          reject(err);
        }
      };

      const pairTimeout = phoneForPairing
        ? setTimeout(() => {
            finishReject(
              new Error('Délai dépassé lors de la demande du code WhatsApp. Vérifiez votre numéro et réessayez.'),
            );
          }, 20000)
        : null;

      const triggerPairing = async () => {
        if (pairingRequested || settled || !phoneForPairing) return;
        pairingRequested = true;
        try {
          const rawCode = await sock.requestPairingCode(phoneForPairing);
          const formatted =
            rawCode.length === 8 ? `${rawCode.slice(0, 4)}-${rawCode.slice(4)}` : rawCode;
          runtime.pairingCode = formatted;
          runtime.status = 'pairing';
          finishResolve(formatted);
        } catch (err) {
          const msg = (err as Error)?.message || 'Échec de la demande de code';
          runtime.lastError = msg;
          finishReject(new Error(`WhatsApp a refusé la demande de code : ${msg}`));
        }
      };

      sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;

        // Déclencheur 1 : Dès que le handshake Noise est prêt (émission de `qr`) et non enregistré
        if (
          phoneForPairing &&
          !sock.authState.creds.registered &&
          !pairingRequested &&
          Boolean(qr)
        ) {
          setTimeout(() => {
            void triggerPairing();
          }, 300);
        }

        if (connection === 'open') {
          runtime.status = 'connected';
          runtime.pairingCode = null;
          runtime.lastError = null;

          if (sock.user?.id) {
            runtime.selfJid = jidNormalizedUser(sock.user.id);
            Store.upsertDiscoveredSource(
              userId,
              runtime.selfJid,
              'Mes messages personnels (Moi-même)',
              'self',
              true, // Activé par défaut pour pouvoir s'envoyer des fichiers à trier !
            );
          }

          await this.refreshGroups(userId, sock);
          finishResolve('CONNECTED');
        } else if (connection === 'close') {
          const statusCode = new Boom(lastDisconnect?.error as Error)?.output?.statusCode;
          const loggedOut = statusCode === DisconnectReason.loggedOut;

          if (loggedOut) {
            runtime.status = 'disconnected';
            runtime.pairingCode = null;
            this.wipeAuthFiles(userId);
          } else if (sock.authState.creds.registered) {
            runtime.status = 'connecting';
            runtime.reconnectTimer = setTimeout(() => {
              void this.startSocket(userId, null);
            }, 4000);
          } else {
            runtime.status = 'disconnected';
          }

          // Si la connexion se coupe avant d'obtenir le code d'appairage
          if (!settled && phoneForPairing) {
            const errDetail =
              (lastDisconnect?.error as Error)?.message || `Code déconnexion ${statusCode || 'inconnu'}`;
            finishReject(
              new Error(`Connexion au serveur WhatsApp interrompue (${errDetail}). Veuillez réappuyer pour réessayer.`),
            );
          }
        }
      });

      // Déclencheur 2 (Secours) : Si 'qr' tarde mais que le socket est initialisé
      const backupTimer = phoneForPairing
        ? setTimeout(() => {
            if (!pairingRequested && !settled && !sock.authState.creds.registered) {
              void triggerPairing();
            }
          }, 3500)
        : null;
    });
  }

  public async refreshGroups(userId: string, sockOverride?: WASocket): Promise<void> {
    const runtime = this.getOrCreateRuntime(userId);
    const sock = sockOverride || runtime.sock;
    if (!sock || runtime.status !== 'connected') return;

    try {
      const groups = await sock.groupFetchAllParticipating();
      for (const [jid, meta] of Object.entries(groups)) {
        if (meta.subject) {
          runtime.contactNames.set(jid, meta.subject);
          Store.upsertDiscoveredSource(userId, jid, meta.subject, 'group', false);
        }
      }
    } catch (err) {
      console.warn('[WhatsApp/Groups] Avertissement récupération groupes :', (err as Error).message);
    }
  }

  private indexIncomingMessage(
    userId: string,
    runtime: UserRuntimeSession,
    msg: WAMessage,
    isLiveEvent: boolean,
  ): void {
    const rawJid = msg.key?.remoteJid;
    if (!rawJid || rawJid === 'status@broadcast' || rawJid.endsWith('@lid')) return;

    const jid = rawJid.endsWith('@g.us') ? rawJid : jidNormalizedUser(rawJid);
    const isSelf = Boolean(runtime.selfJid && jid === runtime.selfJid);
    const type: SourceType = isSelf ? 'self' : jid.endsWith('@g.us') ? 'group' : 'contact';

    const fallbackName = isSelf
      ? 'Mes messages personnels (Moi-même)'
      : msg.pushName || jid.split('@')[0];
    const resolvedName = runtime.contactNames.get(jid) || fallbackName;

    if (type !== 'group') {
      Store.upsertDiscoveredSource(userId, jid, resolvedName, type, isSelf);
    }

    const normalizedMsg: WAMessage = {
      ...msg,
      key: { ...msg.key, remoteJid: jid },
    };

    const indexed = MediaIndex.indexMessageIfMedia(userId, normalizedMsg, resolvedName, type);
    if (!indexed || !isLiveEvent) return;

    // Si l'utilisateur est en mode "Du X à maintenant" (liveMode = true) et que la source est cochée
    const settings = Store.getUserSettings(userId);
    const activeJids = Store.getActiveJids(userId);
    if (
      settings.liveMode &&
      settings.filter &&
      activeJids.has(jid) &&
      indexed.timestampMs >= settings.filter.startDateMs
    ) {
      void this.processSingleEnvelope(userId, runtime, indexed);
    }
  }

  /**
   * Aperçu instantané (0 appel IA) du nombre de fichiers présents sur la période choisie.
   */
  public previewSyncCount(userId: string, filter: SyncDateFilter): number {
    const activeJids = Store.getActiveJids(userId);
    return MediaIndex.filterBySourcesAndDates(userId, activeJids, filter).length;
  }

  /**
   * Lance le tri IA uniquement sur les groupes/contacts cochés et la plage [Date X -> Date Y / Maintenant].
   */
  public async startTargetedSync(userId: string, filter: SyncDateFilter): Promise<{ queued: number }> {
    const runtime = this.getOrCreateRuntime(userId);
    if (!runtime.sock || runtime.status !== 'connected') {
      throw new Error("WhatsApp n'est pas encore connecté.");
    }

    await Store.saveUserDateFilter(userId, filter);
    const activeJids = Store.getActiveJids(userId);
    if (activeJids.size === 0) {
      throw new Error('Sélectionnez au moins un groupe ou un contact à trier.');
    }

    const envelopes = MediaIndex.filterBySourcesAndDates(userId, activeJids, filter);

    runtime.progress = {
      isRunning: true,
      processed: 0,
      total: envelopes.length,
      classified: 0,
      ignored: 0,
      lastFileTitle: null,
      mode: filter.endDateMs === null ? 'live_from_date' : 'range_fixed',
    };

    // Exécution parallèle (pool de 4 workers simultanés, zéro pause artificielle)
    void (async () => {
      let cursor = 0;
      const workerCount = Math.min(SYNC_CONCURRENCY, Math.max(1, envelopes.length));

      await Promise.all(
        Array.from({ length: workerCount }, async () => {
          while (cursor < envelopes.length) {
            if (runtime.status !== 'connected' || !runtime.sock) break;
            const currentIdx = cursor++;
            const env = envelopes[currentIdx];
            try {
              await this.processSingleEnvelope(userId, runtime, env);
            } catch (err) {
              console.warn('[WhatsApp/Sync] Erreur traitement PDF :', (err as Error).message);
            } finally {
              runtime.progress.processed += 1;
            }
          }
        }),
      );

      await Store.flushAllPendingToD1();
      runtime.progress.isRunning = false;
    })();

    return { queued: envelopes.length };
  }

  private async processSingleEnvelope(
    userId: string,
    runtime: UserRuntimeSession,
    env: MediaEnvelopeItem,
  ): Promise<void> {
    if (!runtime.sock || !env.isPdf) return;

    // 1. Déduplication O(1) AVANT téléchargement via messageId ou fileSha256 natif WhatsApp (0 Mo téléchargé)
    if (Store.isAlreadyProcessed(userId, env.messageId, env.preDownloadHash || null)) {
      return;
    }

    // Verrou en vol pour éviter que 2 workers parallèles téléchargent le même PDF transféré dans 2 groupes
    const lockKey = `${userId}:${env.preDownloadHash || env.messageId}`;
    if (this.inFlightLocks.has(lockKey)) {
      return;
    }
    this.inFlightLocks.add(lockKey);

    try {
      const rawMsg = MediaIndex.deserializeRawMessage(env);
      const buffer = await downloadMediaBufferSafe(rawMsg, runtime.sock);
      if (!buffer || buffer.length === 0) return;

      const md5Hash = crypto.createHash('md5').update(buffer).digest('hex');
      const combinedHash = env.preDownloadHash ? `${md5Hash}|${env.preDownloadHash}` : md5Hash;

      if (Store.isAlreadyProcessed(userId, env.messageId, combinedHash)) {
        Store.registerAdditionalHash(userId, combinedHash);
        return;
      }

      const existingFolders = Store.listUserFolders(userId);
      const result = await classifyWhatsAppDocument({
        buffer,
        mimeType: 'application/pdf',
        isPdf: true,
        originalFileName: env.originalFileName,
        caption: env.caption,
        sourceName: env.sourceName,
        existingFolders,
      });

      if (result.ignore) {
        await Store.markIgnored(userId, env.messageId, combinedHash, env.originalFileName, false);
        runtime.progress.ignored += 1;
        return;
      }

      const dateIso = new Date(env.timestampMs).toISOString().split('T')[0];
      const finalFileName = `${dateIso}_${slugifyText(result.docType)}_${result.cleanTitle}.pdf`;

      const tempDir = this.getUserTempFolder(userId);
      const uniqueTempName = `${Date.now()}_${crypto.randomBytes(3).toString('hex')}_${finalFileName}`;
      const tempPath = path.join(tempDir, uniqueTempName);

      fs.writeFileSync(tempPath, buffer);

      await Store.saveClassifiedFile(
        {
          userId,
          waMessageId: env.messageId,
          fileHash: combinedHash,
          folderName: result.folderName,
          docType: result.docType,
          cleanTitle: result.cleanTitle.replace(/_/g, ' '),
          fileName: finalFileName,
          mimeType: 'application/pdf',
          sizeBytes: buffer.length,
          sourceName: env.sourceName,
          tempPath,
          receivedAtMs: env.timestampMs,
        },
        { flushImmediate: false },
      );

      runtime.progress.classified += 1;
      runtime.progress.lastFileTitle = finalFileName;
    } finally {
      this.inFlightLocks.delete(lockKey);
    }
  }

  private wipeAuthFiles(userId: string): void {
    const authDir = this.getSessionFolder(userId);
    if (fs.existsSync(authDir)) {
      try {
        fs.rmSync(authDir, { recursive: true, force: true });
      } catch (_) {}
    }
  }

  public async disconnect(userId: string, clearIndex = false): Promise<void> {
    const runtime = this.sessions.get(userId);
    if (runtime) {
      if (runtime.reconnectTimer) clearTimeout(runtime.reconnectTimer);
      if (runtime.sock) {
        try {
          if (runtime.sock.authState?.creds?.registered) {
            await Promise.race([
              runtime.sock.logout(),
              new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 1500)),
            ]).catch(() => {});
          }
        } catch (_) {}
        try {
          runtime.sock.end(undefined);
        } catch (_) {}
      }
      runtime.sock = null;
      runtime.status = 'disconnected';
      runtime.pairingCode = null;
    }
    this.wipeAuthFiles(userId);
    if (clearIndex) {
      MediaIndex.clearUserIndex(userId);
    }
  }
}

export const SessionManager = new WhatsAppSessionManager();
