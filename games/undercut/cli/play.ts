/**
 * Scripted demo: five bots play a game of Undercut against a running server,
 * while a spectator subscription prints each round as it resolves over SSE.
 *
 *   pnpm run dev                     # in one terminal
 *   pnpm run demo:undercut [url]     # in another (default http://localhost:3000)
 */
import type { GameView, SimultaneousView } from '@gs/sdk';
import { GameServer, type PlayerSession } from '@gs/client';
import { cycleOf, type Decision, type UndercutGame } from '../src/index.ts';

const baseUrl = process.argv[2] ?? 'http://localhost:3000';
const NAMES = ['Ada', 'Ben', 'Cy', 'Dee', 'Eli'];

type View = SimultaneousView<Decision> & { game: UndercutGame };
type Bot = PlayerSession<View, Decision>;
const gameOf = (view: GameView<View>) => (view.status === 'lobby' ? null : view.state.game);

const server = new GameServer(baseUrl);

const game = await server.create('undercut', { cycles: 3 });
console.log(`Created game ${game.id}`);
const bots: Bot[] = [];
for (const botName of NAMES) bots.push(await server.join<View, Decision>(game.id, botName));
const byId = new Map(bots.map((bot) => [bot.playerId, bot]));
const name = (id: string) => NAMES[bots.indexOf(byId.get(id)!)]!;
const spectator = server.spectate<View>(game.id);

let finished!: () => void;
const gameOver = new Promise<void>((resolve) => (finished = resolve));
let printedRounds = 0;
let printedCycles = 0;
const subscription = await spectator.subscribe((view) => {
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

await bots[0]!.start();

const pickTwo = (hand: number[]) => {
  const shuffled = [...hand].sort(() => Math.random() - 0.5);
  return shuffled.slice(0, 2);
};

for (;;) {
  const view = (await spectator.get())!;
  const state = gameOf(view);
  if (!state || view.status === 'finished') break;
  // Everyone still to decide submits, in random order, just as real players would.
  for (const id of [...view.activePlayers].sort(() => Math.random() - 0.5)) {
    const decision: Decision =
      state.step === 'pick'
        ? { pick: pickTwo(state.seats[id]!.hand) }
        : { play: state.pairs[id]![Math.floor(Math.random() * 2)]! };
    await byId.get(id)!.move(decision);
  }
  await new Promise((r) => setTimeout(r, 50));
}

await gameOver;
subscription.close();

const final = gameOf((await spectator.get())!)!;
console.log('\nFinal standings:');
const order = ['winner', 'playing', 'eliminated', 'safe'];
const standings = Object.entries(final.seats).sort(
  ([, a], [, b]) => order.indexOf(a.status) - order.indexOf(b.status) || b.tokens - a.tokens,
);
for (const [id, seat] of standings) {
  console.log(`  ${name(id).padEnd(4)} ${seat.tokens} tokens  ${seat.status}`);
}
