import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { PlayerRecord } from './record.ts';

/** Issue a new random player key. Only the hash should be stored. */
export function issueKey(): { key: string; keyHash: string } {
  const key = randomBytes(32).toString('base64url');
  return { key, keyHash: hashKey(key) };
}

export function hashKey(key: string): string {
  return createHash('sha256').update(key).digest('hex');
}

/** Find the player in this game that owns `key`, comparing hashes in constant time. */
export function findPlayerByKey(players: readonly PlayerRecord[], key: string | undefined): PlayerRecord | undefined {
  if (!key) return undefined;
  const candidate = Buffer.from(hashKey(key), 'hex');
  let match: PlayerRecord | undefined;
  for (const player of players) {
    const stored = Buffer.from(player.keyHash, 'hex');
    if (stored.length === candidate.length && timingSafeEqual(stored, candidate)) match = player;
  }
  return match;
}
