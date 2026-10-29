import { ENV } from '../../config/env';

interface D1QueryResponse<T = Record<string, unknown>> {
  success: boolean;
  errors?: Array<{ message?: string }>;
  result?: Array<{ results?: T[] }>;
}

export interface D1UserRow {
  user_id: string;
  email: string | null;
  password_hash: string | null;
  name: string | null;
  wa_phone: string | null;
  sync_start_ms: number | null;
  sync_end_ms: number | null;
  live_mode: number;
  device_folder_uri: string | null;
  updated_at: number;
}

export interface D1SourceRow {
  user_id: string;
  jid: string;
  name: string;
  source_type: string;
  is_active: number;
  updated_at: number;
}

export interface D1FolderRow {
  user_id: string;
  folder_name: string;
  created_at: number;
}

export interface D1FileRow {
  id: string;
  user_id: string;
  wa_message_id: string;
  file_hash: string;
  folder_name: string;
  doc_type: string;
  clean_title: string;
  file_name: string;
  mime_type: string;
  size_bytes: number;
  source_name: string;
  temp_path: string;
  status: string;
  synced_to_phone: number;
  received_at_ms: number;
  created_at_ms: number;
}

/**
 * Client officiel de base de données Cloudflare D1 (`wapier`).
 * Toutes les données utilisateurs, sources WhatsApp, dossiers IA et fichiers classés
 * sont stockées sur Cloudflare D1 (aucun fichier SQLite local requis).
 */
export const CloudflareD1 = {
  isConfigured(): boolean {
    return Boolean(
      ENV.CLOUDFLARE_ACCOUNT_ID &&
        ENV.CLOUDFLARE_D1_DATABASE_ID &&
        ENV.CLOUDFLARE_API_TOKEN,
    );
  },

  async query<T = Record<string, unknown>>(
    sql: string,
    params: Array<string | number | null> = [],
    maxRetries = 3,
  ): Promise<T[]> {
    if (!CloudflareD1.isConfigured()) {
      throw new Error('Identifiants Cloudflare D1 manquants dans backend/.env');
    }

    const url = `https://api.cloudflare.com/client/v4/accounts/${ENV.CLOUDFLARE_ACCOUNT_ID}/d1/database/${ENV.CLOUDFLARE_D1_DATABASE_ID}/query`;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        const res = await fetch(url, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${ENV.CLOUDFLARE_API_TOKEN}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ sql, params }),
        });

        const data = (await res.json()) as D1QueryResponse<T>;
        if (!data.success) {
          throw new Error(data.errors?.[0]?.message || 'Erreur API Cloudflare D1');
        }

        return data.result?.[0]?.results || [];
      } catch (err) {
        const msg = (err as Error).message || '';
        const isTransient =
          msg.includes('ECONNRESET') ||
          msg.includes('terminated') ||
          msg.includes('fetch failed') ||
          msg.includes('ETIMEDOUT');

        if (isTransient && attempt < maxRetries) {
          await new Promise((r) => setTimeout(r, 800 * attempt));
          continue;
        }
        throw err;
      }
    }

    return [];
  },

  async initSchema(): Promise<void> {
    await CloudflareD1.query(`
      CREATE TABLE IF NOT EXISTS wapier_users (
        user_id TEXT PRIMARY KEY,
        email TEXT,
        password_hash TEXT,
        name TEXT,
        wa_phone TEXT,
        sync_start_ms INTEGER,
        sync_end_ms INTEGER,
        live_mode INTEGER NOT NULL DEFAULT 0,
        device_folder_uri TEXT,
        updated_at INTEGER NOT NULL
      );
    `);

    // Migrations automatiques pour tables existantes
    try {
      await CloudflareD1.query(`ALTER TABLE wapier_users ADD COLUMN email TEXT;`);
    } catch {
      // Ignorer si la colonne existe déjà
    }
    try {
      await CloudflareD1.query(`ALTER TABLE wapier_users ADD COLUMN password_hash TEXT;`);
    } catch {
      // Ignorer si la colonne existe déjà
    }
    try {
      await CloudflareD1.query(`ALTER TABLE wapier_users ADD COLUMN name TEXT;`);
    } catch {
      // Ignorer si la colonne existe déjà
    }
    try {
      await CloudflareD1.query(`CREATE INDEX IF NOT EXISTS idx_wapier_users_email ON wapier_users(email);`);
    } catch {
      // Ignorer si l'index existe déjà
    }

    await CloudflareD1.query(`
      CREATE TABLE IF NOT EXISTS wapier_sources (
        user_id TEXT NOT NULL,
        jid TEXT NOT NULL,
        name TEXT NOT NULL,
        source_type TEXT NOT NULL,
        is_active INTEGER NOT NULL DEFAULT 0,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (user_id, jid)
      );
    `);

    await CloudflareD1.query(`
      CREATE TABLE IF NOT EXISTS wapier_folders (
        user_id TEXT NOT NULL,
        folder_name TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (user_id, folder_name)
      );
    `);

    await CloudflareD1.query(`
      CREATE TABLE IF NOT EXISTS wapier_files (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        wa_message_id TEXT NOT NULL,
        file_hash TEXT NOT NULL,
        folder_name TEXT NOT NULL,
        doc_type TEXT NOT NULL,
        clean_title TEXT NOT NULL,
        file_name TEXT NOT NULL,
        mime_type TEXT NOT NULL,
        size_bytes INTEGER NOT NULL,
        source_name TEXT NOT NULL,
        temp_path TEXT NOT NULL,
        status TEXT NOT NULL,
        synced_to_phone INTEGER NOT NULL DEFAULT 0,
        received_at_ms INTEGER NOT NULL,
        created_at_ms INTEGER NOT NULL
      );
    `);

    await CloudflareD1.query(`
      CREATE INDEX IF NOT EXISTS idx_wapier_files_user_hash
      ON wapier_files(user_id, file_hash);
    `);

    await CloudflareD1.query(`
      CREATE INDEX IF NOT EXISTS idx_wapier_files_user_msg
      ON wapier_files(user_id, wa_message_id);
    `);
  },

  async loadAllState(): Promise<{
    users: D1UserRow[];
    sources: D1SourceRow[];
    folders: D1FolderRow[];
    files: D1FileRow[];
  }> {
    await CloudflareD1.initSchema();
    const [users, sources, folders, files] = await Promise.all([
      CloudflareD1.query<D1UserRow>(`SELECT * FROM wapier_users;`),
      CloudflareD1.query<D1SourceRow>(`SELECT * FROM wapier_sources;`),
      CloudflareD1.query<D1FolderRow>(`SELECT * FROM wapier_folders;`),
      CloudflareD1.query<D1FileRow>(`SELECT * FROM wapier_files ORDER BY received_at_ms DESC;`),
    ]);

    return { users, sources, folders, files };
  },
};
