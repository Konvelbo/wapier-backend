import crypto from 'crypto';
import { Router } from 'express';
import { hashPassword, verifyPassword } from '../services/auth/password';
import { Store } from '../services/db/store';

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
    const user = Store.getUserByEmail(cleanEmail);

    if (!user || !user.passwordHash) {
      res.status(401).json({ error: 'Email ou mot de passe incorrect.' });
      return;
    }

    const isValid = verifyPassword(password, user.passwordHash);
    if (!isValid) {
      res.status(401).json({ error: 'Email ou mot de passe incorrect.' });
      return;
    }

    res.status(200).json({
      success: true,
      userId: user.userId,
      email: user.email,
      name: user.name,
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
