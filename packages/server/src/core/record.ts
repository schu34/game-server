import type { Json, Outcome, PlayerId } from '@gs/sdk';

export type PlayerRecord = {
  id: PlayerId;
  name: string;
  /** sha256 of the player's key. The key itself is never stored. */
  keyHash: string;
};

export type MoveRecord = {
  player: PlayerId;
  move: Json;
  /** Game version after this move was applied. */
  version: number;
  at: string;
};

/**
 * Fields shared by every game record. A full record is the serializable record of one game. This is what a GameStore persists.
 * It contains secrets (key hashes, raw moves, unredacted state) and must never
 * be sent to clients directly — use GameManager views instead.
 */
type GameRecordBase = {
  id: string;
  type: string;
  version: number;
  config: Json;
  seed: string;
  players: PlayerRecord[];
  outcome: Outcome | null;
  /** Internal move log for replay/debugging. Never exposed via the API. */
  moves: MoveRecord[];
  createdAt: string;
  updatedAt: string;
};

/** A game waiting for players. No state until it starts. */
export type LobbyRecord = GameRecordBase & { status: 'lobby' };

/** A game that has started: `state` is the game's full, unredacted state. */
export type StartedRecord = GameRecordBase & { status: 'active' | 'finished'; state: Json };

export type GameRecord = LobbyRecord | StartedRecord;
