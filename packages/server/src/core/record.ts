import type { GameStatus, Json, Outcome, PlayerId } from '@gs/sdk';

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
 * The full, serializable record of one game. This is what a GameStore persists.
 * It contains secrets (key hashes, raw moves, unredacted state) and must never
 * be sent to clients directly — use GameManager views instead.
 */
export type GameRecord = {
  id: string;
  type: string;
  status: GameStatus;
  version: number;
  config: Json;
  seed: string;
  players: PlayerRecord[];
  state: Json | null;
  outcome: Outcome | null;
  /** Internal move log for replay/debugging. Never exposed via the API. */
  moves: MoveRecord[];
  createdAt: string;
  updatedAt: string;
};
