import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { after, before, describe, it } from 'node:test';
import type { GameView, Json, SimultaneousView } from '@gs/sdk';
import { GameClientError, GameServer, type PlayerSession } from '@gs/client';
import type { Decision, UndercutGame } from '@gs/game-undercut';
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

type View = SimultaneousView<Decision> & { game: UndercutGame };
/** Undercut's decisions are sent as-is: `{ pick: [a, b] }` or `{ play: n }`. */
type Player = PlayerSession<View, Decision>;
const sim = (game: GameView<View>): View => {
  assert.ok(game.status !== 'lobby', `expected a started game, got status ${game.status}`);
  return game.state;
};

/** Subscribe as a spectator, recording every view; `until` waits for a matching one. */
async function spectate(gameId: string) {
  const seen: GameView<View>[] = [];
  const waiters: { predicate: (g: GameView<View>) => boolean; resolve: (g: GameView<View>) => void }[] = [];
  const sub = await new GameServer(base).spectate<View>(gameId).subscribe((game) => {
    seen.push(game);
    for (const w of [...waiters]) if (w.predicate(game)) (waiters.splice(waiters.indexOf(w), 1), w.resolve(game));
  });
  return {
    seen,
    close: () => sub.close(),
    until: (predicate: (g: GameView<View>) => boolean) =>
      new Promise<GameView<View>>((resolve) => {
        const hit = seen.find(predicate);
        if (hit) resolve(hit);
        else waiters.push({ predicate, resolve });
      }),
  };
}

async function newGame(playerCount: number, config: Json) {
  const games = new GameServer(base);
  const game = await games.create('undercut', config);
  const players: Player[] = [];
  for (let i = 0; i < playerCount; i++) players.push(await games.join<View, Decision>(game.id, `Player ${i + 1}`));
  await players[0]!.start();
  return { id: game.id, players };
}

describe('undercut end to end (two-step simultaneous rounds over HTTP + SSE)', () => {
  it('plays a one-cycle game: hidden picks, revealed pairs, a winner and eliminations', async () => {
    const { id, players } = await newGame(3, { cycles: 1 });
    const [p1, p2, p3] = players as [Player, Player, Player];
    const spectator = await spectate(id);

    // Round 1, pick step: p1's pick stays hidden from the others until everyone has picked.
    await rejects(p1.move({ pick: [1, 1] }), 400);
    await p1.move({ pick: [1, 8] });
    assert.deepEqual(sim((await p1.get())!).yourDecision, { pick: [1, 8] });
    assert.equal(sim((await p2.get())!).yourDecision, null);
    await p2.move({ pick: [7, 8] });
    await p3.move({ pick: [7, 8] });

    const revealed = await spectator.until((g) => sim(g).game.step === 'play');
    assert.deepEqual(sim(revealed).game.pairs, { p1: [1, 8], p2: [7, 8], p3: [7, 8] });
    for (const view of spectator.seen.filter((g) => sim(g).game.step === 'pick')) {
      assert.doesNotMatch(JSON.stringify(sim(view)), /"pick":/, 'a pending pick leaked to a spectator');
    }

    // Play step: only a revealed card can be played. p2 and p3 match, so p1's 1 wins.
    await rejects(p1.move({ play: 2 }), 400);
    await p1.move({ play: 1 });
    await p2.move({ play: 8 });
    await p3.move({ play: 8 });
    const afterRound1 = await spectator.until((g) => sim(g).game.round === 2);
    assert.equal(sim(afterRound1).game.history[0]!.winner, 'p1');

    // Rounds 2-6: p1 keeps undercutting while p2 and p3 keep matching each other.
    for (let r = 2; r <= 6; r++) {
      await p1.move({ pick: [r, 8] });
      await p2.move({ pick: [1, 9 - r] });
      await p3.move({ pick: [1, 9 - r] });
      await p1.move({ play: r });
      await p2.move({ play: 9 - r });
      await p3.move({ play: 9 - r });
    }

    const final = await spectator.until((g) => g.status === 'finished');
    assert.deepEqual(final.outcome, { winners: ['p1'] });
    assert.deepEqual(final.activePlayers, []);
    const seats = sim(final).game.seats;
    assert.deepEqual([seats.p1!.status, seats.p2!.status, seats.p3!.status], ['winner', 'eliminated', 'eliminated']);
    assert.equal(seats.p1!.tokens, 6);
    spectator.close();
  });

  it('a decision timer picks and plays for players who run out of time', async () => {
    const { id, players } = await newGame(3, { cycles: 1, decisionTimeMs: 150 });
    const spectator = await spectate(id);

    await players[0]!.move({ pick: [1, 2] });
    const revealed = await spectator.until((g) => sim(g).game.step === 'play');
    assert.deepEqual(sim(revealed).game.pairs, { p1: [1, 2], p2: [7, 8], p3: [7, 8] });

    await players[0]!.move({ play: 1 });
    const scored = await spectator.until((g) => sim(g).game.history.length === 1);
    const [result] = sim(scored).game.history;
    assert.deepEqual(result!.played, { p1: 1, p2: 8, p3: 8 });
    assert.deepEqual(result!.autoPlayed, ['p2', 'p3']);
    assert.equal(result!.winner, 'p1');
    spectator.close();
  });
});

function rejects(promise: Promise<unknown>, status: number) {
  return assert.rejects(promise, (error: unknown) => error instanceof GameClientError && error.status === status);
}
