import { createGameServer, GameRegistry, type GameServerOptions } from '@gs/server';
import { ticTacToe } from '@gs/game-tic-tac-toe';

/** The one place that knows which games exist. Add new games here. */
export function buildRegistry(): GameRegistry {
  return new GameRegistry().register(ticTacToe);
}

export function buildServer(options: Omit<GameServerOptions, 'registry'> = {}) {
  return createGameServer({ registry: buildRegistry(), ...options });
}
