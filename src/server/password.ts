import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scryptAsync = promisify(scrypt);
const keyLength = 64;

export async function hashPassword(password: string): Promise<string> {
  if (Buffer.byteLength(password, 'utf8') < 10 || Buffer.byteLength(password, 'utf8') > 256) {
    throw new Error('Password must be between 10 and 256 bytes.');
  }
  const salt = randomBytes(16);
  const derived = await scryptAsync(password, salt, keyLength) as Buffer;
  return 'scrypt$' + salt.toString('hex') + '$' + derived.toString('hex');
}

export async function verifyPassword(password: string, encoded: string): Promise<boolean> {
  const [scheme, saltHex, keyHex, extra] = encoded.split('$');
  if (scheme !== 'scrypt' || !saltHex || !keyHex || extra !== undefined || !/^[0-9a-f]{32}$/i.test(saltHex) || !/^[0-9a-f]{128}$/i.test(keyHex)) return false;
  const expected = Buffer.from(keyHex, 'hex');
  const actual = await scryptAsync(password, Buffer.from(saltHex, 'hex'), expected.length) as Buffer;
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
