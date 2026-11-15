import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { defineGame, err, ErrorCode, noConfig, ok, type GameView } from '@gs/sdk';
import { GameError, GameManager, GameRegistry, MemoryStore } from '../src/index.ts';
import { GameLocks, type GameTransaction } from '../src/core/locks.ts';
import { counterGame, secretPickGame, type CounterState, type SecretPickState } from './fixtures/games.ts';

function setup() {
  const registry = new GameRegistry().register(counterGame).register(secretPickGame);
  const store = new MemoryStore();
  return { manager: new GameManager({ registry, store }), store, registry };
}

/** The state of a started game; fails the test if the game is still in the lobby. */
function stateOf<TState = unknown>(view: GameView): TState {
  assert.ok(view.status !== 'lobby', `expected a started game, got status ${view.status}`);
  return view.state as TState;
}

async function rejects(promise: Promise<unknown>, code: ErrorCode) {
  await assert.rejects(promise, (error: unknown) => error instanceof GameError && error.code === code);
}

describe('GameRegistry', () => {
  it('rejects duplicate types and bad player counts', () => {
    const registry = new GameRegistry().register(counterGame);
    assert.throws(() => registry.register(counterGame), /already registered/);
    assert.throws(() => registry.register({ ...counterGame, type: 'bad', minPlayers: 3, maxPlayers: 2 }), /invalid player counts/);
  });
});

describe('GameLocks', () => {
  type Rec = { id: string; n: number };
  function locks() {
    const committed: Rec[] = [];
    const gameLocks = new GameLocks<Rec, Rec, undefined>({
      ids: async () => [],
      load: async (id) => ({ id, n: 0 }),
      commit: async (record) => {
        committed.push(record);
      },
    });
    return { gameLocks, committed };
  }

  it('commits through a tx while the lock is held', async () => {
    const { gameLocks, committed } = locks();
    await gameLocks.write('g1', async (tx) => {
      const record = await tx.load();
      await tx.commit({ ...record, n: 1 });
    });
    assert.deepEqual(committed, [{ id: 'g1', n: 1 }]);
  });

  it('a tx used after its lock was released throws', async () => {
    const { gameLocks, committed } = locks();
    let leaked: GameTransaction<Rec, Rec, undefined> | undefined;
    await gameLocks.write('g1', async (tx) => {
      leaked = tx;
    });
    assert.ok(leaked);
    await assert.rejects(leaked.commit({ id: 'g1', n: 1 }), /after its lock was released/);

    // Also when the operation failed, and even while a later operation holds the same game's lock.
    await assert.rejects(
      gameLocks.write('g1', async (tx) => {
        leaked = tx;
        throw new Error('boom');
      }),
      /boom/,
    );
    await gameLocks.write('g1', async () => {
      await assert.rejects(leaked!.commit({ id: 'g1', n: 2 }), /after its lock was released/);
    });
    assert.deepEqual(committed, []);
  });

  it("a tx can't commit a different game's record", async () => {
    const { gameLocks, committed } = locks();
    await gameLocks.write('g1', async (tx) => {
      await assert.rejects(tx.commit({ id: 'g2', n: 1 }), /cannot commit game g2/);
    });
    assert.deepEqual(committed, []);
  });

  it('a read waits for an earlier write and sees its result', async () => {
    let stored: Rec = { id: 'g1', n: 0 };
    const gameLocks = new GameLocks<Rec, Rec, undefined>({
      ids: async () => [],
      load: async () => ({ ...stored }),
      commit: async (record) => {
        await new Promise((resolve) => setTimeout(resolve, 10)); // a slow store
        stored = { ...record };
      },
    });
    const write = gameLocks.write('g1', async (tx) => tx.commit({ ...(await tx.load()), n: 1 }));
    const read = gameLocks.read('g1', (reader) => reader.load());
    await write;
    assert.deepEqual(await read, { id: 'g1', n: 1 });
  });

  it('reads queued together run at the same time', async () => {
    const { gameLocks } = locks();
    let running = 0;
    let most = 0;
    const read = () =>
      gameLocks.read('g1', async () => {
        most = Math.max(most, ++running);
        await new Promise((resolve) => setTimeout(resolve, 5));
        running--;
      });
    await Promise.all([read(), read(), read()]);
    assert.equal(most, 3);
  });

  it('a write waits for earlier reads, and later reads wait for it', async () => {
    const { gameLocks } = locks();
    const order: string[] = [];
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => (release = resolve));
    const first = gameLocks.read('g1', async () => {
      await blocked;
      order.push('read 1');
    });
    const write = gameLocks.write('g1', async () => {
      order.push('write');
    });
    const second = gameLocks.read('g1', async () => {
      order.push('read 2');
    });
    release();
    await Promise.all([first, write, second]);
    assert.deepEqual(order, ['read 1', 'write', 'read 2']);
  });

  it('a failed read or write still releases the lock', async () => {
    const { gameLocks, committed } = locks();
    await assert.rejects(gameLocks.read('g1', async () => { throw new Error('read failed'); }), /read failed/);
    await assert.rejects(gameLocks.write('g1', async () => { throw new Error('write failed'); }), /write failed/);
    await gameLocks.write('g1', async (tx) => tx.commit({ id: 'g1', n: 1 }));
    assert.deepEqual(committed, [{ id: 'g1', n: 1 }]);
  });

  it('runs operations on one game in order, and different games independently', async () => {
    const { gameLocks } = locks();
    const order: string[] = [];
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => (release = resolve));
    const first = gameLocks.write('g1', async () => {
      await blocked;
      order.push('g1:first');
    });
    const second = gameLocks.write('g1', async () => {
      order.push('g1:second');
    });
    await gameLocks.write('g2', async () => {
      order.push('g2');
    });
    release();
    await Promise.all([first, second]);
    assert.deepEqual(order, ['g2', 'g1:first', 'g1:second']);
  });
});

describe('GameManager reads', () => {
  it('get() waits for a move in progress instead of returning the state before it', async () => {
    class SlowStore extends MemoryStore {
      override async put(record: Parameters<MemoryStore['put']>[0]): Promise<void> {
        await new Promise((resolve) => setTimeout(resolve, 20));
        return super.put(record);
      }
    }
    const manager = new GameManager({ registry: new GameRegistry().register(counterGame), store: new SlowStore() });
    const game = await manager.create('counter');
    const ann = await manager.join(game.id, 'Ann');
    await manager.join(game.id, 'Ben');
    await manager.start(game.id, ann.key);

    const move = manager.move(game.id, ann.key, { add: 2 });
    const seen = await manager.get(game.id); // asked while the move is still being written
    assert.equal(stateOf<CounterState>(seen).count, 2);
    assert.equal(seen.version, (await move).version);
  });
});

describe('GameManager lifecycle (sequential game)', () => {
  it('create → join → auto-start when full', async () => {
    const { manager } = setup();
    const game = await manager.create('counter');
    assert.equal(game.status, 'lobby');
    assert.ok(!('state' in game)); // no state until the game starts

    await manager.join(game.id, 'Ann');
    await manager.join(game.id, 'Ben');
    const joined = await manager.join(game.id, 'Cat');
    assert.equal(joined.game.status, 'active');
    assert.deepEqual(joined.game.activePlayers, ['p1']);
    assert.deepEqual(joined.game.players, [
      { id: 'p1', name: 'Ann' },
      { id: 'p2', name: 'Ben' },
      { id: 'p3', name: 'Cat' },
    ]);
    await rejects(manager.join(game.id, 'Dan'), ErrorCode.CONFLICT);
  });

  it('start early once minPlayers have joined; only players can start', async () => {
    const { manager } = setup();
    const game = await manager.create('counter');
    const ann = await manager.join(game.id, 'Ann');
    await rejects(manager.start(game.id, ann.key), ErrorCode.CONFLICT); // not enough players
    await manager.join(game.id, 'Ben');
    await rejects(manager.start(game.id, 'not-a-key'), ErrorCode.UNAUTHORIZED);
    await rejects(manager.start(game.id, undefined), ErrorCode.UNAUTHORIZED);
    const started = await manager.start(game.id, ann.key);
    assert.equal(started.status, 'active');
    await rejects(manager.start(game.id, ann.key), ErrorCode.CONFLICT);
  });

  it('enforces auth, turn order, move validity and finish', async () => {
    const { manager } = setup();
    const game = await manager.create('counter', { target: 4 });
    const ann = await manager.join(game.id, 'Ann');
    const ben = await manager.join(game.id, 'Ben');
    await rejects(manager.move(game.id, ann.key, { add: 1 }), ErrorCode.CONFLICT); // still in lobby
    await manager.start(game.id, ann.key);

    // a key from a different game is useless here
    const other = await manager.create('counter');
    const intruder = await manager.join(other.id, 'Eve');
    await rejects(manager.move(game.id, intruder.key, { add: 1 }), ErrorCode.UNAUTHORIZED);

    await rejects(manager.move(game.id, ben.key, { add: 1 }), ErrorCode.NOT_YOUR_TURN);
    await rejects(manager.move(game.id, ann.key, { add: 7 }), ErrorCode.INVALID_MOVE);

    await manager.move(game.id, ann.key, { add: 3 });
    const end = await manager.move(game.id, ben.key, { add: 1 });
    assert.equal(end.status, 'finished');
    assert.deepEqual(end.outcome, { winners: ['p2'] });
    assert.deepEqual(end.activePlayers, []);
    await rejects(manager.move(game.id, ann.key, { add: 1 }), ErrorCode.CONFLICT);
  });

  it('expectedVersion gives optimistic concurrency', async () => {
    const { manager } = setup();
    const game = await manager.create('counter');
    const ann = await manager.join(game.id, 'Ann');
    await manager.join(game.id, 'Ben');
    const started = await manager.start(game.id, ann.key);
    await rejects(manager.move(game.id, ann.key, { add: 1 }, { expectedVersion: started.version - 1 }), ErrorCode.CONFLICT);
    const moved = await manager.move(game.id, ann.key, { add: 1 }, { expectedVersion: started.version });
    assert.equal(moved.version, started.version + 1);
  });

  it('validates config and player names', async () => {
    const { manager } = setup();
    await rejects(manager.create('nope'), ErrorCode.INVALID_REQUEST);
    await rejects(manager.create('counter', { target: -1 }), ErrorCode.INVALID_REQUEST);
    const game = await manager.create('counter');
    await rejects(manager.join(game.id, ''), ErrorCode.INVALID_REQUEST);
    await rejects(manager.join(game.id, 42), ErrorCode.INVALID_REQUEST);
    await rejects(manager.join(game.id, 'x'.repeat(41)), ErrorCode.INVALID_REQUEST);
    await rejects(manager.get('missing'), ErrorCode.NOT_FOUND);
  });

  it('get() with a foreign key is rejected, not downgraded to spectator', async () => {
    const { manager } = setup();
    const game = await manager.create('counter');
    const ann = await manager.join(game.id, 'Ann');
    assert.equal((await manager.get(game.id, ann.key)).you, 'p1');
    assert.equal((await manager.get(game.id)).you, null);
    await rejects(manager.get(game.id, 'bogus'), ErrorCode.UNAUTHORIZED);
  });

  it('serializes concurrent operations on the same game', async () => {
    const { manager } = setup();
    const game = await manager.create('counter');
    const results = await Promise.allSettled(['A', 'B', 'C', 'D', 'E'].map((n) => manager.join(game.id, n)));
    assert.equal(results.filter((r) => r.status === 'fulfilled').length, 3);
    const view = await manager.get(game.id);
    assert.deepEqual(view.players.map((p) => p.id), ['p1', 'p2', 'p3']);
  });

  it('emits change events per game', async () => {
    const { manager } = setup();
    const game = await manager.create('counter');
    const versions: number[] = [];
    const off = manager.onChange(game.id, (v) => versions.push(v));
    await manager.join(game.id, 'Ann');
    await manager.join(game.id, 'Ben');
    off();
    await manager.join(game.id, 'Cat');
    assert.deepEqual(versions, [1, 2]);
  });
});

describe('parseMove → applyMove', () => {
  it('applyMove only ever sees moves that parseMove accepted', async () => {
    const calls: { parse: unknown[][]; apply: unknown[][] } = { parse: [], apply: [] };
    const echo = defineGame<{ last: string | null }, { word: string }>({
      type: 'echo',
      minPlayers: 1,
      maxPlayers: 1,
      parseConfig: noConfig,
      setup: () => ({ last: null }),
      parseMove(input, state, player) {
        calls.parse.push([input, state, player]);
        const word = (input as { word?: unknown } | null)?.word;
        return typeof word === 'string' ? ok({ word: word.toUpperCase() }) : err('word must be a string');
      },
      applyMove(_state, move, player) {
        calls.apply.push([move, player]);
        return ok({ last: move.word });
      },
      activePlayers: () => ['p1'],
      outcome: () => null,
    });
    const manager = new GameManager({ registry: new GameRegistry().register(echo) });
    await rejects(manager.create('echo', { surprise: true }), ErrorCode.INVALID_REQUEST); // noConfig rejects config
    const game = await manager.create('echo');
    const { key } = await manager.join(game.id, 'Solo');

    await rejects(manager.move(game.id, key, { word: 7 }), ErrorCode.INVALID_MOVE);
    assert.equal(calls.apply.length, 0);

    const view = await manager.move(game.id, key, { word: 'hi' });
    assert.deepEqual(calls.parse.at(-1), [{ word: 'hi' }, { last: null }, 'p1']);
    assert.deepEqual(calls.apply, [[{ word: 'HI' }, 'p1']]); // the parsed value, not the raw input
    assert.deepEqual(stateOf(view), { last: 'HI' });
  });
});

describe('serialization', () => {
  it('records survive a full snapshot/restore and the game continues', async () => {
    const { manager, store, registry } = setup();
    const game = await manager.create('counter');
    const ann = await manager.join(game.id, 'Ann');
    const ben = await manager.join(game.id, 'Ben');
    await manager.start(game.id, ann.key);
    await manager.move(game.id, ann.key, { add: 2 });

    const restored = new GameManager({ registry, store: MemoryStore.fromSnapshot(store.snapshot()) });
    const view = await restored.move(game.id, ben.key, { add: 3 });
    assert.equal(stateOf<CounterState>(view).count, 5);
  });

  it('stores no state for lobby games, and always stores it once started', async () => {
    const { manager, store } = setup();
    const game = await manager.create('counter');
    const ann = await manager.join(game.id, 'Ann');
    await manager.join(game.id, 'Ben');
    const lobby = (await store.get(game.id))!;
    assert.equal(lobby.status, 'lobby');
    assert.ok(!('state' in lobby));

    await manager.start(game.id, ann.key);
    const started = (await store.get(game.id))!;
    assert.equal(started.status, 'active');
    assert.ok(started.state !== null && typeof started.state === 'object');
  });

  it('never stores raw keys', async () => {
    const { manager, store } = setup();
    const game = await manager.create('counter');
    const ann = await manager.join(game.id, 'Ann');
    assert.ok(!store.snapshot().includes(ann.key));
  });

  it('rejects a game that returns non-JSON state', async () => {
    const leaky = defineGame({
      type: 'leaky',
      minPlayers: 1,
      maxPlayers: 1,
      parseConfig: noConfig,
      setup: () => ({ when: new Date() as never }),
      parseMove: () => ok(null),
      applyMove: (s) => ok(s),
      activePlayers: () => [],
      outcome: () => null,
    });
    const manager = new GameManager({ registry: new GameRegistry().register(leaky) });
    const game = await manager.create('leaky');
    await assert.rejects(manager.join(game.id, 'Solo'), /Date object, which is not JSON/);
  });
});

describe('simultaneous moves (secret-pick)', () => {
  async function startSecretPick(rounds = 2) {
    const { manager } = setup();
    const game = await manager.create('secret-pick', { rounds });
    const ann = await manager.join(game.id, 'Ann');
    const ben = await manager.join(game.id, 'Ben');
    await manager.start(game.id, ann.key);
    return { manager, gameId: game.id, ann, ben };
  }

  it('lets every player act, hides pending picks, resolves on last commit', async () => {
    const { manager, gameId, ann, ben } = await startSecretPick();
    assert.deepEqual((await manager.get(gameId)).activePlayers, ['p1', 'p2']);

    const afterAnn = await manager.move(gameId, ann.key, { pick: 7 });
    assert.deepEqual(afterAnn.activePlayers, ['p2']);
    assert.deepEqual(stateOf<SecretPickState>(afterAnn).pending, { p1: 7 }); // Ann sees her own pick

    // Ben and spectators know Ann committed, but not what she picked.
    assert.deepEqual(stateOf<SecretPickState>(await manager.get(gameId, ben.key)).pending, { p1: null });
    assert.deepEqual(stateOf<SecretPickState>(await manager.get(gameId)).pending, { p1: null });

    await rejects(manager.move(gameId, ann.key, { pick: 3 }), ErrorCode.NOT_YOUR_TURN); // no double-submit

    const resolved = await manager.move(gameId, ben.key, { pick: 5 });
    const state = stateOf<SecretPickState>(resolved);
    assert.deepEqual(state.pending, {});
    assert.deepEqual(state.history, [{ p1: 7, p2: 5 }]);
    assert.deepEqual(state.scores, { p1: 1, p2: 0 });
    assert.deepEqual(resolved.activePlayers, ['p1', 'p2']); // next round
    assert.equal(resolved.status, 'active');
  });

  it('finishes after the last round', async () => {
    const { manager, gameId, ann, ben } = await startSecretPick(1);
    await manager.move(gameId, ben.key, { pick: 9 });
    const end = await manager.move(gameId, ann.key, { pick: 2 });
    assert.equal(end.status, 'finished');
    assert.deepEqual(end.outcome, { winners: ['p2'] });
  });

  it('concurrent submissions without expectedVersion both succeed', async () => {
    const { manager, gameId, ann, ben } = await startSecretPick();
    const [a, b] = await Promise.all([
      manager.move(gameId, ann.key, { pick: 4 }),
      manager.move(gameId, ben.key, { pick: 6 }),
    ]);
    assert.ok(a && b);
    assert.deepEqual(stateOf<SecretPickState>(await manager.get(gameId)).history, [{ p1: 4, p2: 6 }]);
  });
});
