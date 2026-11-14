/**
 * P3-BE05 push registration identity contract.
 *
 * - `FID`: Firebase Installation ID delivered by the current web SDK
 *   (`register()` + `onRegistered()`). Default for every new client.
 * - `FCM_TOKEN`: legacy registration token from the deprecated
 *   `getToken()`. Accepted only for clients that cannot use FIDs yet;
 *   P3-BE06 sends it with `token` instead of `fid`.
 *
 * One app installation must never have two active destinations: there is
 * at most ONE active registration per auth session (one login on one
 * browser/app), so a client switching from a token to an FID (or getting a
 * new FID) replaces its previous registration (reason ROTATED).
 *
 * Value formats are not specified by Firebase; the bounds below are
 * defensive (FIDs are short URL-safe strings, tokens are long and may contain
 * ':'), not a format guarantee.
 */
export const REGISTRATION_KINDS = ['FID', 'FCM_TOKEN'] as const;
export type RegistrationKind = (typeof REGISTRATION_KINDS)[number];

export const PUSH_PLATFORMS = ['WEB', 'ANDROID', 'IOS'] as const;
export type PushPlatform = (typeof PUSH_PLATFORMS)[number];

export const REGISTRATION_VALUE_PATTERNS: Record<RegistrationKind, RegExp> = {
  FID: /^[A-Za-z0-9_-]{16,64}$/,
  FCM_TOKEN: /^[A-Za-z0-9_:-]{64,4096}$/,
};
export const REGISTRATION_VALUE_MAX_LENGTH = 4096;

export const PUSH_REVOCATION_REASONS = [
  'USER_REVOKED', // DELETE /push-devices/:id
  'SESSION_REVOKED', // logout, logout-all, session revoke, refresh reuse, suspension, password change/reset (trigger)
  'ROTATED', // the same session registered a new value (new FID, token -> FID)
  'TRANSFERRED', // another session registered the same installation (shared browser / account switch)
  'INVALID_REGISTRATION', // FCM reported UNREGISTERED etc. (P3-BE06)
  'STALE', // not seen for longer than the stale threshold
] as const;
export type PushRevocationReason = (typeof PUSH_REVOCATION_REASONS)[number];

export type RegistrationResult = 'CREATED' | 'REFRESHED' | 'ROTATED' | 'TRANSFERRED';

/** Days without a re-registration after which a device is not send-eligible (FCM's own default staleness is ~1 month). */
export const DEFAULT_PUSH_STALE_DAYS = 30;
