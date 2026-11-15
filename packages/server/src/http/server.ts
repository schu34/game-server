import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { ErrorCode, type ErrorResponse } from '@gs/sdk';
import { GameError } from '../core/errors.ts';
import { GameManager } from '../core/manager.ts';
import type { GameRegistry } from '../core/registry.ts';
import type { GameStore } from '../core/store.ts';

export type GameServerOptions = {
  registry: GameRegistry;
  store?: GameStore;
  /** Max JSON request body size in bytes. Default 64 KiB. */
  maxBodyBytes?: number;
  /** SSE heartbeat interval in ms. Default 15s. */
  heartbeatMs?: number;
  /** Called for unexpected (500) errors. Default: console.error. */
  onError?: (error: unknown) => void;
};

const STATUS_BY_CODE: Record<ErrorCode, number> = {
  [ErrorCode.INVALID_REQUEST]: 400,
  [ErrorCode.INVALID_MOVE]: 400,
  [ErrorCode.UNAUTHORIZED]: 401,
  [ErrorCode.NOT_YOUR_TURN]: 403,
  [ErrorCode.NOT_FOUND]: 404,
  [ErrorCode.CONFLICT]: 409,
  [ErrorCode.INTERNAL]: 500,
};

type Context = {
  req: IncomingMessage;
  res: ServerResponse;
  url: URL;
  params: string[];
};
type Route = { method: string; pattern: RegExp; handler: (ctx: Context) => Promise<void> };

/** Create an HTTP server exposing the generic game API. Call `.listen()` on the result. */
export function createGameServer(options: GameServerOptions): { server: Server; manager: GameManager } {
  const manager = new GameManager({ registry: options.registry, ...(options.store ? { store: options.store } : {}) });
  const handler = createRequestHandler(manager, options);
  return { server: createServer(handler), manager };
}

/** The request handler on its own, for mounting into an existing Node HTTP server. */
export function createRequestHandler(
  manager: GameManager,
  { maxBodyBytes = 64 * 1024, heartbeatMs = 15_000, onError = console.error }: Omit<GameServerOptions, 'registry' | 'store'> = {},
): (req: IncomingMessage, res: ServerResponse) => void {
  const routes: Route[] = [
    {
      method: 'GET',
      pattern: /^\/game-types$/,
      handler: async ({ res }) => sendJson(res, 200, { gameTypes: manager.registry.list() }),
    },
    {
      method: 'POST',
      pattern: /^\/games$/,
      handler: async ({ req, res }) => {
        const body = asObject(await readJson(req, maxBodyBytes));
        if (typeof body.type !== 'string') throw new GameError(ErrorCode.INVALID_REQUEST, '"type" is required');
        sendJson(res, 201, await manager.create(body.type, body.config));
      },
    },
    {
      method: 'POST',
      pattern: /^\/games\/([^/]+)\/players$/,
      handler: async ({ req, res, params }) => {
        const body = asObject(await readJson(req, maxBodyBytes));
        sendJson(res, 201, await manager.join(params[0]!, body.name));
      },
    },
    {
      method: 'POST',
      pattern: /^\/games\/([^/]+)\/start$/,
      handler: async ({ req, res, params }) => sendJson(res, 200, await manager.start(params[0]!, bearer(req))),
    },
    {
      method: 'GET',
      pattern: /^\/games\/([^/]+)$/,
      handler: async ({ req, res, url, params }) => {
        const game = await manager.get(params[0]!, bearer(req));
        const since = url.searchParams.get('since');
        if (since !== null && Number.isFinite(Number(since)) && game.version <= Number(since)) {
          sendJson(res, 200, { unchanged: true, version: game.version });
        } else {
          sendJson(res, 200, game);
        }
      },
    },
    {
      method: 'POST',
      pattern: /^\/games\/([^/]+)\/moves$/,
      handler: async ({ req, res, params }) => {
        const body = asObject(await readJson(req, maxBodyBytes));
        if (!('move' in body)) throw new GameError(ErrorCode.INVALID_REQUEST, '"move" is required');
        const { expectedVersion } = body;
        if (expectedVersion !== undefined && !Number.isInteger(expectedVersion)) {
          throw new GameError(ErrorCode.INVALID_REQUEST, '"expectedVersion" must be an integer');
        }
        const moveOptions = expectedVersion === undefined ? {} : { expectedVersion: expectedVersion as number };
        sendJson(res, 200, await manager.move(params[0]!, bearer(req), body.move, moveOptions));
      },
    },
    {
      method: 'GET',
      pattern: /^\/games\/([^/]+)\/events$/,
      handler: async (ctx) => streamEvents(manager, ctx, heartbeatMs),
    },
  ];

  return (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    // Keys travel in the Authorization header (never cookies), so a wildcard origin is safe.
    res.setHeader('access-control-allow-origin', '*');
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'access-control-allow-methods': 'GET, POST, OPTIONS',
        'access-control-allow-headers': 'authorization, content-type, last-event-id',
        'access-control-max-age': '86400',
      });
      res.end();
      return;
    }

    let pathMatched = false;
    for (const route of routes) {
      const match = route.pattern.exec(url.pathname);
      if (!match) continue;
      pathMatched = true;
      if (route.method !== req.method) continue;
      const params = match.slice(1).map((p) => decodeURIComponent(p));
      route.handler({ req, res, url, params }).catch((error: unknown) => sendError(res, error, onError));
      return;
    }
    if (pathMatched) sendJson(res, 405, errorBody(ErrorCode.INVALID_REQUEST, 'Method not allowed'));
    else sendJson(res, 404, errorBody(ErrorCode.NOT_FOUND, 'Route not found'));
  };
}

async function streamEvents(manager: GameManager, { req, res, params }: Context, heartbeatMs: number): Promise<void> {
  const gameId = params[0]!;
  await manager.get(gameId); // 404 before we commit to a stream

  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  });

  const lastEventId = Number(req.headers['last-event-id']);
  let lastSent = Number.isInteger(lastEventId) ? lastEventId : -1;
  let queue = Promise.resolve();
  let closed = false;

  // Sends are queued so events go out in order; stale versions are skipped.
  // Spectator (public) view only: EventSource can't send an Authorization header.
  const push = () => {
    queue = queue
      .then(async () => {
        if (closed) return;
        const game = await manager.get(gameId);
        if (closed || game.version <= lastSent) return;
        lastSent = game.version;
        res.write(`id: ${game.version}\nevent: state\ndata: ${JSON.stringify(game)}\n\n`);
      })
      .catch(() => {});
  };

  const unsubscribe = manager.onChange(gameId, push);
  const heartbeat = setInterval(() => res.write(': ping\n\n'), heartbeatMs);
  heartbeat.unref();
  res.on('close', () => {
    closed = true;
    unsubscribe();
    clearInterval(heartbeat);
  });
  push();
}

// ---------------------------------------------------------------------------

function bearer(req: IncomingMessage): string | undefined {
  const header = req.headers.authorization;
  if (!header) return undefined;
  const match = /^Bearer\s+(\S+)$/i.exec(header);
  return match?.[1] ?? '';
}

async function readJson(req: IncomingMessage, limit: number): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > limit) throw new GameError(ErrorCode.INVALID_REQUEST, `Request body exceeds ${limit} bytes`);
    chunks.push(chunk);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new GameError(ErrorCode.INVALID_REQUEST, 'Request body must be valid JSON');
  }
}

function asObject(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new GameError(ErrorCode.INVALID_REQUEST, 'Request body must be a JSON object');
  }
  return value as Record<string, unknown>;
}

function errorBody(code: ErrorCode, message: string): ErrorResponse {
  return { error: { code, message } };
}

function sendError(res: ServerResponse, error: unknown, onError: (error: unknown) => void): void {
  if (error instanceof GameError && error.code !== ErrorCode.INTERNAL) {
    sendJson(res, STATUS_BY_CODE[error.code], errorBody(error.code, error.message));
    return;
  }
  onError(error);
  if (res.headersSent) res.end();
  else sendJson(res, 500, errorBody(ErrorCode.INTERNAL, 'Internal server error'));
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(payload) });
  res.end(payload);
}
