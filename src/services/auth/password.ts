import crypto from 'crypto';

/**
 * Hache un mot de passe avec un sel cryptographique aléatoire de 16 octets
 * et dérivation scrypt sécurisée (standard RFC 7914 / Node.js native crypto).
 * Format retourné : "<salt_hex>:<hash_hex>"
 */
export function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16).toString('hex');
  const derivedKey = crypto.scryptSync(password, salt, 64);
  return `${salt}:${derivedKey.toString('hex')}`;
}

/**
 * Vérifie la correspondance d'un mot de passe en clair avec le hash stocké en base.
 * Utilise crypto.timingSafeEqual pour prévenir toute attaque temporelle (timing attacks).
 */
export function verifyPassword(password: string, storedHash: string | null | undefined): boolean {
  if (!storedHash || !storedHash.includes(':')) {
    return false;
  }
  const [salt, expectedHashHex] = storedHash.split(':');
  if (!salt || !expectedHashHex) {
    return false;
  }

  try {
    const expectedKey = Buffer.from(expectedHashHex, 'hex');
    const actualKey = crypto.scryptSync(password, salt, expectedKey.length);
    return crypto.timingSafeEqual(expectedKey, actualKey);
  } catch {
    return false;
  }
}
