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
| `packages/server` (`@gs/server`) | Engine (`core/`) + HTTP/SSE transport (`http/`) | `@gs/sdk`, `node:*` |
| `packages/client` (`@gs/client`) | Generic fetch/SSE client | `@gs/sdk` |
| `games/tic-tac-toe` | POC game | `@gs/sdk` (its `cli/` may also use `@gs/client`) |
| `apps/dev-server` | Wires games into the server | anything |

`scripts/check-boundaries.ts` enforces these rules on every `npm test`. The server is tested only against
throwaway fixture games (`packages/server/test/fixtures`), never against a real game.

## Writing a game

A game is pure functions over JSON state (`GameDefinition` in `packages/sdk/src/index.ts`):

- `setup({ players, config, seed })` → initial state
- `applyMove(state, move, player)` → `ok(nextState)` | `err(message)` — validates untrusted input; the only transition
- `activePlayers(state)` → who may act now (several players = a simultaneous phase)
- `outcome(state)` → `null` | `{ winners }` | `{ draw: true }`
- `view?(state, viewer)` → redacted state. **Required for any game with hidden information.**
- `parseConfig?(input)` → validated config

Simultaneous moves: keep commitments in state (e.g. `pending[player]`), list uncommitted players in
`activePlayers`, resolve inside `applyMove` when the last one arrives, and hide `pending` in `view`.
See `secretPickGame` in the server test fixtures.

Register the game in `apps/dev-server/src/app.ts`.

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
`@gs/client`, turn timers, and removing finished or abandoned games.
