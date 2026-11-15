import type { ErrorCode, ErrorResponse, GameTypeInfo, GameView, JoinResponse } from '@gs/sdk';

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

export type Subscription = {
  /** Stop listening. */
  close(): void;
  /** Resolves (never rejects) when the stream ends, closed by either side. */
  done: Promise<void>;
};

/**
 * Generic HTTP client for the game server. Game-agnostic: `state` and `move` are plain JSON.
 * Use one client per player; `join` remembers the player's key for later calls.
 */
export class GameClient {
  readonly baseUrl: string;
  key: string | undefined;
  playerId: string | undefined;

  constructor(baseUrl: string, options: { key?: string; playerId?: string } = {}) {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.key = options.key;
    this.playerId = options.playerId;
  }

  async gameTypes(): Promise<GameTypeInfo[]> {
    return (await this.#request<{ gameTypes: GameTypeInfo[] }>('GET', '/game-types')).gameTypes;
  }

  async create(type: string, config?: unknown): Promise<GameView> {
    return this.#request('POST', '/games', { type, config });
  }

  async join(gameId: string, name: string): Promise<JoinResponse> {
    const response = await this.#request<JoinResponse>('POST', `/games/${enc(gameId)}/players`, { name });
    this.key = response.key;
    this.playerId = response.playerId;
    return response;
  }

  async start(gameId: string): Promise<GameView> {
    return this.#request('POST', `/games/${enc(gameId)}/start`, {});
  }

  async move(gameId: string, move: unknown, options: { expectedVersion?: number } = {}): Promise<GameView> {
    return this.#request('POST', `/games/${enc(gameId)}/moves`, { move, ...options });
  }

  /** Get the game. With `since`, returns null if nothing changed after that version. */
  async get(gameId: string, options: { since?: number } = {}): Promise<GameView | null> {
    const query = options.since === undefined ? '' : `?since=${options.since}`;
    const result = await this.#request<GameView | { unchanged: true }>('GET', `/games/${enc(gameId)}${query}`);
    return 'unchanged' in result ? null : result;
  }

  /**
   * Stream public (spectator) game states over SSE. The current state is delivered first.
   * Resolves once the stream is connected; rejects if the game doesn't exist.
   */
  async subscribe(gameId: string, onState: (game: GameView) => void): Promise<Subscription> {
    const controller = new AbortController();
    const response = await fetch(`${this.baseUrl}/games/${enc(gameId)}/events`, {
      headers: { accept: 'text/event-stream' },
      signal: controller.signal,
    });
    if (!response.ok || !response.body) throw await toError(response);

    const done = (async () => {
      let buffer = '';
      try {
        for await (const chunk of response.body!.pipeThrough(new TextDecoderStream())) {
          buffer += chunk.replace(/\r\n?/g, '\n');
          let boundary: number;
          while ((boundary = buffer.indexOf('\n\n')) !== -1) {
            const event = parseEvent(buffer.slice(0, boundary));
            buffer = buffer.slice(boundary + 2);
            if (event?.event === 'state') onState(JSON.parse(event.data) as GameView);
          }
        }
      } catch {
        // Aborted by close(), or the connection dropped. Either way the stream is over;
        // callers can re-subscribe (the current state is always sent first).
      }
    })();

    return { close: () => controller.abort(), done };
  }

  async #request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const headers: Record<string, string> = {};
    if (body !== undefined) headers['content-type'] = 'application/json';
    if (this.key) headers.authorization = `Bearer ${this.key}`;
    const response = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (!response.ok) throw await toError(response);
    return (await response.json()) as T;
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

function parseEvent(block: string): { event: string; data: string; id?: string } | null {
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
