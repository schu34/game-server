import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { defineGame, ok } from '@gs/sdk';
import { GameError, GameManager, GameRegistry, MemoryStore } from '../src/index.ts';
import { counterGame, secretPickGame, type CounterState, type SecretPickState } from './fixtures/games.ts';

function setup() {
  const registry = new GameRegistry().register(counterGame).register(secretPickGame);
  const store = new MemoryStore();
  return { manager: new GameManager({ registry, store }), store, registry };
}

async function rejects(promise: Promise<unknown>, code: string) {
  await assert.rejects(promise, (error: unknown) => error instanceof GameError && error.code === code);
}

describe('GameRegistry', () => {
  it('rejects duplicate types and bad player counts', () => {
    const registry = new GameRegistry().register(counterGame);
    assert.throws(() => registry.register(counterGame), /already registered/);
    assert.throws(() => registry.register({ ...counterGame, type: 'bad', minPlayers: 3, maxPlayers: 2 }), /invalid player counts/);
  });
});

describe('GameManager lifecycle (sequential game)', () => {
  it('create → join → auto-start when full', async () => {
    const { manager } = setup();
    const game = await manager.create('counter');
    assert.equal(game.status, 'lobby');
    assert.equal(game.state, null);

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
    await rejects(manager.join(game.id, 'Dan'), 'CONFLICT');
  });

  it('start early once minPlayers have joined; only players can start', async () => {
    const { manager } = setup();
    const game = await manager.create('counter');
    const ann = await manager.join(game.id, 'Ann');
    await rejects(manager.start(game.id, ann.key), 'CONFLICT'); // not enough players
    await manager.join(game.id, 'Ben');
    await rejects(manager.start(game.id, 'not-a-key'), 'UNAUTHORIZED');
    await rejects(manager.start(game.id, undefined), 'UNAUTHORIZED');
    const started = await manager.start(game.id, ann.key);
    assert.equal(started.status, 'active');
    await rejects(manager.start(game.id, ann.key), 'CONFLICT');
  });

  it('enforces auth, turn order, move validity and finish', async () => {
    const { manager } = setup();
    const game = await manager.create('counter', { target: 4 });
    const ann = await manager.join(game.id, 'Ann');
    const ben = await manager.join(game.id, 'Ben');
    await rejects(manager.move(game.id, ann.key, { add: 1 }), 'CONFLICT'); // still in lobby
    await manager.start(game.id, ann.key);

    // a key from a different game is useless here
    const other = await manager.create('counter');
    const intruder = await manager.join(other.id, 'Eve');
    await rejects(manager.move(game.id, intruder.key, { add: 1 }), 'UNAUTHORIZED');

    await rejects(manager.move(game.id, ben.key, { add: 1 }), 'NOT_YOUR_TURN');
    await rejects(manager.move(game.id, ann.key, { add: 7 }), 'INVALID_MOVE');

    await manager.move(game.id, ann.key, { add: 3 });
    const end = await manager.move(game.id, ben.key, { add: 1 });
    assert.equal(end.status, 'finished');
    assert.deepEqual(end.outcome, { winners: ['p2'] });
    assert.deepEqual(end.activePlayers, []);
    await rejects(manager.move(game.id, ann.key, { add: 1 }), 'CONFLICT');
  });

  it('expectedVersion gives optimistic concurrency', async () => {
    const { manager } = setup();
    const game = await manager.create('counter');
    const ann = await manager.join(game.id, 'Ann');
    await manager.join(game.id, 'Ben');
    const started = await manager.start(game.id, ann.key);
    await rejects(manager.move(game.id, ann.key, { add: 1 }, { expectedVersion: started.version - 1 }), 'CONFLICT');
    const moved = await manager.move(game.id, ann.key, { add: 1 }, { expectedVersion: started.version });
    assert.equal(moved.version, started.version + 1);
  });

  it('validates config and player names', async () => {
    const { manager } = setup();
    await rejects(manager.create('nope'), 'INVALID_REQUEST');
    await rejects(manager.create('counter', { target: -1 }), 'INVALID_REQUEST');
    const game = await manager.create('counter');
    await rejects(manager.join(game.id, ''), 'INVALID_REQUEST');
    await rejects(manager.join(game.id, 42), 'INVALID_REQUEST');
    await rejects(manager.join(game.id, 'x'.repeat(41)), 'INVALID_REQUEST');
    await rejects(manager.get('missing'), 'NOT_FOUND');
  });

  it('get() with a foreign key is rejected, not downgraded to spectator', async () => {
    const { manager } = setup();
    const game = await manager.create('counter');
    const ann = await manager.join(game.id, 'Ann');
    assert.equal((await manager.get(game.id, ann.key)).you, 'p1');
    assert.equal((await manager.get(game.id)).you, null);
    await rejects(manager.get(game.id, 'bogus'), 'UNAUTHORIZED');
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
    assert.equal((view.state as CounterState).count, 5);
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
      setup: () => ({ when: new Date() as never }),
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
    assert.deepEqual((afterAnn.state as SecretPickState).pending, { p1: 7 }); // Ann sees her own pick

    // Ben and spectators know Ann committed, but not what she picked.
    assert.deepEqual(((await manager.get(gameId, ben.key)).state as SecretPickState).pending, { p1: null });
    assert.deepEqual(((await manager.get(gameId)).state as SecretPickState).pending, { p1: null });

    await rejects(manager.move(gameId, ann.key, { pick: 3 }), 'NOT_YOUR_TURN'); // no double-submit

    const resolved = await manager.move(gameId, ben.key, { pick: 5 });
    const state = resolved.state as SecretPickState;
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
    assert.deepEqual(((await manager.get(gameId)).state as SecretPickState).history, [{ p1: 4, p2: 6 }]);
  });
});
