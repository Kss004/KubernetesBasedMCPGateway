// Upstream credentials at rest: AES-256-GCM, base64(iv 12B || ciphertext || tag 16B).
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { decryptSecret, encryptSecret } from '../src/crypto.ts';

const key = randomBytes(32);
const flip = (blob: string, at: number) => {
  const raw = Buffer.from(blob, 'base64');
  raw[at < 0 ? raw.length + at : at] ^= 0x01;
  return raw.toString('base64');
};

describe('encryptSecret / decryptSecret', () => {
  it('round-trips, including empty and non-ASCII secrets', () => {
    for (const s of ['tok_123', '', 'pässwörd ✓ 🔑', 'x'.repeat(1024)]) assert.equal(decryptSecret(encryptSecret(s, key), key), s);
  });
  it('uses the documented layout and never stores the plaintext', () => {
    const s = 'super-secret-token';
    const blob = encryptSecret(s, key);
    assert.equal(Buffer.from(blob, 'base64').length, 12 + Buffer.byteLength(s) + 16);
    assert.ok(!blob.includes(s) && !Buffer.from(blob, 'base64').toString('latin1').includes(s));
  });
  it('a fresh IV per call: the same secret encrypts differently each time', () => {
    assert.notEqual(encryptSecret('same', key), encryptSecret('same', key));
  });
  it('fails closed with the wrong key', () => {
    assert.throws(() => decryptSecret(encryptSecret('s', key), randomBytes(32)));
  });
  it('detects tampering with the IV, the ciphertext or the tag', () => {
    const blob = encryptSecret('secret-value', key);
    for (const at of [0, 12, -1]) assert.throws(() => decryptSecret(flip(blob, at), key), `byte ${at}`);
  });
  it('rejects a truncated blob and a key of the wrong size', () => {
    const blob = encryptSecret('secret-value', key);
    assert.throws(() => decryptSecret(Buffer.from(blob, 'base64').subarray(0, 20).toString('base64'), key));
    assert.throws(() => encryptSecret('s', randomBytes(16)));
  });
});
