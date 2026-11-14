import { randomBytes } from 'node:crypto';

import { BadRequestException, ValidationPipe } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import type { DataSource } from 'typeorm';

import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';
import { GLOBAL_VALIDATION_PIPE_OPTIONS } from '../common/pipes/validation-pipe.options';
import { RegisterPushDeviceDto } from './dto/push-device.dto';
import { PushDevicesController } from './push-devices.controller';
import { PushDevicesService } from './push-devices.service';
import {
  decryptRegistration,
  encryptRegistration,
  hashRegistration,
  loadPushRegistrationKeys,
  registrationRef,
} from './push-registration.crypto';

const config = (values: Record<string, string | undefined>) => ({ get: (k: string) => values[k] }) as unknown as ConfigService;
const key = () => randomBytes(32).toString('base64');
const FID = 'cVxq3f8mT0uYhL2s9pQ1zA';
const TOKEN = 'dGVzdA:APA91b' + 'x'.repeat(140);

describe('push registration crypto (P3-BE05)', () => {
  it('development: keys derived from JWT_SECRET when none are configured', () => {
    const keys = loadPushRegistrationKeys(config({ JWT_SECRET: 'dev-secret' }));
    expect(keys).toMatchObject({ activeKeyId: 'dev', derivedForDevelopment: true });
    expect(loadPushRegistrationKeys(config({ JWT_SECRET: 'dev-secret' })).hashKey.equals(keys.hashKey)).toBe(true);
  });

  it('production requires explicit keys; partial or malformed configuration is refused', () => {
    expect(() => loadPushRegistrationKeys(config({ NODE_ENV: 'production', JWT_SECRET: 's' }))).toThrow('required when NODE_ENV=production');
    expect(() => loadPushRegistrationKeys(config({ PUSH_REGISTRATION_KEYS: `k1:${key()}`, JWT_SECRET: 's' }))).toThrow('both');
    expect(() => loadPushRegistrationKeys(config({ PUSH_REGISTRATION_KEYS: 'k1:short', PUSH_REGISTRATION_HASH_KEY: key() }))).toThrow('32 bytes');
    expect(() => loadPushRegistrationKeys(config({ PUSH_REGISTRATION_KEYS: `bad id:${key()}`, PUSH_REGISTRATION_HASH_KEY: key() }))).toThrow('<keyId>:<base64 key>');
    expect(() => loadPushRegistrationKeys(config({ PUSH_REGISTRATION_KEYS: `k1:${key()},k1:${key()}`, PUSH_REGISTRATION_HASH_KEY: key() }))).toThrow('duplicate');
    expect(() => loadPushRegistrationKeys(config({ PUSH_REGISTRATION_KEYS: `k1:${key()}`, PUSH_REGISTRATION_HASH_KEY: 'c2hvcnQ=' }))).toThrow('PUSH_REGISTRATION_HASH_KEY');
  });

  it('AES-256-GCM round trip; random IV (same value -> different ciphertext); the value never appears', () => {
    const keys = loadPushRegistrationKeys(config({ PUSH_REGISTRATION_KEYS: `k1:${key()}`, PUSH_REGISTRATION_HASH_KEY: key(), NODE_ENV: 'production' }));
    const a = encryptRegistration(keys, FID);
    const b = encryptRegistration(keys, FID);
    expect(a).toMatch(/^v1:k1:/);
    expect(a).not.toBe(b);
    expect(a).not.toContain(FID);
    expect(decryptRegistration(keys, a)).toBe(FID);
  });

  it('tampering is detected (GCM tag)', () => {
    const keys = loadPushRegistrationKeys(config({ JWT_SECRET: 's' }));
    const parts = encryptRegistration(keys, FID).split(':');
    parts[3] = parts[3].replace(/^./, (c) => (c === 'A' ? 'B' : 'A'));
    expect(() => decryptRegistration(keys, parts.join(':'))).toThrow();
  });

  it('key rotation: the first key encrypts, older keys still decrypt; unknown key ids fail', () => {
    const [k1, k2, h] = [key(), key(), key()];
    const old = loadPushRegistrationKeys(config({ PUSH_REGISTRATION_KEYS: `k1:${k1}`, PUSH_REGISTRATION_HASH_KEY: h }));
    const rotated = loadPushRegistrationKeys(config({ PUSH_REGISTRATION_KEYS: `k2:${k2},k1:${k1}`, PUSH_REGISTRATION_HASH_KEY: h }));
    const before = encryptRegistration(old, TOKEN);
    expect(decryptRegistration(rotated, before)).toBe(TOKEN);
    expect(encryptRegistration(rotated, TOKEN)).toMatch(/^v1:k2:/);
    expect(hashRegistration(old, 'FCM_TOKEN', TOKEN)).toBe(hashRegistration(rotated, 'FCM_TOKEN', TOKEN));
    const other = loadPushRegistrationKeys(config({ PUSH_REGISTRATION_KEYS: `k3:${key()}`, PUSH_REGISTRATION_HASH_KEY: h }));
    expect(() => decryptRegistration(other, before)).toThrow('unknown key id');
  });

  it('hash: HMAC per kind (the same string as FID and as token are different identities); log reference is a prefix only', () => {
    const keys = loadPushRegistrationKeys(config({ JWT_SECRET: 's' }));
    const fid = hashRegistration(keys, 'FID', FID);
    expect(fid).toMatch(/^[0-9a-f]{64}$/);
    expect(hashRegistration(keys, 'FCM_TOKEN', FID)).not.toBe(fid);
    expect(registrationRef(fid)).toBe(`reg#${fid.slice(0, 8)}`);
  });
});

describe('RegisterPushDeviceDto (production ValidationPipe)', () => {
  const pipe = new ValidationPipe(GLOBAL_VALIDATION_PIPE_OPTIONS);
  const validate = (body: unknown) => pipe.transform(body, { type: 'body', metatype: RegisterPushDeviceDto });

  it('accepts an FID and a legacy token with their own formats', async () => {
    await expect(validate({ registrationKind: 'FID', registrationValue: FID, platform: 'WEB' })).resolves.toBeInstanceOf(RegisterPushDeviceDto);
    await expect(validate({ registrationKind: 'FCM_TOKEN', registrationValue: TOKEN, platform: 'ANDROID' })).resolves.toBeDefined();
  });

  it.each([
    ['unknown kind', { registrationKind: 'APNS', registrationValue: FID, platform: 'WEB' }],
    ['unknown platform', { registrationKind: 'FID', registrationValue: FID, platform: 'DESKTOP' }],
    ['token passed as FID', { registrationKind: 'FID', registrationValue: TOKEN, platform: 'WEB' }],
    ['FID passed as token', { registrationKind: 'FCM_TOKEN', registrationValue: FID, platform: 'WEB' }],
    ['FID too short', { registrationKind: 'FID', registrationValue: 'abc', platform: 'WEB' }],
    ['FID with illegal characters', { registrationKind: 'FID', registrationValue: 'cVxq3f8mT0uYhL2s9pQ1z/', platform: 'WEB' }],
    ['oversized', { registrationKind: 'FCM_TOKEN', registrationValue: 'a'.repeat(4097), platform: 'WEB' }],
    ['not a string', { registrationKind: 'FID', registrationValue: 1234567890123456, platform: 'WEB' }],
    ['missing value', { registrationKind: 'FID', platform: 'WEB' }],
    ['client-supplied userId', { registrationKind: 'FID', registrationValue: FID, platform: 'WEB', userId: '2' }],
    ['client-supplied sessionId', { registrationKind: 'FID', registrationValue: FID, platform: 'WEB', sessionId: '00000000-0000-4000-8000-000000000001' }],
  ])('rejects %s', async (_label, body) => {
    await expect(validate(body)).rejects.toBeInstanceOf(BadRequestException);
  });
});

describe('PushDevicesController / service guards (P3-BE05)', () => {
  it('passes the authenticated principal (with its session) to the service, never client ids', async () => {
    const service = { register: jest.fn().mockResolvedValue('r'), list: jest.fn().mockResolvedValue([]), revoke: jest.fn().mockResolvedValue(undefined) };
    const c = new PushDevicesController(service as unknown as PushDevicesService);
    const me = { id: '7', sessionId: 's-7' } as AuthenticatedUser;
    const dto = { registrationKind: 'FID', registrationValue: FID, platform: 'WEB' } as RegisterPushDeviceDto;
    await c.register(me, dto);
    await c.list(me);
    await c.revoke(me, '5');
    expect(service.register).toHaveBeenCalledWith(me, dto);
    expect(service.list).toHaveBeenCalledWith(me);
    expect(service.revoke).toHaveBeenCalledWith(me, '5');
  });

  it('register without a session-bound principal -> 401 before any SQL', async () => {
    const query = jest.fn();
    const svc = new PushDevicesService({ query, transaction: query } as unknown as DataSource, config({ JWT_SECRET: 's' }));
    await expect(svc.register({ id: '7' } as AuthenticatedUser, { registrationKind: 'FID', registrationValue: FID, platform: 'WEB' })).rejects.toThrow('Unauthorized');
    expect(query).not.toHaveBeenCalled();
  });

  it('PUSH_DEVICE_STALE_DAYS is validated (1..365, default 30)', () => {
    const ds = {} as DataSource;
    expect(new PushDevicesService(ds, config({ JWT_SECRET: 's' })).staleDays).toBe(30);
    expect(new PushDevicesService(ds, config({ JWT_SECRET: 's', PUSH_DEVICE_STALE_DAYS: '7' })).staleDays).toBe(7);
    for (const bad of ['0', '400', 'x']) expect(() => new PushDevicesService(ds, config({ JWT_SECRET: 's', PUSH_DEVICE_STALE_DAYS: bad }))).toThrow('PUSH_DEVICE_STALE_DAYS');
  });
});
