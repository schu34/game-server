import type { GameDefinition, GameTypeInfo, Json } from '@gs/sdk';

/** A game definition with its state, move and config types erased. */
export type AnyGameDefinition = GameDefinition<Json, unknown, Json>;

export class GameRegistry {
  readonly #definitions = new Map<string, AnyGameDefinition>();

  register<TState extends Json, TMove, TConfig extends Json>(definition: GameDefinition<TState, TMove, TConfig>): this {
    const { type, minPlayers, maxPlayers } = definition;
    if (!type) throw new Error('Game definition must have a type');
    if (this.#definitions.has(type)) throw new Error(`Game type "${type}" is already registered`);
    if (!Number.isInteger(minPlayers) || minPlayers < 1 || !Number.isInteger(maxPlayers) || maxPlayers < minPlayers) {
      throw new Error(`Game type "${type}" has invalid player counts (${minPlayers}..${maxPlayers})`);
    }
    if (!!definition.deadline !== !!definition.onDeadline) {
      throw new Error(`Game type "${type}" must define both deadline and onDeadline, or neither`);
    }
    this.#definitions.set(type, definition as unknown as AnyGameDefinition);
    return this;
  }

  get(type: string): AnyGameDefinition | undefined {
    return this.#definitions.get(type);
  }

  list(): GameTypeInfo[] {
    return [...this.#definitions.values()].map(({ type, minPlayers, maxPlayers }) => ({ type, minPlayers, maxPlayers }));
  }
}
