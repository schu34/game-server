# AGENTS.md

Guidance for coding agents (and humans) changing this repo. `README.md` is the reference for the
game contract, timing primitives and HTTP API; this file says how to change things without breaking
the design. When the two disagree, fix whichever is wrong in the same change.

## What this project is

A **generic** turn-based game server. The server is the product. The games in `games/` are
proofs of concept that exercise it. Every change should keep the server knowing nothing about any
specific game.

## Before you finish any change

```
npm run typecheck   # tsc, no emit
npm test            # boundary check, then every unit, HTTP and e2e test
```

Both must pass. Don't skip or weaken a failing test to get there; fix the cause, or say plainly that
you couldn't.

## Rules that apply everywhere

- **No build step.** Node runs the TypeScript directly (type stripping). That means:
  - Only erasable syntax: no `enum`, no `namespace`, no constructor parameter properties. For an
    enum, use an `as const` object plus a type of the same name (see `ErrorCode` in
    `packages/sdk/src/index.ts`).
  - Relative imports include the `.ts` extension. Type-only imports use `import type` (or
    `type` on the specifier), because `verbatimModuleSyntax` is on.
- **Respect the dependency boundaries** in the README table. `scripts/check-boundaries.ts` enforces
  them on every `npm test`. If a change seems to need a new edge (say, the server importing a game),
  the design is wrong. Don't add the edge, and don't loosen the check to make it pass.
- **Avoid new runtime dependencies.** The SDK has none and must stay that way. If one is truly
  needed, keep it as narrow as the Hono rule (only `packages/server/src/http` may import it), pin an
  exact version that has been published for at least two weeks, and update the boundary check and
  README together.
- **State is JSON.** Everything stored must survive `JSON.stringify` and `JSON.parse`. `MemoryStore`
  stores strings on purpose, so a violation fails fast. Don't work around it.
- **Use the shared types.** Wire types (`GameView`, `ErrorResponse`, `ErrorCode`…) live in
  `@gs/sdk` and are used by both the server and the client. Narrow `GameView` on `status` before
  reading `state`: a lobby has no state. Never cast that away.

## Modifying the server (`packages/server`)

- **`core/` is transport-agnostic.** `GameManager` must not know about HTTP, Hono or SSE. Transport
  code goes in `http/`, which turns `GameError`s into responses in one place (`app.onError`).
- **Every write to a game goes through `#withLock`.** Load, validate, compute and commit inside the
  same locked callback, using the `tx` it is given: `tx.load()` then `tx.commit(next)`. `tx` is the
  only way to commit, and it refuses once the lock is released or for another game's record (see
  `core/locks.ts`). Don't call `#store.put` directly; `create()` is the one exception, for a
  brand-new id. `get()` takes the read lock, so it waits for writes in progress and
  runs alongside other reads. Never call `get()` from inside a write on the same game: it would wait
  for itself.
- **Every outgoing state goes through the game's `view`.** That covers responses, SSE and anything
  new you add. Never send the raw record: key hashes, the seed and the move log stay server-side.
  The tests assert this; keep them passing and extend them for new endpoints.
- **Treat game code as untrusted input to the engine.** Call `parseConfig` and `parseMove` before
  using client input, and `assertJson` whatever a game returns, exactly as the existing paths do.
- **Errors are `GameError(ErrorCode.X, message)`.** Pick the code by meaning (`CONFLICT` for wrong
  status or version, `NOT_YOUR_TURN`, `INVALID_MOVE`…). Use `INTERNAL` only for bugs, since its
  message is hidden from clients. A new code needs an HTTP status in `STATUS_BY_CODE`.
- **Keep the wire API stable.** Changing a route, status code, error body or event format breaks
  clients. If you must, update `@gs/client`, the README API table and the HTTP tests in the same
  change.
- **Test with fixtures, not real games.** Server tests use the throwaway games in
  `packages/server/test/fixtures/games.ts`. Add a fixture when you need a new behaviour; never import
  a game from `games/`.

## Creating a new game

1. **Scaffold** `games/<name>/` with `src/index.ts` and `test/rules.test.ts`, plus a `package.json`
   named `@gs/game-<name>` with `"type": "module"`, `"exports": "./src/index.ts"` and one dependency,
   `"@gs/sdk": "*"`. Copy `games/two-thirds` or `games/tic-tac-toe` as a starting point. Run
   `npm install` so the workspace link exists.
2. **Pick the shape.**
   - Players take turns → `defineGame` (see `games/tic-tac-toe`).
   - Everyone decides, then the round resolves → `defineSimultaneousGame` (see `games/two-thirds`).
     Don't hand-roll pending decisions; the helper already hides them and tracks who it's waiting on.
3. **Keep it pure.** The game contains only functions of their arguments:
   - No I/O, no `Date.now()`, no `Math.random()`, no module-level mutable state.
   - Time comes in as `now`; store any timestamps you need in state.
   - Randomness comes from `setup`'s `seed`. Keep the RNG state inside the game state so replays are
     deterministic.
4. **Validate in `parseMove` / `parseDecision`,** both shape and legality in the current state (for
   example, that the cell is empty). They return `err(message)` and never throw. `applyMove` then
   receives a typed move.
5. **Declare config honestly.** Implement `parseConfig` with sensible defaults when `input` is
   `undefined`, or use `noConfig`.
6. **Hidden information needs `view`.** If any player shouldn't see part of the state (hands, secret
   picks, pending decisions), implement `view(state, viewer)` and test it for another player *and*
   for a spectator (`viewer === null`). The default view exposes everything. `activePlayers` is
   public too, so don't leak secrets through it.
7. **Time limits** use `deadline` and `onDeadline` together (the registry rejects one without the
   other). With `defineSimultaneousGame`, use `timeLimitMs` instead. `onDeadline` must move the
   deadline forward or clear it.
8. **Use `type` aliases, not `interface`,** for state and config, so TypeScript can check them
   against `Json`.
9. **Test the rules directly** in `test/rules.test.ts`: call `parseConfig`, `setup`, then
   `parseMove` and `applyMove` in that order, as the server does. Cover wins, draws, illegal moves,
   turn order and every branch of `view`. Game tests may import only `@gs/sdk` and `node:*`.
10. **Wire it up** in `apps/dev-server`: add the package to its `package.json`, register it in
    `src/app.ts`, and add an end-to-end test under `apps/dev-server/test/` that plays a game over
    HTTP with `@gs/client`.
11. **Document it** with a row in the README layout table.

## Commits and PRs

Keep commits small and readable, one idea each. Review fixes go in new commits titled
`Address review: …`, not amended into old ones. The PRs are a stack managed with `gh stack`: push
with `gh stack push`, not plain `git push`.
