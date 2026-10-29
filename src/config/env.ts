import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';

const BACKEND_ROOT = path.resolve(__dirname, '../..');
const MOBILE_ROOT = path.resolve(BACKEND_ROOT, '../wapier');

// Charger les variables depuis backend/.env puis compléter avec wapier/.env si présent
dotenv.config({ path: path.join(BACKEND_ROOT, '.env') });
dotenv.config({ path: path.join(MOBILE_ROOT, '.env') });

export const ENV = {
  PORT: parseInt(process.env.PORT || '4000', 10),
  CLERK_PUBLISHABLE_KEY: (process.env.CLERK_PUBLISHABLE_KEY || '').trim(),
  CLERK_SECRET_KEY: (process.env.CLERK_SECRET_KEY || '').trim(),
  GEMINI_API_KEY: (process.env.GEMINI_API_KEY || '').trim(),
  GROQ_API_KEY: (process.env.GROQ_API_KEY || '').trim(),
  OPENROUTER_API_KEY: (process.env.OPENROUTER_API_KEY || '').trim(),
  CLOUDFLARE_ACCOUNT_ID: (process.env.CLOUDFLARE_ACCOUNT_ID || '').trim(),
  CLOUDFLARE_D1_DATABASE_ID: (
    process.env.CLOUDFLARE_D1_DATABASE_ID ||
    process.env.CLOUDFLARE_DATABASE_ID ||
    ''
  ).trim(),
  CLOUDFLARE_API_TOKEN: (process.env.CLOUDFLARE_API_TOKEN || '').trim(),
  PATHS: {
    SESSIONS_DIR: path.join(BACKEND_ROOT, '.sessions'),
    TEMP_FILES_DIR: path.join(BACKEND_ROOT, '.temp_files'),
    DATA_DIR: path.join(BACKEND_ROOT, 'data'),
  },
};

export function ensureRuntimeDirectories(): void {
  for (const dir of [ENV.PATHS.SESSIONS_DIR, ENV.PATHS.TEMP_FILES_DIR]) {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }
}
