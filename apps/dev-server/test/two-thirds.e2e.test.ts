import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { after, before, describe, it } from 'node:test';
import type { GameView, SimultaneousView } from '@gs/sdk';
import { GameClient, GameClientError } from '@gs/client';
import type { TwoThirdsGame } from '@gs/game-two-thirds';
import { buildServer } from '../src/app.ts';

const { server, manager } = buildServer();
let base = '';

before(async () => {
  await new Promise<void>((resolve) => server.listen(0, resolve));
  base = `http://localhost:${(server.address() as AddressInfo).port}`;
});
after(() => {
  manager.close();
  server.closeAllConnections();
  server.close();
});

type View = SimultaneousView<number> & { game: TwoThirdsGame };
const sim = (game: GameView): View => {
  assert.ok(game.status !== 'lobby', `expected a started game, got status ${game.status}`);
  return game.state as View;
};

/** Subscribe as a spectator, recording every view; `until` waits for a matching one. */
async function spectate(gameId: string) {
  const seen: GameView[] = [];
  const waiters: { predicate: (g: GameView) => boolean; resolve: (g: GameView) => void }[] = [];
  const sub = await new GameClient(base).subscribe(gameId, (game) => {
    seen.push(game);
    for (const w of [...waiters]) if (w.predicate(game)) (waiters.splice(waiters.indexOf(w), 1), w.resolve(game));
  });
  return {
    seen,
    close: () => sub.close(),
    until: (predicate: (g: GameView) => boolean) =>
      new Promise<GameView>((resolve) => {
        const hit = seen.find(predicate);
        if (hit) resolve(hit);
        else waiters.push({ predicate, resolve });
      }),
  };
}

async function newGame(playerCount: number, config: unknown) {
  const host = new GameClient(base);
  const game = await host.create('two-thirds', config);
  const players: GameClient[] = [];
  for (let i = 0; i < playerCount; i++) {
    const client = new GameClient(base);
    await client.join(game.id, `Player ${i + 1}`);
    players.push(client);
  }
  await players[0]!.start(game.id);
  return { id: game.id, players };
}

describe('two-thirds end to end (simultaneous decisions over HTTP + SSE)', () => {
  it('collects decisions in any order, keeps them hidden, and resolves when all are in', async () => {
    const { id, players } = await newGame(5, { rounds: 2 });
    const [p1, p2, p3, p4, p5] = players as [GameClient, GameClient, GameClient, GameClient, GameClient];
    const spectator = await spectate(id);

    const started = (await p1.get(id))!;
    assert.deepEqual(started.activePlayers, ['p1', 'p2', 'p3', 'p4', 'p5']);
    assert.equal(started.deadline, null); // no timer configured

    // Round 1: arbitrary order, and p3 changes their mind.
    await p4.move(id, { guess: 77 });
    await p3.move(id, { guess: 99 });
    await p3.move(id, { guess: 33 });
    await p1.move(id, { guess: 11 });

    const mine = sim((await p3.get(id))!);
    assert.equal(mine.yourDecision, 33);
    assert.deepEqual(mine.decided, ['p1', 'p3', 'p4']);
    assert.deepEqual(mine.waitingOn, ['p2', 'p5']);
    const theirs = sim((await p2.get(id))!);
    assert.equal(theirs.yourDecision, null);

    await rejects(p1.move(id, { guess: 500 }), 400);
    await p5.move(id, { guess: 50 });
    await p2.move(id, { guess: 0 }); // last one in → resolves

    const afterRound1 = await spectator.until((g) => sim(g).round === 2);
    const [result] = sim(afterRound1).game.history;
    assert.deepEqual(result!.guesses, { p1: 11, p2: 0, p3: 33, p4: 77, p5: 50 });
    // avg 34.2, target 22.8 → p3 (33) is 10.2 away, p1 (11) is 11.8 away
    assert.deepEqual(result!.winners, ['p3']);

    // While round 1 was open, spectators never saw any pending guess.
    for (const view of spectator.seen.filter((g) => sim(g).round === 1)) {
      assert.equal(sim(view).yourDecision, null);
      assert.deepEqual(sim(view).game.history, []);
      const pendingValues = [11, 33, 50, 77, 99];
      const text = JSON.stringify(sim(view));
      for (const v of pendingValues) assert.ok(!new RegExp(`\\b${v}\\b`).test(text), `leaked ${v}: ${text}`);
    }

    // Round 2 → game over.
    for (const [client, guess] of [[p1, 20], [p2, 20], [p3, 90], [p4, 90], [p5, 90]] as const) await client.move(id, { guess });
    const final = await spectator.until((g) => g.status === 'finished');
    assert.deepEqual(final.activePlayers, []);
    assert.ok(final.outcome && 'winners' in final.outcome);
    spectator.close();
  });

  it('a round timer resolves the round with whoever decided', async () => {
    const roundTimeMs = 150;
    const { id, players } = await newGame(3, { rounds: 1, roundTimeMs });
    const spectator = await spectate(id);

    const started = (await players[0]!.get(id))!;
    assert.ok(started.deadline !== null && started.deadline > Date.now());
    assert.equal(sim(started).roundDeadline, started.deadline);

    await players[0]!.move(id, { guess: 30 });
    await players[1]!.move(id, { guess: 60 });
    // players[2] never guesses

    const final = await spectator.until((g) => g.status === 'finished');
    const [result] = sim(final).game.history;
    assert.deepEqual(result!.missing, ['p3']);
    assert.deepEqual(result!.guesses, { p1: 30, p2: 60 });
    assert.deepEqual(final.outcome, { winners: ['p1'] });
    assert.equal(final.deadline, null);
    await rejects(players[2]!.move(id, { guess: 1 }), 409); // too late
    spectator.close();
  });
});

function rejects(promise: Promise<unknown>, status: number) {
  return assert.rejects(promise, (error: unknown) => error instanceof GameClientError && error.status === status);
}
