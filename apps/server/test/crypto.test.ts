import { describe, expect, it } from 'vitest';
import { CryptoConfigError, decrypt, deriveKey, encrypt } from '../src/lib/crypto';

describe('crypto (AES-256-GCM)', () => {
  const key = deriveKey('devsecret0123456');

  it('round-trips plaintext incl. unicode', () => {
    const secret = 'bot-token: 123456:ABC-DEF — توکن فارسی 🤖';
    expect(decrypt(encrypt(secret, key), key)).toBe(secret);
  });

  it('produces different ciphertexts per call (random IV)', () => {
    expect(encrypt('same', key)).not.toBe(encrypt('same', key));
  });

  it('rejects tampered ciphertext (GCM auth)', () => {
    const payload = encrypt('secret', key);
    const parts = payload.split('.');
    const data = Buffer.from(parts[2]!, 'base64');
    data[0] = data[0]! ^ 0xff;
    const tampered = `${parts[0]}.${parts[1]}.${data.toString('base64')}`;
    expect(() => decrypt(tampered, key)).toThrow();
  });

  it('rejects wrong key', () => {
    const other = deriveKey('anothersecret9876543');
    expect(() => decrypt(encrypt('x', key), other)).toThrow();
  });

  it('refuses short CTB_SECRET (<16 chars)', () => {
    expect(() => deriveKey('short')).toThrow(CryptoConfigError);
  });

  it('rejects malformed payloads', () => {
    expect(() => decrypt('not-a-payload', key)).toThrow('invalid encrypted payload format');
  });
});
