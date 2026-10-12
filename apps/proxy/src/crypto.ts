import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

/**
 * Vault for customers' provider keys: AES-256-GCM.
 * GCM both encrypts and authenticates, so a tampered ciphertext fails to decrypt instead of
 * yielding garbage. The "additional authenticated data" binds each secret to its project and
 * provider: copying one project's encrypted key into another project's row makes decryption fail.
 */
export class Vault {
  constructor(
    private keys: Map<string, Buffer>,
    private activeKeyId: string,
  ) {}

  encrypt(plaintext: string, context: string): { secret: Buffer; keyId: string } {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.keys.get(this.activeKeyId)!, iv);
    cipher.setAAD(Buffer.from(context));
    const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    return { secret: Buffer.concat([iv, cipher.getAuthTag(), ct]), keyId: this.activeKeyId };
  }

  decrypt(secret: Buffer, keyId: string, context: string): string {
    const key = this.keys.get(keyId);
    if (!key) throw new Error(`Unknown encryption key id "${keyId}"`);
    const decipher = createDecipheriv('aes-256-gcm', key, secret.subarray(0, 12));
    decipher.setAuthTag(secret.subarray(12, 28));
    decipher.setAAD(Buffer.from(context));
    return Buffer.concat([decipher.update(secret.subarray(28)), decipher.final()]).toString('utf8');
  }
}

export const credentialContext = (projectId: string, provider: string) => `${projectId}:${provider}`;

const BASE62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
export const KEY_PREFIX = 'apg_live_';

/** 32 base62 characters ≈ 190 bits of randomness. Rejection sampling avoids modulo bias. */
export function generateApiKey(): string {
  let out = '';
  while (out.length < 32) {
    for (const b of randomBytes(48)) {
      if (b < 248 && out.length < 32) out += BASE62[b % 62];
    }
  }
  return KEY_PREFIX + out;
}

export function hashApiKey(key: string): string {
  return createHash('sha256').update(key).digest('hex');
}

export function looksLikeOurKey(key: string): boolean {
  return key.startsWith(KEY_PREFIX) && key.length === KEY_PREFIX.length + 32;
}
