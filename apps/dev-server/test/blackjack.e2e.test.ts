import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { after, before, describe, it } from 'node:test';
import { MemoryStore, type StartedRecord } from '@gs/server';
import type { GameView } from '@gs/sdk';
import { GameServer, type PlayerSession } from '@gs/client';
import { handValue, type BlackjackMove, type BlackjackState, type BlackjackView } from '@gs/game-blackjack';
import { buildServer } from '../src/app.ts';

const store = new MemoryStore();
const { server, manager } = buildServer({ store });
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

type View = GameView<BlackjackView>;
type Player = PlayerSession<BlackjackView, BlackjackMove>;

/** Compare a view that was sent out with the real state behind it: no card the viewer can't see, and no secrets. */
function assertNoLeaks(view: View, real: BlackjackState, seed: string) {
  assert.ok(view.status !== 'lobby');
  const over = real.turn === null;
  const hidden = [...real.deck];
  if (!over) {
    hidden.push(real.dealer[1]!);
    for (const [player, seat] of Object.entries(real.seats)) {
      if (player !== view.you && (seat.status === 'in' || seat.status === 'stood'))
        hidden.push(...seat.cards.slice(0, 2));
    }
  }
  // Finished hands used other decks, so the same cards may rightly appear in their results.
  const { history: _, ...currentHand } = view.state;
  const sent = JSON.stringify({ ...view, state: currentHand });
  for (const card of hidden) assert.ok(!sent.includes(`"${card}"`), `${card} leaked to ${view.you ?? 'a spectator'}`);
  assert.ok(!JSON.stringify(view).includes(seed), `the seed leaked to ${view.you ?? 'a spectator'}`);
  if (view.you) assert.deepEqual(view.state.seats[view.you]!.cards, real.seats[view.you]!.cards); // you see your own
}

describe('blackjack end to end (private hands over HTTP + SSE)', () => {
  it('plays a game in which nobody is ever sent a card they may not see', async () => {
    const games = new GameServer(base);
    const { id } = await games.create('blackjack', { hands: 8 });
    const ann = await games.join<BlackjackView, BlackjackMove>(id, 'Ann');
    const ben = await games.join<BlackjackView, BlackjackMove>(id, 'Ben');
    const players: Record<string, Player> = { [ann.playerId]: ann, [ben.playerId]: ben };
    const spectator = games.spectate<BlackjackView>(id);

    /** The real state at each version, and every view anyone was sent. */
    const real = new Map<number, BlackjackState>();
    const sent: View[] = [];
    const record = async () => {
      const { status, version, seed, ...game } = (await store.get(id))! as StartedRecord;
      const state = game.state as BlackjackState;
      real.set(version, state);
      return { status, state, seed };
    };

    const streamed = { p1: 0, p2: 0, spectator: 0 };
    let streamsOver: () => void;
    const allFinished = new Promise<void>((resolve) => (streamsOver = resolve));
    let open = 3;
    const collect = (view: View) => {
      if (view.status === 'lobby') return;
      sent.push(view);
      streamed[(view.you ?? 'spectator') as keyof typeof streamed]++;
      if (view.status === 'finished' && --open === 0) streamsOver();
    };
    const subscriptions = await Promise.all([ann, ben, spectator].map((viewer) => viewer.subscribe(collect)));

    try {
      sent.push(await ann.start());
      let game = await record();
      while (game.status === 'active') {
        for (const viewer of [ann, ben, spectator]) sent.push((await viewer.get())!);
        const turn = game.state.turn!;
        const mine = (await players[turn]!.get())!;
        assert.ok(mine.status !== 'lobby');
        // Each player decides from their own view, which is all a real client has.
        const hand = mine.state.seats[turn]!.cards.map((card) => card!);
        sent.push(await players[turn]!.move({ action: handValue(hand) < 17 ? 'hit' : 'stand' }));
        game = await record();
      }
      for (const viewer of [ann, ben, spectator]) sent.push((await viewer.get())!);
      await allFinished;

      for (const view of sent) assertNoLeaks(view, real.get(view.version)!, game.seed);
      assert.ok(streamed.p1 > 1 && streamed.p2 > 1 && streamed.spectator > 1);
      assert.equal(game.state.history.length, 8);
    } finally {
      for (const subscription of subscriptions) subscription.close();
    }
  });
});
