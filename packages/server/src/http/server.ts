import type { Server } from 'node:http';
import { createAdaptorServer } from '@hono/node-server';
import { Hono, type Context } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { cors } from 'hono/cors';
import { streamSSE } from 'hono/streaming';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
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

const STATUS_BY_CODE: Record<ErrorCode, ContentfulStatusCode> = {
  [ErrorCode.INVALID_REQUEST]: 400,
  [ErrorCode.INVALID_MOVE]: 400,
  [ErrorCode.UNAUTHORIZED]: 401,
  [ErrorCode.NOT_YOUR_TURN]: 403,
  [ErrorCode.NOT_FOUND]: 404,
  [ErrorCode.CONFLICT]: 409,
  [ErrorCode.INTERNAL]: 500,
};

/** Create a Node HTTP server exposing the generic game API. Call `.listen()` on the result. */
export function createGameServer(options: GameServerOptions): { server: Server; manager: GameManager } {
  const manager = new GameManager({ registry: options.registry, ...(options.store ? { store: options.store } : {}) });
  const app = createGameApp(manager, options);
  return { server: createAdaptorServer({ fetch: app.fetch }) as Server, manager };
}

/** The API as a Hono app, for mounting into another Hono app or any fetch-based runtime. */
export function createGameApp(
  manager: GameManager,
  { maxBodyBytes = 64 * 1024, heartbeatMs = 15_000, onError = console.error }: Omit<GameServerOptions, 'registry' | 'store'> = {},
): Hono {
  const app = new Hono();

  // Keys travel in the Authorization header (never cookies), so a wildcard origin is safe.
  app.use(
    cors({
      origin: '*',
      allowMethods: ['GET', 'POST', 'OPTIONS'],
      allowHeaders: ['authorization', 'content-type', 'last-event-id'],
      maxAge: 86400,
    }),
  );
  app.use(
    bodyLimit({
      maxSize: maxBodyBytes,
      onError: (c) => c.json(errorBody(ErrorCode.INVALID_REQUEST, `Request body exceeds ${maxBodyBytes} bytes`), 400),
    }),
  );

  app.get('/game-types', (c) => c.json({ gameTypes: manager.registry.list() }));

  app.post('/games', async (c) => {
    const body = await jsonObject(c);
    if (typeof body.type !== 'string') throw new GameError(ErrorCode.INVALID_REQUEST, '"type" is required');
    return c.json(await manager.create(body.type, body.config), 201);
  });

  app.post('/games/:id/players', async (c) => {
    const body = await jsonObject(c);
    return c.json(await manager.join(c.req.param('id'), body.name), 201);
  });

  app.post('/games/:id/start', async (c) => c.json(await manager.start(c.req.param('id'), bearer(c))));

  app.get('/games/:id', async (c) => {
    const game = await manager.get(c.req.param('id'), bearer(c));
    const since = c.req.query('since');
    if (since !== undefined && Number.isFinite(Number(since)) && game.version <= Number(since)) {
      return c.json({ unchanged: true, version: game.version });
    }
    return c.json(game);
  });

  app.post('/games/:id/moves', async (c) => {
    const body = await jsonObject(c);
    if (!('move' in body)) throw new GameError(ErrorCode.INVALID_REQUEST, '"move" is required');
    const { expectedVersion } = body;
    if (expectedVersion !== undefined && !Number.isInteger(expectedVersion)) {
      throw new GameError(ErrorCode.INVALID_REQUEST, '"expectedVersion" must be an integer');
    }
    const moveOptions = expectedVersion === undefined ? {} : { expectedVersion: expectedVersion as number };
    return c.json(await manager.move(c.req.param('id'), bearer(c), body.move, moveOptions));
  });

  app.get('/games/:id/events', (c) => streamEvents(c, manager, heartbeatMs));

  // Known paths with the wrong method get a 405 rather than falling through to a 404.
  for (const path of ['/game-types', '/games', '/games/:id', '/games/:id/players', '/games/:id/start', '/games/:id/moves', '/games/:id/events']) {
    app.all(path, (c) => c.json(errorBody(ErrorCode.INVALID_REQUEST, 'Method not allowed'), 405));
  }
  app.notFound((c) => c.json(errorBody(ErrorCode.NOT_FOUND, 'Route not found'), 404));

  app.onError((error, c) => {
    if (error instanceof GameError && error.code !== ErrorCode.INTERNAL) {
      return c.json(errorBody(error.code, error.message), STATUS_BY_CODE[error.code]);
    }
    onError(error);
    return c.json(errorBody(ErrorCode.INTERNAL, 'Internal server error'), 500);
  });

  return app;
}

/**
 * Stream a game's public view: the current state on connect, then every change.
 * Spectator view only, because EventSource can't send an Authorization header.
 */
async function streamEvents(c: Context, manager: GameManager, heartbeatMs: number): Promise<Response> {
  const gameId = c.req.param('id')!;
  await manager.get(gameId); // 404 before we commit to a stream

  const lastEventId = Number(c.req.header('last-event-id'));
  c.header('x-accel-buffering', 'no');

  return streamSSE(c, async (stream) => {
    let lastSent = Number.isInteger(lastEventId) ? lastEventId : -1;
    let queue = Promise.resolve();

    // Sends are queued so events go out in order; stale versions are skipped.
    const push = () => {
      queue = queue
        .then(async () => {
          if (stream.aborted) return;
          const game = await manager.get(gameId);
          if (stream.aborted || game.version <= lastSent) return;
          lastSent = game.version;
          await stream.writeSSE({ id: String(game.version), event: 'state', data: JSON.stringify(game) });
        })
        .catch(() => {});
    };

    const unsubscribe = manager.onChange(gameId, push);
    const heartbeat = setInterval(() => void stream.write(': ping\n\n'), heartbeatMs);
    heartbeat.unref();
    push();

    // Keep the stream open until the client goes away.
    await new Promise<void>((resolve) => stream.onAbort(resolve));
    unsubscribe();
    clearInterval(heartbeat);
  });
}

// ---------------------------------------------------------------------------

/** The bearer token, '' if the header is malformed, or undefined if there is none. */
function bearer(c: Context): string | undefined {
  const header = c.req.header('authorization');
  if (!header) return undefined;
  return /^Bearer\s+(\S+)$/i.exec(header)?.[1] ?? '';
}

/** The request body as a JSON object. An empty body counts as `{}`. */
async function jsonObject(c: Context): Promise<Record<string, unknown>> {
  const text = await c.req.text();
  if (!text) return {};
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new GameError(ErrorCode.INVALID_REQUEST, 'Request body must be valid JSON');
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new GameError(ErrorCode.INVALID_REQUEST, 'Request body must be a JSON object');
  }
  return value as Record<string, unknown>;
}

function errorBody(code: ErrorCode, message: string): ErrorResponse {
  return { error: { code, message } };
}
