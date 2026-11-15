import type { GameRecord } from './record.ts';

/**
 * Persistence boundary. Async so a database-backed store can drop in later.
 * The GameManager serializes operations per game, so implementations don't need locking.
 */
export interface GameStore {
  get(id: string): Promise<GameRecord | undefined>;
  put(record: GameRecord): Promise<void>;
  delete(id: string): Promise<boolean>;
  list(): Promise<GameRecord[]>;
}

/**
 * In-memory store that keeps records as JSON strings. Round-tripping through JSON on
 * every read/write enforces serializability by construction and guarantees callers
 * never share mutable references with the stored copy.
 */
export class MemoryStore implements GameStore {
  readonly #data = new Map<string, string>();

  async get(id: string): Promise<GameRecord | undefined> {
    const raw = this.#data.get(id);
    return raw === undefined ? undefined : (JSON.parse(raw) as GameRecord);
  }

  async put(record: GameRecord): Promise<void> {
    this.#data.set(record.id, JSON.stringify(record));
  }

  async delete(id: string): Promise<boolean> {
    return this.#data.delete(id);
  }

  async list(): Promise<GameRecord[]> {
    return [...this.#data.values()].map((raw) => JSON.parse(raw) as GameRecord);
  }

  /** Dump all records, e.g. to save a snapshot before shutdown. */
  snapshot(): string {
    return JSON.stringify([...this.#data.values()].map((raw) => JSON.parse(raw)));
  }

  /** Restore from `snapshot()` output. */
  static fromSnapshot(snapshot: string): MemoryStore {
    const store = new MemoryStore();
    for (const record of JSON.parse(snapshot) as GameRecord[]) {
      store.#data.set(record.id, JSON.stringify(record));
    }
    return store;
  }
}
