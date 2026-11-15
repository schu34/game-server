/**
 * A handle to one game, valid only while its lock is held. The only way to commit a record.
 */
export type GameTransaction<TLoaded, TRecord extends { id: string }, TCommitOptions> = {
  load(): Promise<TLoaded>;
  commit(record: TRecord, options?: TCommitOptions): Promise<void>;
};

/** How a transaction reads and writes a game. Supplied once by the owner of the store. */
export type GameLockOps<TLoaded, TRecord extends { id: string }, TCommitOptions> = {
  load(gameId: string): Promise<TLoaded>;
  commit(record: TRecord, options?: TCommitOptions): Promise<void>;
};

/**
 * Per-game mutual exclusion. `run` queues operations on the same game one at a time and hands
 * each a transaction that refuses to commit once the operation has finished, or to commit a
 * record of another game. Committing without holding the lock is therefore impossible, not
 * just a convention.
 */
export class GameLocks<TLoaded, TRecord extends { id: string }, TCommitOptions> {
  readonly #tails = new Map<string, Promise<unknown>>();
  readonly #ops: GameLockOps<TLoaded, TRecord, TCommitOptions>;

  constructor(ops: GameLockOps<TLoaded, TRecord, TCommitOptions>) {
    this.#ops = ops;
  }

  async run<T>(gameId: string, fn: (tx: GameTransaction<TLoaded, TRecord, TCommitOptions>) => Promise<T>): Promise<T> {
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

    const previous = this.#tails.get(gameId) ?? Promise.resolve();
    const run = previous.then(() => fn(tx)).finally(() => {
      open = false;
    });
    const tail = run.catch(() => {});
    this.#tails.set(gameId, tail);
    try {
      return await run;
    } finally {
      if (this.#tails.get(gameId) === tail) this.#tails.delete(gameId);
    }
  }
}
