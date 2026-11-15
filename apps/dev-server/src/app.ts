import { createGameServer, GameRegistry, type GameServerOptions } from '@gs/server';
import { ticTacToe } from '@gs/game-tic-tac-toe';
import { twoThirds } from '@gs/game-two-thirds';

/** The one place that knows which games exist. Add new games here. */
export function buildRegistry(): GameRegistry {
  return new GameRegistry().register(ticTacToe).register(twoThirds);
}

export function buildServer(options: Omit<GameServerOptions, 'registry'> = {}) {
  return createGameServer({ registry: buildRegistry(), ...options });
}
