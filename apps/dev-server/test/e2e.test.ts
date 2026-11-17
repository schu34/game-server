import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { after, before, describe, it } from 'node:test';
import type { GameView } from '@gs/sdk';
import { GameClientError, GameServer, type PlayerSession } from '@gs/client';
import type { TicTacToeMove, TicTacToeState } from '@gs/game-tic-tac-toe';
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

const join = (games: GameServer, gameId: string, name: string): Promise<PlayerSession<TicTacToeState, TicTacToeMove>> =>
  games.join<TicTacToeState, TicTacToeMove>(gameId, name);

function rejectsWith(promise: Promise<unknown>, status: number) {
  return assert.rejects(promise, (error: unknown) => error instanceof GameClientError && error.status === status);
}

describe('tic-tac-toe end to end over HTTP + SSE', () => {
  it('plays a full game; spectators see every state; outsiders are rejected', async () => {
    const games = new GameServer(base);

    assert.deepEqual(
      (await games.gameTypes()).map((g) => g.type),
      ['tic-tac-toe', 'two-thirds', 'undercut'],
    );

    const game = await games.create('tic-tac-toe');
    const seen: GameView[] = [];
    let finished!: () => void;
    const done = new Promise<void>((resolve) => (finished = resolve));
    const sub = await games.spectate<TicTacToeState>(game.id).subscribe((view) => {
      seen.push(view);
      if (view.status === 'finished') finished();
    });

    const x = await join(games, game.id, 'Xavier');
    const o = await join(games, game.id, 'Olive');
    assert.equal((await o.get())!.status, 'active'); // full → auto-started

    // An outsider: a real key, but for a different game. And a made-up key.
    const otherGame = await games.create('tic-tac-toe');
    const mallory = await join(games, otherGame.id, 'Mallory');
    await rejectsWith(games.session<TicTacToeState, TicTacToeMove>(game.id, mallory.seat).move({ cell: 0 }), 401);
    await rejectsWith(
      games.session<TicTacToeState, TicTacToeMove>(game.id, { playerId: 'p1', key: 'nope' }).move({ cell: 0 }),
      401,
    );

    await rejectsWith(o.move({ cell: 0 }), 403); // X goes first
    await x.move({ cell: 0 });
    await rejectsWith(o.move({ cell: 0 }), 400); // taken
    await o.move({ cell: 3 });
    await x.move({ cell: 1 });
    await o.move({ cell: 4 });
    const final = await x.move({ cell: 2 });

    assert.equal(final.status, 'finished');
    assert.deepEqual(final.outcome, { winners: [x.playerId] });
    assert.deepEqual(final.state.board, ['X', 'X', 'X', 'O', 'O', null, null, null, null]); // typed: no cast

    await done;
    sub.close();
    await sub.done;
    // lobby(0), join(1), join+start(2), 5 moves → 7. SSE may coalesce rapid changes,
    // but it must start from the current state, never go backwards, and end on the final state.
    const versions = seen.map((v) => v.version);
    assert.equal(versions[0], 0);
    assert.equal(versions.at(-1), 7);
    assert.ok(
      versions.every((v, i) => i === 0 || v > versions[i - 1]!),
      `out of order: ${versions}`,
    );
    assert.ok(seen.every((v) => v.you === null));
  });

  it("a player's stream carries their own view and survives dropped connections", async () => {
    const games = new GameServer(base);
    const game = await games.create('tic-tac-toe');
    const x = await join(games, game.id, 'Xavier');
    await join(games, game.id, 'Olive');

    const seen: GameView<TicTacToeState>[] = [];
    const errors: Error[] = [];
    const waiters: [number, () => void][] = [];
    const sub = await x.subscribe(
      (view) => {
        seen.push(view);
        for (const [version, resolve] of waiters) if (view.version >= version) resolve();
      },
      { retryMs: 20, onError: (e) => errors.push(e) },
    );
    const reach = (version: number) =>
      seen.some((v) => v.version >= version) ? Promise.resolve() : new Promise<void>((r) => waiters.push([version, r]));

    try {
      await reach(2);
      assert.equal(seen.at(-1)!.you, x.playerId);

      server.closeAllConnections(); // drop every open stream (and idle keep-alive sockets)
      await new Promise((r) => setTimeout(r, 50)); // let fetch notice its pooled sockets are gone
      await x.move({ cell: 4 });
      await reach(3);
      assert.ok(errors.length > 0, 'the drop is reported');
      assert.equal(seen.at(-1)!.you, x.playerId);
      const versions = seen.map((v) => v.version);
      assert.deepEqual(
        versions,
        [...new Set(versions)].sort((a, b) => a - b),
        `repeated or out of order: ${versions}`,
      );
    } finally {
      sub.close();
      await sub.done;
    }
  });

  it('subscribing to a missing game rejects', async () => {
    await rejectsWith(
      new GameServer(base).spectate('missing').subscribe(() => {}),
      404,
    );
  });
});
