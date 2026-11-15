import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { after, before, describe, it } from 'node:test';
import type { GameView } from '@gs/sdk';
import { GameClient, GameClientError } from '@gs/client';
import type { TicTacToeState } from '@gs/game-tic-tac-toe';
import { buildServer } from '../src/app.ts';

const { server } = buildServer();
let base = '';

before(async () => {
  await new Promise<void>((resolve) => server.listen(0, resolve));
  base = `http://localhost:${(server.address() as AddressInfo).port}`;
});
after(() => {
  server.closeAllConnections();
  server.close();
});

function rejectsWith(promise: Promise<unknown>, status: number) {
  return assert.rejects(promise, (error: unknown) => error instanceof GameClientError && error.status === status);
}

describe('tic-tac-toe end to end over HTTP + SSE', () => {
  it('plays a full game; spectators see every state; outsiders are rejected', async () => {
    const x = new GameClient(base);
    const o = new GameClient(base);
    const spectator = new GameClient(base);

    assert.deepEqual(
      (await spectator.gameTypes()).map((g) => g.type),
      ['tic-tac-toe', 'two-thirds'],
    );

    const game = await x.create('tic-tac-toe');
    const seen: GameView[] = [];
    let finished!: () => void;
    const done = new Promise<void>((resolve) => (finished = resolve));
    const sub = await spectator.subscribe(game.id, (view) => {
      seen.push(view);
      if (view.status === 'finished') finished();
    });

    await x.join(game.id, 'Xavier');
    const joined = await o.join(game.id, 'Olive');
    assert.equal(joined.game.status, 'active'); // full → auto-started

    // An outsider: a real key, but for a different game.
    const outsider = new GameClient(base);
    const otherGame = await outsider.create('tic-tac-toe');
    await outsider.join(otherGame.id, 'Mallory');
    await rejectsWith(outsider.move(game.id, { cell: 0 }), 401);
    await rejectsWith(new GameClient(base).move(game.id, { cell: 0 }), 401);

    await rejectsWith(o.move(game.id, { cell: 0 }), 403); // X goes first
    await x.move(game.id, { cell: 0 });
    await rejectsWith(o.move(game.id, { cell: 0 }), 400); // taken
    await o.move(game.id, { cell: 3 });
    await x.move(game.id, { cell: 1 });
    await o.move(game.id, { cell: 4 });
    const final = await x.move(game.id, { cell: 2 });

    assert.equal(final.status, 'finished');
    assert.deepEqual(final.outcome, { winners: [x.playerId] });
    assert.deepEqual((final.state as TicTacToeState).board, ['X', 'X', 'X', 'O', 'O', null, null, null, null]);

    await done;
    sub.close();
    await sub.done;
    // lobby(0), join(1), join+start(2), 5 moves → 7. SSE may coalesce rapid changes,
    // but it must start from the current state, never go backwards, and end on the final state.
    const versions = seen.map((v) => v.version);
    assert.equal(versions[0], 0);
    assert.equal(versions.at(-1), 7);
    assert.ok(versions.every((v, i) => i === 0 || v > versions[i - 1]!), `out of order: ${versions}`);
    assert.ok(seen.every((v) => v.you === null));
  });
});
