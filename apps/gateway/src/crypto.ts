// AES-256-GCM with Node crypto (no third-party crypto library).
// Blob format: base64(iv 12B || ciphertext || tag 16B). Key never leaves env.
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

export function encryptSecret(plaintext: string, key: Buffer): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, ct, tag]).toString('base64');
}

export function decryptSecret(blob: string, key: Buffer): string {
  const raw = Buffer.from(blob, 'base64');
  const iv = raw.subarray(0, 12);
  const tag = raw.subarray(raw.length - 16);
  const ct = raw.subarray(12, raw.length - 16);
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
}
