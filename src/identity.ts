// Stable identity for a canonical secret: HMAC-SHA256 under a local random key.
// The key lives in the data directory with owner-only permissions. Placeholders are
// derived from the identity, so the same secret gets the same placeholder across restarts.
import { createHmac, randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export function loadIdentityKey(dataDir: string): Buffer {
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const path = join(dataDir, 'identity.key');
  if (!existsSync(path)) writeFileSync(path, randomBytes(32), { mode: 0o600, flag: 'wx' });
  chmodSync(path, 0o600);
  const key = readFileSync(path);
  if (key.length !== 32) throw new Error('identity key file is malformed');
  return key;
}

export function identityOf(key: Buffer, canonical: string): string {
  return createHmac('sha256', key).update(canonical, 'utf8').digest('hex');
}

// Six hex characters by default; longer only when two masked identities in one request collide.
export function placeholderFor(identity: string, length = 6): string {
  return `⟦SECRET_${identity.slice(0, length)}⟧`;
}
