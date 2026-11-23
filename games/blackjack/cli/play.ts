/**
 * Scripted demo: three bots play blackjack against a running server. Each bot decides from its own
 * view, and what it sees is printed next to what a spectator sees at the same moment.
 *
 *   pnpm run dev                      # in one terminal
 *   pnpm run demo:blackjack [url]     # in another (default http://localhost:3000)
 */
import { GameServer, type PlayerSession } from '@gs/client';
import { handValue, type BlackjackMove, type BlackjackView, type Card, type VisibleCard } from '../src/index.ts';

const baseUrl = process.argv[2] ?? 'http://localhost:3000';
const NAMES = ['Ada', 'Ben', 'Cy'];

type Bot = PlayerSession<BlackjackView, BlackjackMove>;
const show = (cards: VisibleCard[]) => cards.map((card) => card ?? '▒▒').join(' ');

const server = new GameServer(baseUrl);
const { id } = await server.create('blackjack', { hands: 3 });
console.log(`Created game ${id}`);
const bots = new Map<string, Bot>();
const names = new Map<string, string>();
for (const name of NAMES) {
  const bot = await server.join<BlackjackView, BlackjackMove>(id, name);
  bots.set(bot.playerId, bot);
  names.set(bot.playerId, name);
}
const spectator = server.spectate<BlackjackView>(id);
const [host] = bots.values();
await host!.start();

let printedHands = 0;
for (;;) {
  const seen = (await spectator.get())!;
  if (seen.status === 'lobby') break;
  for (const result of seen.state.history.slice(printedHands)) {
    console.log(`  Hand ${result.hand} over. Dealer ${show(result.dealer)} (${handValue(result.dealer)})`);
    for (const [player, { cards, points }] of Object.entries(result.players)) {
      const sign = points > 0 ? '+' : '';
      console.log(`    ${names.get(player)!.padEnd(4)} ${show(cards)} (${handValue(cards)}): ${sign}${points}`);
    }
  }
  printedHands = seen.state.history.length;
  if (seen.status === 'finished') break;

  const turn = seen.state.turn!;
  const mine = (await bots.get(turn)!.get())!;
  if (mine.status === 'lobby') break;
  const hand = mine.state.seats[turn]!.cards as Card[]; // your own cards are never face down to you
  const action = handValue(hand) < 17 ? 'hit' : 'stand';
  console.log(
    `Hand ${seen.state.hand}, dealer ${show(mine.state.dealer)}: ${names.get(turn)} sees ${show(hand)},` +
      ` a spectator sees ${show(seen.state.seats[turn]!.cards)}. ${action}`,
  );
  await bots.get(turn)!.move({ action });
}

const final = (await spectator.get())!;
if (final.status !== 'lobby') {
  console.log('\nFinal scores:');
  const scores = Object.entries(final.state.seats).sort(([, a], [, b]) => b.score - a.score);
  for (const [player, seat] of scores) console.log(`  ${names.get(player)!.padEnd(4)} ${seat.score}`);
}
