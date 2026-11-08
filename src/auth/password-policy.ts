/**
 * Password policy shared by registration, password change and reset
 * (P3-BE02 reuses the existing P1 rule unchanged): 8–72 characters, no
 * composition rules. 72 is bcrypt's input limit. Hashing: bcrypt, cost 12.
 */
export const PASSWORD_MIN_LENGTH = 8;
export const PASSWORD_MAX_LENGTH = 72;
export const BCRYPT_ROUNDS = 12;
