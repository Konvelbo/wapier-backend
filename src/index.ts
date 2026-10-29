import cors from 'cors';
import express from 'express';
import { ENV, ensureRuntimeDirectories } from './config/env';
import { authRouter } from './routes/auth.routes';
import { filesRouter } from './routes/files.routes';
import { whatsappRouter } from './routes/whatsapp.routes';
import { CloudflareD1 } from './services/db/cloudflareD1';
import { Store } from './services/db/store';

// Protection contre les micro-coupures réseau de socket WhatsApp (ECONNRESET)
process.on('uncaughtException', (err: NodeJS.ErrnoException) => {
  if (err?.code === 'ECONNRESET' || err?.message?.includes('terminated')) {
    console.warn('[Réseau] Micro-coupure interceptée (ECONNRESET). Reconnexion automatique active.');
    return;
  }
  console.error('[Erreur Critique]', err);
});

process.on('unhandledRejection', (reason: unknown) => {
  const err = reason as NodeJS.ErrnoException;
  if (err?.code === 'ECONNRESET' || err?.message?.includes('terminated')) {
    return;
  }
  console.error('[Promesse Rejetée]', reason);
});

ensureRuntimeDirectories();

const app = express();

app.use(
  cors({
    origin: true,
    credentials: true,
  }),
);
app.use(express.json({ limit: '15mb' }));

app.get('/api/health', (_req, res) => {
  res.json({
    service: 'wapier-backend',
    status: 'ok',
    aiConfigured: Boolean(ENV.GEMINI_API_KEY || ENV.GROQ_API_KEY),
    clerkConfigured: Boolean(ENV.CLERK_SECRET_KEY),
    cloudflareD1Configured: CloudflareD1.isConfigured(),
    cloudflareD1Ready: Store.isInitialized(),
  });
});

app.use('/api/auth', authRouter);
app.use('/api/whatsapp', whatsappRouter);
app.use('/api/files', filesRouter);

async function bootstrap() {
  try {
    await Store.initFromCloudflareD1();
  } catch (err) {
    console.error('[Cloudflare D1] Erreur initialisation au démarrage :', (err as Error).message);
  }

  app.listen(ENV.PORT, '0.0.0.0', () => {
    console.log(`🚀 Wapier Backend démarré sur http://0.0.0.0:${ENV.PORT}`);
  });
}

void bootstrap();
