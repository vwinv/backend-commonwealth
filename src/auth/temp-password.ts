import { randomBytes } from 'node:crypto';

const CHARS = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKMNPQRSTUVWXYZ23456789';

/** Mot de passe provisoire lisible (sans caractères ambigus). */
export function generateTempPassword(length = 12): string {
  const bytes = randomBytes(length);
  let s = '';
  for (let i = 0; i < length; i++) s += CHARS[bytes[i]! % CHARS.length]!;
  return s;
}
