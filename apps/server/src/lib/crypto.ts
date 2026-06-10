/**
 * AES-256-GCM encrypt/decrypt for secrets at rest (invariant I7).
 * Key derived from CTB_SECRET via scrypt with a fixed app salt.
 * Output format: base64(iv).base64(tag).base64(ciphertext)
 */
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';

const APP_SALT = 'ctb-secret-v1'; // versioned: changing it = new format version
const IV_LEN = 12;

export class CryptoConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CryptoConfigError';
  }
}

export function deriveKey(secret: string): Buffer {
  if (typeof secret !== 'string' || secret.length < 16) {
    throw new CryptoConfigError('CTB_SECRET must be at least 16 characters');
  }
  return scryptSync(secret, APP_SALT, 32);
}

export function encrypt(plaintext: string, key: Buffer): string {
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString('base64')}.${tag.toString('base64')}.${enc.toString('base64')}`;
}

export function decrypt(payload: string, key: Buffer): string {
  const parts = payload.split('.');
  if (parts.length !== 3) throw new Error('invalid encrypted payload format');
  const [ivB64, tagB64, dataB64] = parts as [string, string, string];
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(ivB64, 'base64'));
  decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(dataB64, 'base64')), decipher.final()]).toString('utf8');
}
