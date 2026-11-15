import { randomBytes, randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { ErrorCode, type GameView, type Json, type JoinResponse, type PlayerId } from '@gs/sdk';
import { findPlayerByKey, issueKey } from './auth.ts';
import { GameError } from './errors.ts';
import { assertJson } from './json.ts';
import { GameLocks, type GameTransaction } from './locks.ts';
import type { GameRecord, LobbyRecord, MoveRecord, PlayerRecord, StartedRecord } from './record.ts';
import type { AnyGameDefinition, GameRegistry } from './registry.ts';
import { MemoryStore, type GameStore } from './store.ts';

export type GameManagerOptions = {
  registry: GameRegistry;
  store?: GameStore;
  /** Injectable clock for tests. */
  now?: () => Date;
  /** Receives errors from background work (deadline timers). Default: console.error. */
  onError?: (error: unknown) => void;
};

export type MoveOptions = {
  /** Reject with CONFLICT unless the game is at exactly this version. Don't use for simultaneous-move games. */
  expectedVersion?: number;
};

type Loaded = { record: GameRecord; definition: AnyGameDefinition };
type CommitOptions = { bumpVersion?: boolean };
type Transaction = GameTransaction<Loaded, GameRecord, CommitOptions>;

const MAX_NAME_LENGTH = 40;
/** setTimeout's ceiling (~24.8 days). Longer deadlines are re-checked when this fires. */
const MAX_TIMER_MS = 2 ** 31 - 1;

/**
 * Transport-agnostic game orchestration: lifecycle, auth, turn enforcement,
 * serialization, and change notification. Knows nothing about any specific game.
 */
export class GameManager {
  readonly #registry: GameRegistry;
  readonly #store: GameStore;
  readonly #now: () => Date;
  readonly #events = new EventEmitter();
  readonly #locks: GameLocks<Loaded, GameRecord, CommitOptions>;
  readonly #timers = new Map<string, NodeJS.Timeout>();
  readonly #onError: (error: unknown) => void;

  constructor({ registry, store = new MemoryStore(), now = () => new Date(), onError = console.error }: GameManagerOptions) {
    this.#registry = registry;
    this.#store = store;
    this.#now = now;
    this.#onError = onError;
    this.#events.setMaxListeners(0);
    this.#locks = new GameLocks({
      load: (gameId) => this.#load(gameId),
      commit: (record, options) => this.#commit(record, options),
    });
  }

  /**
   * Re-arm deadline timers for every active game in the store. Call once at startup when
   * using a store that already holds games (e.g. restored from a snapshot).
   */
  async restoreTimers(): Promise<void> {
    for (const record of await this.#store.list()) {
      const definition = this.#registry.get(record.type);
      if (definition) this.#schedule(definition, record);
    }
  }

  /** Cancel all pending deadline timers (e.g. on shutdown). */
  close(): void {
    for (const timer of this.#timers.values()) clearTimeout(timer);
    this.#timers.clear();
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
    if (!definition) throw new GameError(ErrorCode.INVALID_REQUEST, `Unknown game type "${type}"`);

    const parsed = definition.parseConfig(config);
    if (!parsed.ok) throw new GameError(ErrorCode.INVALID_REQUEST, `Invalid config: ${parsed.error}`);
    const parsedConfig = parsed.value;
    assertJson(parsedConfig, `$config(${type}.parseConfig)`);

    const timestamp = this.#now().toISOString();
    const record: LobbyRecord = {
      id: randomUUID(),
      type,
      status: 'lobby',
      version: 0,
      config: parsedConfig,
      seed: randomBytes(16).toString('hex'),
      players: [],
      outcome: null,
      moves: [],
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    // The one write outside a transaction: the id is fresh and nobody has seen it yet, so no
    // other operation can be racing on this game. A lobby has no deadline to schedule and no
    // subscribers to notify, so a bare put is all #commit would do anyway.
    await this.#store.put(record);
    return this.#toView(definition, record, null);
  }

  /** Join a game in its lobby. Returns the player's key — the only time it is ever revealed. */
  async join(gameId: string, name: unknown): Promise<JoinResponse> {
    if (typeof name !== 'string' || !name.trim() || name.trim().length > MAX_NAME_LENGTH) {
      throw new GameError(ErrorCode.INVALID_REQUEST, `Name must be a non-empty string of at most ${MAX_NAME_LENGTH} characters`);
    }
    return this.#withLock(gameId, async (tx) => {
      const { record, definition } = await tx.load();
      if (record.status !== 'lobby') throw new GameError(ErrorCode.CONFLICT, 'Game has already started');
      if (record.players.length >= definition.maxPlayers) throw new GameError(ErrorCode.CONFLICT, 'Game is full');

      const { key, keyHash } = issueKey();
      const player: PlayerRecord = { id: `p${record.players.length + 1}`, name: name.trim(), keyHash };
      record.players.push(player);
      const next = record.players.length === definition.maxPlayers ? this.#start(definition, record) : record;

      await tx.commit(next);
      return { playerId: player.id, key, game: this.#toView(definition, next, player.id) };
    });
  }

  /** Start a game early (once minPlayers have joined). Any joined player may start it. */
  async start(gameId: string, key: string | undefined): Promise<GameView> {
    return this.#withLock(gameId, async (tx) => {
      const { record, definition } = await tx.load();
      const player = this.#authenticate(record, key);
      if (record.status !== 'lobby') throw new GameError(ErrorCode.CONFLICT, 'Game has already started');
      if (record.players.length < definition.minPlayers) {
        throw new GameError(ErrorCode.CONFLICT, `Need at least ${definition.minPlayers} players to start`);
      }
      const started = this.#start(definition, record);
      await tx.commit(started);
      return this.#toView(definition, started, player.id);
    });
  }

  async move(gameId: string, key: string | undefined, move: unknown, options: MoveOptions = {}): Promise<GameView> {
    return this.#withLock(gameId, async (tx) => {
      const { record, definition } = await tx.load();
      const player = this.#authenticate(record, key);
      if (record.status === 'lobby') throw new GameError(ErrorCode.CONFLICT, 'Game has not started');
      if (record.status === 'finished') throw new GameError(ErrorCode.CONFLICT, 'Game is finished');
      if (options.expectedVersion !== undefined && options.expectedVersion !== record.version) {
        throw new GameError(ErrorCode.CONFLICT, `Expected version ${options.expectedVersion} but game is at ${record.version}`);
      }

      const { state } = record; // narrowed to a started record by the status checks above
      if (!definition.activePlayers(state).includes(player.id)) {
        throw new GameError(ErrorCode.NOT_YOUR_TURN, 'It is not your turn');
      }

      let moveJson: Json;
      try {
        assertJson(move, '$move');
        moveJson = move;
      } catch (error) {
        throw new GameError(ErrorCode.INVALID_MOVE, (error as Error).message);
      }

      const parsed = definition.parseMove(moveJson, state, player.id);
      if (!parsed.ok) throw new GameError(ErrorCode.INVALID_MOVE, parsed.error);

      const result = definition.applyMove(state, parsed.value, player.id, { now: this.#now().getTime() });
      if (!result.ok) throw new GameError(ErrorCode.INVALID_MOVE, result.error);

      await this.#transition(tx, definition, record, result.value, { kind: 'move', player: player.id, move: moveJson });
      return this.#toView(definition, record, player.id);
    });
  }

  /** Apply a new game state: validate, log, update outcome, persist, notify. */
  async #transition(
    tx: Transaction,
    definition: AnyGameDefinition,
    record: StartedRecord,
    next: unknown,
    entry: Pick<MoveRecord, 'kind' | 'player' | 'move'>,
  ): Promise<void> {
    assertJson(next, `$state(${record.type}.${entry.kind === 'move' ? 'applyMove' : 'onDeadline'})`);
    record.state = next;
    record.version += 1;
    record.moves.push({ ...entry, version: record.version, at: this.#now().toISOString() });
    record.outcome = definition.outcome(next);
    if (record.outcome) record.status = 'finished';
    await tx.commit(record, { bumpVersion: false });
  }

  /** (Re)arm the timer for a game's current deadline, if it has one. */
  #schedule(definition: AnyGameDefinition, record: GameRecord): void {
    clearTimeout(this.#timers.get(record.id));
    this.#timers.delete(record.id);
    if (record.status !== 'active' || !definition.deadline) return;
    const at = definition.deadline(record.state);
    if (at === null) return;

    const delay = Math.min(Math.max(0, at - this.#now().getTime()), MAX_TIMER_MS);
    const timer = setTimeout(() => {
      this.#timers.delete(record.id);
      this.#fireDeadline(record.id).catch(this.#onError);
    }, delay);
    timer.unref();
    this.#timers.set(record.id, timer);
  }

  async #fireDeadline(gameId: string): Promise<void> {
    await this.#withLock(gameId, async (tx) => {
      const { record, definition } = await tx.load();
      if (record.status !== 'active' || !definition.deadline || !definition.onDeadline) return;

      // State may have changed since the timer was armed; only act if the deadline really has passed.
      const at = definition.deadline(record.state);
      const now = this.#now().getTime();
      if (at === null) return;
      if (at > now) return this.#schedule(definition, record);

      const next = definition.onDeadline(record.state, { now });
      // Guard against a game bug that would otherwise re-fire this timer in a tight loop.
      assertJson(next, `$state(${record.type}.onDeadline)`);
      const nextAt = definition.outcome(next) ? null : definition.deadline(next);
      if (nextAt !== null && nextAt <= at) {
        throw new Error(`${record.type}.onDeadline did not move the deadline forward (game ${gameId}); state left unchanged`);
      }
      await this.#transition(tx, definition, record, next, { kind: 'deadline', player: null, move: null });
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

  /** Run setup and turn a lobby record into a started one. */
  #start(definition: AnyGameDefinition, record: LobbyRecord): StartedRecord {
    const state = definition.setup({
      players: record.players.map((p) => p.id),
      config: record.config,
      seed: record.seed,
      now: this.#now().getTime(),
    });
    assertJson(state, `$state(${record.type}.setup)`);
    const outcome = definition.outcome(state);
    return { ...record, status: outcome ? 'finished' : 'active', state, outcome };
  }

  async #load(gameId: string): Promise<Loaded> {
    const record = await this.#store.get(gameId);
    if (!record) throw new GameError(ErrorCode.NOT_FOUND, 'Game not found');
    const definition = this.#registry.get(record.type);
    if (!definition) throw new GameError(ErrorCode.INTERNAL, `Game type "${record.type}" is no longer registered`);
    return { record, definition };
  }

  #authenticate(record: GameRecord, key: string | undefined): PlayerRecord {
    const player = findPlayerByKey(record.players, key);
    if (!player) throw new GameError(ErrorCode.UNAUTHORIZED, 'Missing or invalid player key for this game');
    return player;
  }

  /** Persist, re-arm the deadline timer and notify. Only reachable through a transaction (see #withLock). */
  async #commit(record: GameRecord, { bumpVersion = true }: CommitOptions = {}): Promise<void> {
    // The record came from #load inside the same transaction, so its type is registered.
    const definition = this.#registry.get(record.type);
    if (!definition) throw new GameError(ErrorCode.INTERNAL, `Game type "${record.type}" is no longer registered`);
    if (bumpVersion) record.version += 1;
    record.updatedAt = this.#now().toISOString();
    await this.#store.put(record);
    this.#schedule(definition, record);
    this.#events.emit(`change:${record.id}`, record.version);
  }

  #toView(definition: AnyGameDefinition, record: GameRecord, viewer: PlayerId | null): GameView {
    const base = {
      id: record.id,
      type: record.type,
      version: record.version,
      players: record.players.map(({ id, name }) => ({ id, name })),
      outcome: record.outcome,
      you: viewer,
    };
    if (record.status === 'lobby') return { ...base, status: 'lobby', activePlayers: [], deadline: null };

    const { state } = record;
    return {
      ...base,
      status: record.status,
      activePlayers: record.status === 'active' ? definition.activePlayers(state) : [],
      deadline: record.status === 'active' && definition.deadline ? definition.deadline(state) : null,
      state: definition.view ? definition.view(state, viewer) : state,
    };
  }

  /**
   * Run operations on the same game one at a time (needed once the store is truly async).
   * `fn` gets the only handle that can commit a record of this game; it stops working once `fn` settles.
   */
  #withLock<T>(gameId: string, fn: (tx: Transaction) => Promise<T>): Promise<T> {
    return this.#locks.run(gameId, fn);
  }
}
