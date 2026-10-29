import { verifyToken } from '@clerk/backend';
import { NextFunction, Request, Response } from 'express';
import { ENV } from '../config/env';

export interface AuthenticatedRequest extends Request {
  userId?: string;
}

/**
 * Middleware d'authentification Clerk simple et autonome.
 * Accepte soit l'en-tête `Authorization: Bearer <token>`, soit `?token=<token>`
 * (pratique pour le téléchargement direct de fichiers binaires par expo-file-system).
 */
export async function requireClerkUser(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const authHeader = req.headers.authorization;
    const bearerToken =
      authHeader && authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : null;
    const queryToken = typeof req.query.token === 'string' ? req.query.token.trim() : null;
    const token = bearerToken || queryToken;

    if (!token) {
      res.status(401).json({ error: 'Jeton Clerk manquant.' });
      return;
    }

    if (!ENV.CLERK_SECRET_KEY) {
      res.status(500).json({ error: 'CLERK_SECRET_KEY non configurée sur le backend.' });
      return;
    }

    const payload = await verifyToken(token, {
      secretKey: ENV.CLERK_SECRET_KEY,
    });

    if (!payload.sub) {
      res.status(401).json({ error: 'Utilisateur Clerk invalide.' });
      return;
    }

    req.userId = payload.sub;
    next();
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Session expirée ou invalide';
    res.status(401).json({ error: `Non autorisé : ${message}` });
  }
}
