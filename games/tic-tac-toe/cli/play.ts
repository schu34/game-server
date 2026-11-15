/**
 * Scripted demo: two bots play tic-tac-toe against a running server,
 * while a spectator subscription prints every state pushed over SSE.
 *
 *   npm run dev            # in one terminal
 *   npm run demo [url]     # in another (default http://localhost:3000)
 */
import type { GameView } from '@gs/sdk';
import { GameClient } from '@gs/client';
import { renderBoard, type TicTacToeState } from '../src/index.ts';

const baseUrl = process.argv[2] ?? 'http://localhost:3000';

const alice = new GameClient(baseUrl);
const bob = new GameClient(baseUrl);
const spectator = new GameClient(baseUrl);

const game = await alice.create('tic-tac-toe');
console.log(`Created game ${game.id}`);

let finished!: () => void;
const gameOver = new Promise<void>((resolve) => (finished = resolve));
const subscription = await spectator.subscribe(game.id, (view: GameView) => {
  console.log(`\n[v${view.version}] status=${view.status} active=${view.activePlayers.join(',') || '-'}`);
  if (view.state) console.log(renderBoard((view.state as TicTacToeState).board));
  if (view.status === 'finished') finished();
});

await alice.join(game.id, 'Alice');
await bob.join(game.id, 'Bob'); // second player fills the game, which auto-starts it

const players = new Map([
  [alice.playerId!, alice],
  [bob.playerId!, bob],
]);

for (;;) {
  const view = (await alice.get(game.id))!;
  if (view.status === 'finished') break;
  const state = view.state as TicTacToeState;
  const empty = state.board.flatMap((cell, i) => (cell === null ? [i] : []));
  const cell = empty[Math.floor(Math.random() * empty.length)]!;
  const mover = players.get(view.activePlayers[0]!)!;
  await mover.move(game.id, { cell });
  await new Promise((r) => setTimeout(r, 150));
}

await gameOver;
subscription.close();

const final = (await alice.get(game.id))!;
const names = Object.fromEntries(final.players.map((p) => [p.id, p.name]));
const outcome = final.outcome!;
console.log('\n' + ('draw' in outcome ? 'Draw!' : `${outcome.winners.map((id) => names[id]).join(', ')} wins!`));
