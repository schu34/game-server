/**
 * A handle to one game, valid only while its write lock is held. The only way to commit a record.
 */
export type GameTransaction<TLoaded, TRecord extends { id: string }, TCommitOptions> = {
  load(): Promise<TLoaded>;
  commit(record: TRecord, options?: TCommitOptions): Promise<void>;
};

/** A handle to one game under its read lock. It can load, but never commit. */
export type GameReader<TLoaded> = {
  load(): Promise<TLoaded>;
};

/** How the locks reach the store. Supplied once by its owner, who then holds no other reference. */
export type GameLockOps<TLoaded, TRecord extends { id: string }, TCommitOptions> = {
  /** Every stored game's id. */
  ids(): Promise<string[]>;
  load(gameId: string): Promise<TLoaded>;
  commit(record: TRecord, options?: TCommitOptions): Promise<void>;
};

/** One game's queue: the latest write, the reads queued since it, and how many operations are unfinished. */
type Queue = { write: Promise<void>; reads: Promise<void>[]; pending: number };

/**
 * Per-game read-write locks, granted in arrival order:
 *
 * - A write waits for every earlier read and write on that game, then runs alone.
 * - A read waits for every earlier write, and runs alongside the reads queued with it.
 *   So a read never sees a half-finished transaction, and reads can't starve writes.
 *
 * Only a write gets a transaction that can commit, and it refuses once the write has finished or
 * for another game's record. Committing without holding the write lock is therefore impossible,
 * not just a convention.
 *
 * Never start a read or write on a game from inside a write on the same game and wait for it:
 * it is queued behind the write that is waiting for it, so neither finishes.
 */
export class GameLocks<TLoaded, TRecord extends { id: string }, TCommitOptions> {
  readonly #queues = new Map<string, Queue>();
  readonly #ops: GameLockOps<TLoaded, TRecord, TCommitOptions>;

  constructor(ops: GameLockOps<TLoaded, TRecord, TCommitOptions>) {
    this.#ops = ops;
  }

  /** Every stored game's id. Not locked: take a lock on each game before reading it. */
  ids(): Promise<string[]> {
    return this.#ops.ids();
  }

  /** Run `fn` with exclusive access to the game, and the only handle that can commit it. */
  write<T>(gameId: string, fn: (tx: GameTransaction<TLoaded, TRecord, TCommitOptions>) => Promise<T>): Promise<T> {
    const ops = this.#ops;
    let open = true;
    // Errors here are programming bugs, not client errors, so they are plain Errors.
    const tx: GameTransaction<TLoaded, TRecord, TCommitOptions> = {
      load: () => ops.load(gameId),
      commit: async (record, options) => {
        if (!open) throw new Error(`Transaction for game ${gameId} used after its lock was released`);
        if (record.id !== gameId) throw new Error(`Transaction for game ${gameId} cannot commit game ${record.id}`);
        await ops.commit(record, options);
      },
    };
    return this.#enqueue(gameId, 'write', async () => {
      try {
        return await fn(tx);
      } finally {
        open = false;
      }
    });
  }

  /** Run `fn` once every earlier write on the game has finished, alongside other reads. */
  read<T>(gameId: string, fn: (reader: GameReader<TLoaded>) => Promise<T>): Promise<T> {
    const ops = this.#ops;
    return this.#enqueue(gameId, 'read', () => fn({ load: () => ops.load(gameId) }));
  }

  async #enqueue<T>(gameId: string, mode: 'read' | 'write', task: () => Promise<T>): Promise<T> {
    let queue = this.#queues.get(gameId);
    if (!queue) {
      queue = { write: Promise.resolve(), reads: [], pending: 0 };
      this.#queues.set(gameId, queue);
    }

    const ready = mode === 'write' ? Promise.all([queue.write, ...queue.reads]) : queue.write;
    const run = ready.then(task);
    const settled = run.then(
      () => {},
      () => {}, // a failed operation still releases the lock
    );
    if (mode === 'write') {
      queue.write = settled;
      queue.reads = [];
    } else {
      queue.reads.push(settled);
    }

    queue.pending += 1;
    try {
      return await run;
    } finally {
      // Forget the game once nothing is queued on it, so idle games cost nothing.
      queue.pending -= 1;
      if (queue.pending === 0 && this.#queues.get(gameId) === queue) this.#queues.delete(gameId);
    }
  }
}
