import { randomBytes, randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import type { GameView, Json, JoinResponse, PlayerId } from '@gs/sdk';
import { findPlayerByKey, issueKey } from './auth.ts';
import { GameError } from './errors.ts';
import { assertJson } from './json.ts';
import type { GameRecord, PlayerRecord } from './record.ts';
import type { AnyGameDefinition, GameRegistry } from './registry.ts';
import { MemoryStore, type GameStore } from './store.ts';

export type GameManagerOptions = {
  registry: GameRegistry;
  store?: GameStore;
  /** Injectable clock for tests. */
  now?: () => Date;
};

export type MoveOptions = {
  /** Reject with CONFLICT unless the game is at exactly this version. Don't use for simultaneous-move games. */
  expectedVersion?: number;
};

const MAX_NAME_LENGTH = 40;

/**
 * Transport-agnostic game orchestration: lifecycle, auth, turn enforcement,
 * serialization, and change notification. Knows nothing about any specific game.
 */
export class GameManager {
  readonly #registry: GameRegistry;
  readonly #store: GameStore;
  readonly #now: () => Date;
  readonly #events = new EventEmitter();
  readonly #locks = new Map<string, Promise<unknown>>();

  constructor({ registry, store = new MemoryStore(), now = () => new Date() }: GameManagerOptions) {
    this.#registry = registry;
    this.#store = store;
    this.#now = now;
    this.#events.setMaxListeners(0);
  }

  get registry(): GameRegistry {
    return this.#registry;
  }

  /** Subscribe to changes of one game. Returns an unsubscribe function. */
  onChange(gameId: string, listener: (version: number) => void): () => void {
    const event = `change:${gameId}`;
    this.#events.on(event, listener);
    return () => this.#events.off(event, listener);
  }

  async create(type: string, config?: unknown): Promise<GameView> {
    const definition = this.#registry.get(type);
    if (!definition) throw new GameError('INVALID_REQUEST', `Unknown game type "${type}"`);

    let parsedConfig: Json = (config ?? null) as Json;
    if (definition.parseConfig) {
      const result = definition.parseConfig(config);
      if (!result.ok) throw new GameError('INVALID_REQUEST', `Invalid config: ${result.error}`);
      parsedConfig = result.value;
    }
    assertJson(parsedConfig, '$config');

    const timestamp = this.#now().toISOString();
    const record: GameRecord = {
      id: randomUUID(),
      type,
      status: 'lobby',
      version: 0,
      config: parsedConfig,
      seed: randomBytes(16).toString('hex'),
      players: [],
      state: null,
      outcome: null,
      moves: [],
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    await this.#store.put(record);
    return this.#toView(definition, record, null);
  }

  /** Join a game in its lobby. Returns the player's key — the only time it is ever revealed. */
  async join(gameId: string, name: unknown): Promise<JoinResponse> {
    if (typeof name !== 'string' || !name.trim() || name.trim().length > MAX_NAME_LENGTH) {
      throw new GameError('INVALID_REQUEST', `Name must be a non-empty string of at most ${MAX_NAME_LENGTH} characters`);
    }
    return this.#withLock(gameId, async () => {
      const { record, definition } = await this.#load(gameId);
      if (record.status !== 'lobby') throw new GameError('CONFLICT', 'Game has already started');
      if (record.players.length >= definition.maxPlayers) throw new GameError('CONFLICT', 'Game is full');

      const { key, keyHash } = issueKey();
      const player: PlayerRecord = { id: `p${record.players.length + 1}`, name: name.trim(), keyHash };
      record.players.push(player);
      if (record.players.length === definition.maxPlayers) this.#start(definition, record);

      await this.#commit(record);
      return { playerId: player.id, key, game: this.#toView(definition, record, player.id) };
    });
  }

  /** Start a game early (once minPlayers have joined). Any joined player may start it. */
  async start(gameId: string, key: string | undefined): Promise<GameView> {
    return this.#withLock(gameId, async () => {
      const { record, definition } = await this.#load(gameId);
      const player = this.#authenticate(record, key);
      if (record.status !== 'lobby') throw new GameError('CONFLICT', 'Game has already started');
      if (record.players.length < definition.minPlayers) {
        throw new GameError('CONFLICT', `Need at least ${definition.minPlayers} players to start`);
      }
      this.#start(definition, record);
      await this.#commit(record);
      return this.#toView(definition, record, player.id);
    });
  }

  async move(gameId: string, key: string | undefined, move: unknown, options: MoveOptions = {}): Promise<GameView> {
    return this.#withLock(gameId, async () => {
      const { record, definition } = await this.#load(gameId);
      const player = this.#authenticate(record, key);
      if (record.status === 'lobby') throw new GameError('CONFLICT', 'Game has not started');
      if (record.status === 'finished') throw new GameError('CONFLICT', 'Game is finished');
      if (options.expectedVersion !== undefined && options.expectedVersion !== record.version) {
        throw new GameError('CONFLICT', `Expected version ${options.expectedVersion} but game is at ${record.version}`);
      }

      const state = record.state as Json;
      if (!definition.activePlayers(state).includes(player.id)) {
        throw new GameError('NOT_YOUR_TURN', 'It is not your turn');
      }

      let moveJson: Json;
      try {
        assertJson(move, '$move');
        moveJson = move;
      } catch (error) {
        throw new GameError('INVALID_MOVE', (error as Error).message);
      }

      const result = definition.applyMove(state, moveJson, player.id);
      if (!result.ok) throw new GameError('INVALID_MOVE', result.error);
      assertJson(result.value, `$state(${record.type}.applyMove)`);

      record.state = result.value;
      record.version += 1;
      record.moves.push({ player: player.id, move: moveJson, version: record.version, at: this.#now().toISOString() });
      record.outcome = definition.outcome(record.state);
      if (record.outcome) record.status = 'finished';

      await this.#commit(record, { bumpVersion: false });
      return this.#toView(definition, record, player.id);
    });
  }

  /**
   * Get a game as seen by the holder of `key`, or as a spectator if no key is given.
   * A key that doesn't belong to this game is rejected rather than silently downgraded.
   */
  async get(gameId: string, key?: string): Promise<GameView> {
    const { record, definition } = await this.#load(gameId);
    const viewer = key === undefined ? null : this.#authenticate(record, key).id;
    return this.#toView(definition, record, viewer);
  }

  // -------------------------------------------------------------------------

  #start(definition: AnyGameDefinition, record: GameRecord): void {
    const state = definition.setup({
      players: record.players.map((p) => p.id),
      config: record.config,
      seed: record.seed,
    });
    assertJson(state, `$state(${record.type}.setup)`);
    record.state = state;
    record.status = 'active';
    record.outcome = definition.outcome(state);
    if (record.outcome) record.status = 'finished';
  }

  async #load(gameId: string): Promise<{ record: GameRecord; definition: AnyGameDefinition }> {
    const record = await this.#store.get(gameId);
    if (!record) throw new GameError('NOT_FOUND', 'Game not found');
    const definition = this.#registry.get(record.type);
    if (!definition) throw new GameError('INTERNAL', `Game type "${record.type}" is no longer registered`);
    return { record, definition };
  }

  #authenticate(record: GameRecord, key: string | undefined): PlayerRecord {
    const player = findPlayerByKey(record.players, key);
    if (!player) throw new GameError('UNAUTHORIZED', 'Missing or invalid player key for this game');
    return player;
  }

  async #commit(record: GameRecord, { bumpVersion = true } = {}): Promise<void> {
    if (bumpVersion) record.version += 1;
    record.updatedAt = this.#now().toISOString();
    await this.#store.put(record);
    this.#events.emit(`change:${record.id}`, record.version);
  }

  #toView(definition: AnyGameDefinition, record: GameRecord, viewer: PlayerId | null): GameView {
    const state = record.state;
    return {
      id: record.id,
      type: record.type,
      status: record.status,
      version: record.version,
      players: record.players.map(({ id, name }) => ({ id, name })),
      activePlayers: record.status === 'active' && state !== null ? definition.activePlayers(state) : [],
      outcome: record.outcome,
      state: state === null ? null : definition.view ? definition.view(state, viewer) : state,
      you: viewer,
    };
  }

  /** Run operations on the same game one at a time (needed once the store is truly async). */
  async #withLock<T>(gameId: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.#locks.get(gameId) ?? Promise.resolve();
    const run = previous.then(fn);
    const tail = run.catch(() => {});
    this.#locks.set(gameId, tail);
    try {
      return await run;
    } finally {
      if (this.#locks.get(gameId) === tail) this.#locks.delete(gameId);
    }
  }
}
