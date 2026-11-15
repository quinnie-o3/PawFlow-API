import { createCipheriv, createDecipheriv, createHmac, hkdfSync, randomBytes } from 'node:crypto';

import type { ConfigService } from '@nestjs/config';

/**
 * P3-BE05: protection of push registration values (FIDs / legacy tokens) at rest.
 *
 * - `registration_hash` = HMAC-SHA256(hashKey, kind + ":" + value): used for
 *   uniqueness and lookup without decrypting. The hash key must NOT be rotated
 *   (existing rows would no longer match); it is separate from the encryption
 *   keys for that reason.
 * - `registration_ciphertext` = AES-256-GCM with a random 96-bit IV, encoded
 *   `v1:<keyId>:<iv b64url>:<ciphertext b64url>:<tag b64url>`. Several keys
 *   may be configured; the FIRST encrypts, every listed key can decrypt, so
 *   keys can be rotated by prepending a new one (old rows stay readable;
 *   re-registration re-encrypts with the new key).
 *
 * Configuration:
 *   PUSH_REGISTRATION_KEYS     "id1:<base64 32 bytes>,id0:<base64 32 bytes>"
 *   PUSH_REGISTRATION_HASH_KEY "<base64, >= 32 bytes>"
 * Both are required when NODE_ENV=production. Outside production, when
 * unset, development keys are derived from JWT_SECRET (HKDF) with a startup
 * warning, so local development and QA need no extra secrets.
 */
export interface PushRegistrationKeys {
  activeKeyId: string;
  keys: ReadonlyMap<string, Buffer>;
  hashKey: Buffer;
  derivedForDevelopment: boolean;
}

const KEY_ID = /^[A-Za-z0-9_-]{1,32}$/;
const DEV_KEY_ID = 'dev';

function decodeKey(raw: string, what: string, minBytes: number, exactBytes?: number): Buffer {
  const buf = Buffer.from(raw.trim(), 'base64');
  if ((exactBytes !== undefined && buf.length !== exactBytes) || buf.length < minBytes) {
    throw new Error(`${what} must be base64 of ${exactBytes ?? `at least ${minBytes}`} bytes`);
  }
  return buf;
}

export function loadPushRegistrationKeys(config: ConfigService): PushRegistrationKeys {
  const production = config.get<string>('NODE_ENV') === 'production';
  const rawKeys = config.get<string>('PUSH_REGISTRATION_KEYS')?.trim();
  const rawHash = config.get<string>('PUSH_REGISTRATION_HASH_KEY')?.trim();

  if (!rawKeys || !rawHash) {
    if (production) {
      throw new Error('PUSH_REGISTRATION_KEYS and PUSH_REGISTRATION_HASH_KEY are required when NODE_ENV=production');
    }
    if (rawKeys || rawHash) {
      throw new Error('Set both PUSH_REGISTRATION_KEYS and PUSH_REGISTRATION_HASH_KEY, or neither (development only)');
    }
    const secret = config.get<string>('JWT_SECRET');
    if (!secret) throw new Error('JWT_SECRET is required to derive development push-registration keys');
    const derive = (info: string) => Buffer.from(hkdfSync('sha256', secret, 'pawflow-push-registrations', info, 32));
    return {
      activeKeyId: DEV_KEY_ID,
      keys: new Map([[DEV_KEY_ID, derive('encryption-v1')]]),
      hashKey: derive('hash-v1'),
      derivedForDevelopment: true,
    };
  }

  const keys = new Map<string, Buffer>();
  let activeKeyId = '';
  for (const entry of rawKeys.split(',').map((e) => e.trim()).filter(Boolean)) {
    const sep = entry.indexOf(':');
    const id = entry.slice(0, sep);
    if (sep < 1 || !KEY_ID.test(id)) throw new Error('PUSH_REGISTRATION_KEYS entries must be "<keyId>:<base64 key>"');
    if (keys.has(id)) throw new Error('PUSH_REGISTRATION_KEYS contains a duplicate key id');
    keys.set(id, decodeKey(entry.slice(sep + 1), 'Each PUSH_REGISTRATION_KEYS key', 32, 32));
    if (!activeKeyId) activeKeyId = id;
  }
  if (!activeKeyId) throw new Error('PUSH_REGISTRATION_KEYS must contain at least one key');

  return { activeKeyId, keys, hashKey: decodeKey(rawHash, 'PUSH_REGISTRATION_HASH_KEY', 32), derivedForDevelopment: false };
}

export function hashRegistration(keys: PushRegistrationKeys, kind: string, value: string): string {
  return createHmac('sha256', keys.hashKey).update(`${kind}:${value}`).digest('hex');
}

export function encryptRegistration(keys: PushRegistrationKeys, value: string): string {
  const key = keys.keys.get(keys.activeKeyId)!;
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return ['v1', keys.activeKeyId, iv.toString('base64url'), ciphertext.toString('base64url'), cipher.getAuthTag().toString('base64url')].join(':');
}

export function decryptRegistration(keys: PushRegistrationKeys, encoded: string): string {
  const [version, keyId, iv, ciphertext, tag] = encoded.split(':');
  if (version !== 'v1' || !keyId || !iv || !ciphertext || !tag) throw new Error('Unsupported push registration ciphertext format');
  const key = keys.keys.get(keyId);
  if (!key) throw new Error(`Push registration encrypted with unknown key id "${keyId}"`);
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64url'));
  decipher.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([decipher.update(Buffer.from(ciphertext, 'base64url')), decipher.final()]).toString('utf8');
}

/** Log-safe reference: first 8 hex chars of the HMAC (never the value). */
export const registrationRef = (hash: string) => `reg#${hash.slice(0, 8)}`;
