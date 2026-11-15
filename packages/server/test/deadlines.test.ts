import assert from 'node:assert/strict';
import { describe, it, type TestContext } from 'node:test';
import { defineGame, noConfig, ok } from '@gs/sdk';
import { GameManager, GameRegistry, MemoryStore } from '../src/index.ts';
import { counterGame, secretPickGame, type CounterState } from './fixtures/games.ts';

const T0 = 1_000_000;

/** Fake setTimeout + Date, so deadlines fire deterministically. */
function useFakeTime(t: TestContext) {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: T0 });
  return async (ms: number) => {
    t.mock.timers.tick(ms);
    // Deadline handlers are async (lock + store); let them settle. setImmediate isn't mocked.
    for (let i = 0; i < 10; i++) await new Promise((resolve) => setImmediate(resolve));
  };
}

async function timedGame(manager: GameManager, turnTimeMs = 1000) {
  const game = await manager.create('counter', { target: 10, turnTimeMs });
  const ann = await manager.join(game.id, 'Ann');
  const ben = await manager.join(game.id, 'Ben');
  await manager.start(game.id, ann.key);
  return { id: game.id, ann, ben };
}

const turnOf = async (manager: GameManager, id: string) => (await manager.get(id)).activePlayers;

describe('deadlines (timing primitives)', () => {
  it('exposes the deadline and fires onDeadline when it passes', async (t) => {
    const advance = useFakeTime(t);
    const store = new MemoryStore();
    const manager = new GameManager({ registry: new GameRegistry().register(counterGame), store });
    const { id } = await timedGame(manager);

    const before = await manager.get(id);
    assert.equal(before.deadline, T0 + 1000);
    assert.deepEqual(before.activePlayers, ['p1']);

    const changes: number[] = [];
    manager.onChange(id, (v) => changes.push(v));

    await advance(999);
    assert.deepEqual(await turnOf(manager, id), ['p1']);

    await advance(1);
    const after = await manager.get(id);
    assert.deepEqual(after.activePlayers, ['p2']); // p1's turn was skipped
    assert.equal(after.version, before.version + 1);
    assert.equal(after.deadline, T0 + 2000);
    assert.deepEqual(changes, [after.version]); // SSE subscribers are notified like any change

    const record = (await store.get(id))!;
    assert.deepEqual(record.moves.at(-1), { kind: 'deadline', player: null, move: null, version: after.version, at: new Date(T0 + 1000).toISOString() });

    await advance(1000);
    assert.deepEqual(await turnOf(manager, id), ['p1']); // and it keeps re-arming
    manager.close();
  });

  it('a move that moves the deadline cancels the old timer', async (t) => {
    const advance = useFakeTime(t);
    const manager = new GameManager({ registry: new GameRegistry().register(counterGame) });
    const { id, ann } = await timedGame(manager);

    await advance(600);
    await manager.move(id, ann.key, { add: 1 }); // p2's turn now, deadline T0+1600
    await advance(600); // past the ORIGINAL deadline
    assert.deepEqual(await turnOf(manager, id), ['p2']);
    await advance(400);
    assert.deepEqual(await turnOf(manager, id), ['p1']);
    manager.close();
  });

  it('no timers for games without deadlines or after the game ends', async (t) => {
    const advance = useFakeTime(t);
    const manager = new GameManager({ registry: new GameRegistry().register(counterGame) });
    const game = await manager.create('counter', { target: 1 }); // no turnTimeMs
    const ann = await manager.join(game.id, 'Ann');
    await manager.join(game.id, 'Ben');
    const started = await manager.start(game.id, ann.key);
    assert.equal(started.deadline, null);

    const timed = await timedGame(manager);
    for (let i = 0; i < 4; i++) {
      const [active] = await turnOf(manager, timed.id);
      await manager.move(timed.id, active === 'p1' ? timed.ann.key : timed.ben.key, { add: 3 });
    }
    const finished = await manager.get(timed.id);
    assert.equal(finished.status, 'finished');
    assert.equal(finished.deadline, null);
    await advance(10_000);
    assert.equal((await manager.get(timed.id)).version, finished.version);
  });

  it('restoreTimers re-arms deadlines for games loaded from a snapshot', async (t) => {
    const advance = useFakeTime(t);
    const registry = new GameRegistry().register(counterGame);
    const store = new MemoryStore();
    const original = new GameManager({ registry, store });
    const { id } = await timedGame(original);
    original.close(); // simulate the old process going away

    const restored = new GameManager({ registry, store: MemoryStore.fromSnapshot(store.snapshot()) });
    await restored.restoreTimers();
    await advance(1000);
    assert.deepEqual(await turnOf(restored, id), ['p2']);
    restored.close();
  });

  it('restoreTimers skips games whose type is no longer registered', async (t) => {
    const advance = useFakeTime(t);
    const store = new MemoryStore();
    const original = new GameManager({ registry: new GameRegistry().register(counterGame).register(secretPickGame), store });
    await original.create('secret-pick'); // its type is dropped before the restart
    const { id } = await timedGame(original);
    original.close();

    const restored = new GameManager({ registry: new GameRegistry().register(counterGame), store });
    await restored.restoreTimers(); // must not throw on the stale game
    await advance(1000);
    assert.deepEqual(await turnOf(restored, id), ['p2']);
    restored.close();
  });

  it('a deadline that already passed fires immediately on restore', async (t) => {
    const advance = useFakeTime(t);
    const registry = new GameRegistry().register(counterGame);
    const store = new MemoryStore();
    const original = new GameManager({ registry, store });
    const { id } = await timedGame(original);
    original.close();

    t.mock.timers.setTime(T0 + 5000); // "downtime" past the deadline
    const restored = new GameManager({ registry, store });
    await restored.restoreTimers();
    await advance(0);
    assert.deepEqual(await turnOf(restored, id), ['p2']);
    restored.close();
  });

  it('reports (and does not loop on) an onDeadline that fails to move the deadline', async (t) => {
    const advance = useFakeTime(t);
    const stuck = defineGame<{ at: number }>({
      type: 'stuck',
      minPlayers: 1,
      maxPlayers: 1,
      parseConfig: noConfig,
      setup: ({ now }) => ({ at: now + 100 }),
      parseMove: () => ok(null),
      applyMove: (s) => ok(s),
      activePlayers: () => ['p1'],
      outcome: () => null,
      deadline: (s) => s.at,
      onDeadline: (s) => s, // bug: same deadline
    });
    const errors: unknown[] = [];
    const manager = new GameManager({ registry: new GameRegistry().register(stuck), onError: (e) => errors.push(e) });
    const game = await manager.create('stuck');
    const { game: started } = await manager.join(game.id, 'Solo');

    await advance(100);
    await advance(100);
    assert.equal(errors.length, 1);
    assert.match(String(errors[0]), /did not move the deadline forward/);
    assert.equal((await manager.get(game.id)).version, started.version);
  });

  it('registry requires deadline and onDeadline together', () => {
    const { onDeadline: _, ...halfTimed } = counterGame;
    assert.throws(() => new GameRegistry().register(halfTimed), /both deadline and onDeadline/);
  });

  it('timed state is plain JSON', async (t) => {
    useFakeTime(t);
    const manager = new GameManager({ registry: new GameRegistry().register(counterGame) });
    const { id } = await timedGame(manager);
    const view = await manager.get(id);
    assert.equal(view.status, 'active');
    const state = view.state as CounterState;
    assert.equal(state.turnStartedAt, T0);
    manager.close();
  });
});
