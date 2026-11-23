/**
 * Generic HTTP + SSE client for the game server. It knows nothing about any game.
 *
 *   const server = new GameServer('http://localhost:3000');
 *   const { id } = await server.create('tic-tac-toe');
 *   const seat = await server.join<TicTacToeState, TicTacToeMove>(id, 'Ada');
 *   await seat.move({ cell: 4 });
 *
 * - `GameServer` has the calls that aren't about one game, and hands out the objects that are.
 * - `PlayerSession` is one player's seat in one game: it holds the key, so it can move, and it
 *   reads and streams that player's own view.
 * - `Spectator` reads and streams the public view of one game.
 *
 * Sessions are immutable: joining returns a new object rather than changing an existing one.
 *
 * The type parameters say what the game's view looks like and what a move looks like on the wire.
 * The server only sends JSON, so they are a claim the caller makes, not something the client checks.
 * - `TState` is what the game's `view` returns: its state, unless it defines `view`.
 * - `TMove` is what you send, i.e. the input to the game's `parseMove`. That can differ from the
 *   game's own move type, which is the parsed result.
 */
import type { ErrorCode, ErrorResponse, GameTypeInfo, GameView, JoinResponse, Json, PlayerId } from '@gs/sdk';

export class GameClientError extends Error {
  readonly status: number;
  readonly code: ErrorCode | 'HTTP_ERROR';

  constructor(status: number, code: ErrorCode | 'HTTP_ERROR', message: string) {
    super(message);
    this.name = 'GameClientError';
    this.status = status;
    this.code = code;
  }
}

/** What a player needs to act in a game again later, for example after a page reload. */
export type Seat = { playerId: PlayerId; key: string };

export type Subscription = {
  /** Stop listening. */
  close(): void;
  /** Resolves (never rejects) once the subscription is over: closed, or stopped by a permanent error. */
  done: Promise<void>;
};

export type SubscribeOptions = {
  /**
   * Called when the stream drops or a reconnect fails. Reconnecting continues afterwards, except
   * after a 401 or 404, which end the subscription.
   */
  onError?(error: GameClientError | Error): void;
  /** Wait between reconnect attempts, in ms. Default 1000. */
  retryMs?: number;
};

/** The calls that aren't about one game, and the way to get the objects that are. */
export class GameServer {
  readonly baseUrl: string;

  constructor(baseUrl: string) {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
  }

  async gameTypes(): Promise<GameTypeInfo[]> {
    return (await request<{ gameTypes: GameTypeInfo[] }>(this.baseUrl, undefined, 'GET', '/game-types')).gameTypes;
  }

  /** Create a game in the lobby. Join it to play. */
  async create(type: string, config?: Json): Promise<GameView> {
    return request(this.baseUrl, undefined, 'POST', '/games', { type, config });
  }

  /** Take a seat in a game. The session's key is the player's only credential: keep it to come back later. */
  async join<TState extends Json = Json, TMove extends Json = Json>(
    gameId: string,
    name: string,
  ): Promise<PlayerSession<TState, TMove>> {
    const { playerId, key } = await request<JoinResponse>(
      this.baseUrl,
      undefined,
      'POST',
      `/games/${enc(gameId)}/players`,
      {
        name,
      },
    );
    return new PlayerSession(this.baseUrl, gameId, { playerId, key });
  }

  /** A session for a seat taken earlier, from its saved `seat`. */
  session<TState extends Json = Json, TMove extends Json = Json>(
    gameId: string,
    seat: Seat,
  ): PlayerSession<TState, TMove> {
    return new PlayerSession(this.baseUrl, gameId, seat);
  }

  /** Watch a game without a seat. */
  spectate<TState extends Json = Json>(gameId: string): Spectator<TState> {
    return new Spectator(this.baseUrl, gameId);
  }
}

/** Reads and streams one game's public view. */
export class Spectator<TState extends Json = Json> {
  readonly baseUrl: string;
  readonly gameId: string;
  /** Sent with every request. Undefined for spectators. */
  protected readonly key: string | undefined;

  constructor(baseUrl: string, gameId: string, key?: string) {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.gameId = gameId;
    this.key = key;
  }

  /** The game now. With `since`, returns null if nothing changed after that version. */
  async get(options: { since?: number } = {}): Promise<GameView<TState> | null> {
    const query = options.since === undefined ? '' : `?since=${options.since}`;
    const result = await this.request<GameView<TState> | { unchanged: true }>('GET', `${this.path}${query}`);
    return 'unchanged' in result ? null : result;
  }

  /**
   * Stream the game: the current view first, then every change. If the connection drops, it
   * reconnects and carries on from the last version seen, and `onState` never sees a version
   * older than one it already had.
   *
   * Resolves once connected; rejects if the first connection fails (say, the game doesn't exist).
   */
  async subscribe(onState: (game: GameView<TState>) => void, options: SubscribeOptions = {}): Promise<Subscription> {
    const retryMs = options.retryMs ?? 1000;
    let closed = false;
    let lastVersion = -1;
    let controller = new AbortController();
    let wake: () => void = () => {};

    const deliver = (game: GameView<TState>) => {
      if (closed || game.version <= lastVersion) return;
      lastVersion = game.version;
      onState(game);
    };
    const connect = () => {
      controller = new AbortController();
      return openStream(this.baseUrl, this.key, this.gameId, lastVersion, controller.signal);
    };

    let stream = await connect(); // the first connection's errors go to the caller
    const done = (async () => {
      for (;;) {
        try {
          await readEvents(stream, (event) => {
            if (event.event === 'state') deliver(JSON.parse(event.data) as GameView<TState>);
          });
          if (closed) return;
          options.onError?.(new Error('Stream ended'));
        } catch (error) {
          if (closed) return;
          options.onError?.(error as Error);
        }

        // Reconnect until it works, the error is permanent, or we're closed.
        for (;;) {
          await new Promise<void>((resolve) => {
            const timer = setTimeout(resolve, retryMs);
            wake = () => (clearTimeout(timer), resolve()); // so close() doesn't wait out the delay
          });
          if (closed) return;
          try {
            stream = await connect();
            break;
          } catch (error) {
            if (closed) return;
            options.onError?.(error as Error);
            if (error instanceof GameClientError && (error.status === 401 || error.status === 404)) return;
          }
        }
      }
    })();

    return {
      close: () => {
        closed = true;
        controller.abort();
        wake();
      },
      done,
    };
  }

  protected get path(): string {
    return `/games/${enc(this.gameId)}`;
  }

  protected request<T>(method: string, path: string, body?: unknown): Promise<T> {
    return request<T>(this.baseUrl, this.key, method, path, body);
  }
}

/** One player's seat in one game. Reads and streams that player's own view. */
export class PlayerSession<TState extends Json = Json, TMove extends Json = Json> extends Spectator<TState> {
  readonly playerId: PlayerId;

  constructor(baseUrl: string, gameId: string, seat: Seat) {
    super(baseUrl, gameId, seat.key);
    this.playerId = seat.playerId;
  }

  /** What to save to come back to this seat later (see `GameServer.session`). Contains the key: keep it private. */
  get seat(): Seat {
    return { playerId: this.playerId, key: this.key! };
  }

  /** Start the game before it is full (once it has enough players). */
  async start(): Promise<GameView<TState>> {
    return this.request('POST', `${this.path}/start`, {});
  }

  async move(move: TMove, options: { expectedVersion?: number } = {}): Promise<GameView<TState>> {
    return this.request('POST', `${this.path}/moves`, { move, ...options });
  }
}

// ---------------------------------------------------------------------------

async function request<T>(
  baseUrl: string,
  key: string | undefined,
  method: string,
  path: string,
  body?: unknown,
): Promise<T> {
  const headers: Record<string, string> = {};
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (key) headers.authorization = `Bearer ${key}`;
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (!response.ok) throw await toError(response);
  return (await response.json()) as T;
}

async function openStream(
  baseUrl: string,
  key: string | undefined,
  gameId: string,
  lastVersion: number,
  signal: AbortSignal,
): Promise<ReadableStream<Uint8Array>> {
  const headers: Record<string, string> = { accept: 'text/event-stream' };
  if (key) headers.authorization = `Bearer ${key}`;
  if (lastVersion >= 0) headers['last-event-id'] = String(lastVersion);
  const response = await fetch(`${baseUrl}/games/${enc(gameId)}/events`, { headers, signal });
  if (!response.ok || !response.body) throw await toError(response);
  return response.body;
}

type SseEvent = { event: string; data: string; id?: string };

/** Read SSE events until the stream ends. A plain reader loop, so it works where streams aren't async-iterable. */
async function readEvents(body: ReadableStream<Uint8Array>, onEvent: (event: SseEvent) => void): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return;
      buffer += decoder.decode(value, { stream: true }).replace(/\r\n?/g, '\n');
      let boundary: number;
      while ((boundary = buffer.indexOf('\n\n')) !== -1) {
        const event = parseEvent(buffer.slice(0, boundary));
        buffer = buffer.slice(boundary + 2);
        if (event) onEvent(event);
      }
    }
  } finally {
    reader.releaseLock();
  }
}

function enc(value: string): string {
  return encodeURIComponent(value);
}

async function toError(response: Response): Promise<GameClientError> {
  try {
    const body = (await response.json()) as ErrorResponse;
    return new GameClientError(response.status, body.error.code, body.error.message);
  } catch {
    return new GameClientError(response.status, 'HTTP_ERROR', `HTTP ${response.status}`);
  }
}

function parseEvent(block: string): SseEvent | null {
  let event = 'message';
  const data: string[] = [];
  let id: string | undefined;
  for (const line of block.split('\n')) {
    if (!line || line.startsWith(':')) continue;
    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    const value = colon === -1 ? '' : line.slice(colon + 1).replace(/^ /, '');
    if (field === 'event') event = value;
    else if (field === 'data') data.push(value);
    else if (field === 'id') id = value;
  }
  if (data.length === 0) return null;
  return { event, data: data.join('\n'), ...(id === undefined ? {} : { id }) };
}
