import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { config } from './config.ts';

export class TokenEncryptionKeyError extends Error {}

function keyBytes(): Buffer {
  const key = Buffer.from(config.tokenEncryptionKey, 'base64url');
  if (key.length !== 32 || key.toString('base64url') !== config.tokenEncryptionKey) {
    throw new TokenEncryptionKeyError('CSA_TOKEN_ENCRYPTION_KEY must be a base64url-encoded 32-byte key.');
  }
  return key;
}

export function assertTokenEncryptionKey(): void {
  keyBytes();
}

export function encryptSandboxTrafficToken(token: string): string {
  if (!token) throw new Error('CubeSandbox did not return a data-plane traffic token.');
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', keyBytes(), nonce);
  const ciphertext = Buffer.concat([cipher.update(token, 'utf8'), cipher.final()]);
  return ['v1', nonce.toString('base64url'), cipher.getAuthTag().toString('base64url'), ciphertext.toString('base64url')].join('.');
}

export function decryptSandboxTrafficToken(value: string): string {
  const [version, encodedNonce, encodedTag, encodedCiphertext, extra] = value.split('.');
  if (version !== 'v1' || !encodedNonce || !encodedTag || !encodedCiphertext || extra) {
    throw new Error('Stored CubeSandbox traffic token has an unsupported encrypted format.');
  }
  const nonce = Buffer.from(encodedNonce, 'base64url');
  const tag = Buffer.from(encodedTag, 'base64url');
  const ciphertext = Buffer.from(encodedCiphertext, 'base64url');
  if (nonce.length !== 12 || tag.length !== 16) throw new Error('Stored CubeSandbox traffic token is invalid.');
  const decipher = createDecipheriv('aes-256-gcm', keyBytes(), nonce);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
}
