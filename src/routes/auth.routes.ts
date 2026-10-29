import crypto from 'crypto';
import { Router } from 'express';
import { hashPassword, verifyPassword } from '../services/auth/password';
import { CloudflareD1 } from '../services/db/cloudflareD1';
import { Store } from '../services/db/store';
import { ENV } from '../config/env';

export const authRouter = Router();

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * POST /api/auth/register
 * Enregistre un utilisateur dans le backend Cloudflare D1 avec son email et son mot de passe haché (scrypt + sel).
 */
authRouter.post('/register', async (req, res) => {
  try {
    const { email, password, name, userId } = req.body || {};

    if (!email || typeof email !== 'string' || !EMAIL_REGEX.test(email.trim())) {
      res.status(400).json({ error: 'Adresse email invalide.' });
      return;
    }

    if (!password || typeof password !== 'string' || password.length < 8) {
      res.status(400).json({ error: 'Le mot de passe doit comporter au moins 8 caractères.' });
      return;
    }

    const cleanEmail = email.trim().toLowerCase();
    const cleanName = typeof name === 'string' && name.trim() ? name.trim() : undefined;

    // Vérifier si un utilisateur existe déjà avec cet email
    const existing = Store.getUserByEmail(cleanEmail);
    const finalUserId = (userId && typeof userId === 'string' && userId.trim())
      ? userId.trim()
      : existing?.userId || `user_${crypto.randomUUID().replace(/-/g, '').slice(0, 24)}`;

    // Hachage cryptographique sécurisé (sel 16 octets + scrypt RFC 7914)
    const passwordHash = hashPassword(password);

    await Store.registerOrUpdateCredentials(finalUserId, cleanEmail, passwordHash, cleanName);

    console.log(`[Auth Backend] Utilisateur enregistré avec mot de passe haché : ${cleanEmail} (${finalUserId})`);

    res.status(200).json({
      success: true,
      userId: finalUserId,
      email: cleanEmail,
      name: cleanName || null,
      message: 'Compte enregistré et mot de passe haché avec succès en backend.',
    });
  } catch (err) {
    console.error('[Auth Backend] Erreur inscription :', err);
    res.status(500).json({ error: 'Erreur lors de l’enregistrement de l’utilisateur.' });
  }
});

/**
 * POST /api/auth/login
 * Vérifie les identifiants d'un utilisateur par rapport au mot de passe haché stocké.
 */
authRouter.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body || {};

    if (!email || !password) {
      res.status(400).json({ error: 'Email et mot de passe requis.' });
      return;
    }

    const cleanEmail = email.trim().toLowerCase();
    let user = Store.getUserByEmail(cleanEmail);

    if (!user && CloudflareD1.isConfigured()) {
      try {
        const rows = await CloudflareD1.query<{
          user_id: string;
          email: string | null;
          password_hash: string | null;
          name: string | null;
        }>(
          'SELECT user_id, email, password_hash, name FROM wapier_users WHERE LOWER(email) = ?',
          [cleanEmail],
        );
        if (rows[0] && rows[0].password_hash) {
          user = {
            userId: rows[0].user_id,
            email: rows[0].email || cleanEmail,
            passwordHash: rows[0].password_hash,
            name: rows[0].name || null,
          };
        }
      } catch (dbErr) {
        console.warn('[Auth Backend] Erreur recherche utilisateur Cloudflare D1 :', dbErr);
      }
    }

    if (!user || !user.passwordHash) {
      res.status(401).json({ error: 'Email ou mot de passe incorrect.' });
      return;
    }

    const isValid = verifyPassword(password, user.passwordHash);
    if (!isValid) {
      res.status(401).json({ error: 'Email ou mot de passe incorrect.' });
      return;
    }

    let signInToken: string | null = null;
    if (ENV.CLERK_SECRET_KEY) {
      try {
        const tokenRes = await fetch('https://api.clerk.com/v1/sign_in_tokens', {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${ENV.CLERK_SECRET_KEY}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            user_id: user.userId,
            expires_in_seconds: 86400,
          }),
        });
        const tokenData = (await tokenRes.json()) as { token?: string };
        if (tokenData && tokenData.token) {
          signInToken = tokenData.token;
        }
      } catch (tokenErr) {
        console.warn('[Auth Backend] Erreur génération ticket Clerk :', tokenErr);
      }
    }

    res.status(200).json({
      success: true,
      userId: user.userId,
      email: user.email,
      name: user.name,
      signInToken,
    });
  } catch (err) {
    console.error('[Auth Backend] Erreur connexion :', err);
    res.status(500).json({ error: 'Erreur lors de la vérification des identifiants.' });
  }
});

/**
 * GET /api/auth/check-email
 * Vérifie si un email existe déjà dans la base.
 */
authRouter.get('/check-email', (req, res) => {
  const email = typeof req.query.email === 'string' ? req.query.email.trim().toLowerCase() : '';
  if (!email) {
    res.status(400).json({ error: 'Paramètre email manquant.' });
    return;
  }

  const existing = Store.getUserByEmail(email);
  res.json({
    exists: Boolean(existing),
    userId: existing?.userId || null,
  });
});
