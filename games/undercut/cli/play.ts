/**
 * Scripted demo: five bots play a game of Undercut against a running server,
 * while a spectator subscription prints each round as it resolves over SSE.
 *
 *   pnpm run dev                     # in one terminal
 *   pnpm run demo:undercut [url]     # in another (default http://localhost:3000)
 */
import type { GameView, SimultaneousView } from '@gs/sdk';
import { GameClient } from '@gs/client';
import { cycleOf, type Decision, type UndercutGame } from '../src/index.ts';

const baseUrl = process.argv[2] ?? 'http://localhost:3000';
const NAMES = ['Ada', 'Ben', 'Cy', 'Dee', 'Eli'];

type View = SimultaneousView<Decision> & { game: UndercutGame };
const gameOf = (view: GameView) => (view.status === 'lobby' ? null : (view.state as View).game);

const bots = NAMES.map(() => new GameClient(baseUrl));
const spectator = new GameClient(baseUrl);

const game = await bots[0]!.create('undercut', { cycles: 3 });
console.log(`Created game ${game.id}`);
for (const [i, bot] of bots.entries()) await bot.join(game.id, NAMES[i]!);
const byId = new Map(bots.map((bot) => [bot.playerId!, bot]));
const name = (id: string) => NAMES[bots.indexOf(byId.get(id)!)]!;

let finished!: () => void;
const gameOver = new Promise<void>((resolve) => (finished = resolve));
let printedRounds = 0;
let printedCycles = 0;
const subscription = await spectator.subscribe(game.id, (view) => {
  const state = gameOf(view);
  if (!state) return;
  for (const result of state.history.slice(printedRounds)) {
    if (result.round % 6 === 1) console.log(`\n── Cycle ${cycleOf(result.round)} ──`);
    const plays = Object.entries(result.played)
      .map(([p, card]) => `${name(p)} ${result.pairs[p]!.join('/')}→${card}`)
      .join('  ');
    const winner = result.winner ? `${name(result.winner)} wins` : 'no unique card';
    console.log(`Round ${String(result.round).padStart(2)}: ${plays}   ⇒ ${winner}`);
  }
  printedRounds = state.history.length;
  for (const { cycle, safe } of state.cycleResults.slice(printedCycles)) {
    if (cycle < state.cycles) console.log(safe ? `${name(safe)} is safe and leaves.` : 'Nobody is safe this cycle.');
  }
  printedCycles = state.cycleResults.length;
  if (view.status === 'finished') finished();
});

await bots[0]!.start(game.id);

const pickTwo = (hand: number[]) => {
  const shuffled = [...hand].sort(() => Math.random() - 0.5);
  return shuffled.slice(0, 2);
};

for (;;) {
  const view = (await spectator.get(game.id))!;
  const state = gameOf(view);
  if (!state || view.status === 'finished') break;
  // Everyone still to decide submits, in random order, just as real players would.
  for (const id of [...view.activePlayers].sort(() => Math.random() - 0.5)) {
    const decision =
      state.step === 'pick'
        ? { pick: pickTwo(state.seats[id]!.hand) }
        : { play: state.pairs[id]![Math.floor(Math.random() * 2)]! };
    await byId.get(id)!.move(game.id, decision);
  }
  await new Promise((r) => setTimeout(r, 50));
}

await gameOver;
subscription.close();

const final = gameOf((await spectator.get(game.id))!)!;
console.log('\nFinal standings:');
const order = ['winner', 'playing', 'eliminated', 'safe'];
const standings = Object.entries(final.seats).sort(
  ([, a], [, b]) => order.indexOf(a.status) - order.indexOf(b.status) || b.tokens - a.tokens,
);
for (const [id, seat] of standings) {
  console.log(`  ${name(id).padEnd(4)} ${seat.tokens} tokens  ${seat.status}`);
}
