# games-server

A generic, multi-game, turn-based game server for Node.js (TypeScript, run natively by Node ≥ 24 — no build step).
Tic-tac-toe ships as a proof-of-concept game plugin.

```
npm install
npm test          # boundary check + unit + HTTP + e2e tests
npm run typecheck
npm run dev       # server on :3000 (PORT to override)
npm run demo      # two bots play tic-tac-toe against the running server
```

## Layout & dependency rules

| Package | Purpose | May import |
|---|---|---|
| `packages/sdk` (`@gs/sdk`) | Game contract + wire types | nothing |
| `packages/server` (`@gs/server`) | Engine (`core/`) + HTTP/SSE transport on [Hono](https://hono.dev) (`http/`) | `@gs/sdk`, `node:*`; `http/` may also use `hono` |
| `packages/client` (`@gs/client`) | Generic fetch/SSE client | `@gs/sdk` |
| `games/tic-tac-toe` | POC game | `@gs/sdk` (its `cli/` may also use `@gs/client`) |
| `apps/dev-server` | Wires games into the server | anything |

`scripts/check-boundaries.ts` enforces these rules on every `npm test`. The server is tested only against
throwaway fixture games (`packages/server/test/fixtures`), never against a real game.

## Writing a game

A game is pure functions over JSON state (`GameDefinition<TState, TMove, TConfig>` in `packages/sdk/src/index.ts`):

- `setup({ players, config, seed, now })` → initial state
- `parseMove(input, state, player)` → `ok(move)` | `err(message)` — validates an untrusted move from a client into a typed `TMove`
- `applyMove(state, move, player, { now })` → `ok(nextState)` | `err(message)` — applies a parsed move; the main transition
- `activePlayers(state)` → who may act now (several players = a simultaneous phase)
- `outcome(state)` → `null` | `{ winners }` | `{ draw: true }`
- `view?(state, viewer)` → redacted state. **Required for any game with hidden information.**
- `parseConfig(input)` → validated config (`undefined` if none was sent); use `noConfig` if the game takes none
- `deadline?(state)` / `onDeadline?(state, { now })` → timing primitives (below)

Register the game in `apps/dev-server/src/app.ts`.

### Timing primitives

Games never read clocks. The server passes `now` into `setup` and `applyMove`, and games store timestamps in state.
To act when time runs out, a game implements both:

- `deadline(state)` → epoch ms when it next needs attention, or `null`
- `onDeadline(state, { now })` → the next state (skip a turn, auto-resolve a round, forfeit a player…)

The server arms a timer from `deadline(state)` after every change, so a move that pushes the deadline back cancels
the old one. Because the deadline comes from state, the server can rebuild every timer after a restart:
call `manager.restoreTimers()` at startup. Clients see the current deadline as `GameView.deadline` for countdowns.

## HTTP API

Player keys are issued once at join time; send them as `Authorization: Bearer <key>`. Only the key's hash is stored.

| Request | Auth | |
|---|---|---|
| `GET /game-types` | | registered games |
| `POST /games` `{type, config?}` | | create (lobby) |
| `POST /games/:id/players` `{name}` | | join → `{playerId, key, game}`; auto-starts when full |
| `POST /games/:id/start` | key | start early (≥ minPlayers) |
| `GET /games/:id[?since=N]` | optional | game view; `{unchanged:true}` if version ≤ N |
| `POST /games/:id/moves` `{move, expectedVersion?}` | key | submit a move |
| `GET /games/:id/events` | | SSE stream of spectator views (`id:` = version; honours `Last-Event-ID`) |

Errors are `{error: {code, message}}`: 400 invalid request/move, 401 bad key, 403 not your turn, 404, 409 wrong
status/version. Don't use `expectedVersion` in simultaneous-move games: players submitting at the same time would
get 409s from each other.

## Storage

`GameStore` is async so a database store can replace `MemoryStore` later. `MemoryStore` keeps records as
JSON strings, so a game that returns non-serializable state fails immediately. `snapshot()` and
`MemoryStore.fromSnapshot()` save and restore all games. The manager runs operations on one game one at a time.

## Not in v1

Persistent accounts, per-player SSE streams (needs a query-string token), automatic SSE reconnection in
`@gs/client`, and removing finished or abandoned games.
