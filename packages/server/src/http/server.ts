import { randomUUID } from 'node:crypto';
import type { Server } from 'node:http';
import { monitorEventLoopDelay, performance } from 'node:perf_hooks';
import { createAdaptorServer } from '@hono/node-server';
import { Hono, type Context } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { cors } from 'hono/cors';
import { routePath } from 'hono/route';
import { streamSSE } from 'hono/streaming';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { ErrorCode, type ErrorResponse } from '@gs/sdk';
import { GameError } from '../core/errors.ts';
import { GameManager } from '../core/manager.ts';
import type { GameRegistry } from '../core/registry.ts';
import type { GameStore } from '../core/store.ts';
import { defaultLogger, type Logger } from '../log.ts';

export type GameServerOptions = {
  registry: GameRegistry;
  store?: GameStore;
  /** Max JSON request body size in bytes. Default 64 KiB. */
  maxBodyBytes?: number;
  /** SSE heartbeat interval in ms. Default 15s. */
  heartbeatMs?: number;
  /** Where requests, game events and errors are logged. Default: JSON on stdout at LOG_LEVEL (see `defaultLogger`). */
  logger?: Logger;
  /** How often to log a stats line (requests, streams, games, event-loop delay, memory), in ms. 0 turns it off. Default 10s. */
  statsIntervalMs?: number;
};

/** Counters the HTTP layer keeps for the stats line. */
export type HttpMetrics = {
  requests: { '2xx': number; '3xx': number; '4xx': number; '5xx': number };
  streamsOpen: number;
};

const newMetrics = (): HttpMetrics => ({ requests: { '2xx': 0, '3xx': 0, '4xx': 0, '5xx': 0 }, streamsOpen: 0 });

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
  const logger = options.logger ?? defaultLogger();
  const manager = new GameManager({
    registry: options.registry,
    ...(options.store ? { store: options.store } : {}),
    logger,
  });
  const metrics = newMetrics();
  const app = createGameApp(manager, { ...options, logger, metrics });
  const server = createAdaptorServer({ fetch: app.fetch }) as Server;

  const intervalMs = options.statsIntervalMs ?? 10_000;
  if (intervalMs > 0) {
    const stop = logStats(logger, manager, metrics, intervalMs);
    server.on('close', stop);
  }
  return { server, manager };
}

/** Log a stats line every `intervalMs`: rates since the last line, plus current gauges. Returns a stop function. */
function logStats(logger: Logger, manager: GameManager, metrics: HttpMetrics, intervalMs: number): () => void {
  const resolutionMs = 20;
  const loopDelay = monitorEventLoopDelay({ resolution: resolutionMs });
  loopDelay.enable();
  // Each sample includes the sampling interval itself; subtract it so an idle server reads 0.
  const delayMs = (nanoseconds: number) => Math.max(0, Math.round((nanoseconds / 1e6 - resolutionMs) * 10) / 10);
  let last = {
    requests: { ...metrics.requests },
    games: manager.counters,
    at: performance.now(),
    elu: performance.eventLoopUtilization(),
  };

  const timer = setInterval(() => {
    const now = performance.now();
    const seconds = (now - last.at) / 1000;
    const games = manager.counters;
    const requests = Object.fromEntries(
      Object.entries(metrics.requests).map(([k, n]) => [k, n - last.requests[k as keyof HttpMetrics['requests']]]),
    );
    const total = Object.values(requests).reduce((a, b) => a + b, 0);
    const memory = process.memoryUsage();
    logger.info(
      {
        requestsPerSec: Math.round(total / seconds),
        requests,
        streamsOpen: metrics.streamsOpen,
        games: {
          started: games.started - last.games.started,
          finished: games.finished - last.games.finished,
          moves: games.moves - last.games.moves,
          deadlines: games.deadlines - last.games.deadlines,
          inProgress: games.started - games.finished,
        },
        // Share of the interval the event loop was busy: near 1 means the server is saturated.
        eventLoopUtilization: Math.round(performance.eventLoopUtilization(last.elu).utilization * 100) / 100,
        eventLoopDelayMs: {
          p50: delayMs(loopDelay.percentile(50)),
          p99: delayMs(loopDelay.percentile(99)),
          max: delayMs(loopDelay.max),
        },
        memoryMb: { rss: mb(memory.rss), heapUsed: mb(memory.heapUsed) },
      },
      'stats',
    );
    loopDelay.reset();
    last = { requests: { ...metrics.requests }, games, at: now, elu: performance.eventLoopUtilization() };
  }, intervalMs);
  timer.unref();

  return () => {
    clearInterval(timer);
    loopDelay.disable();
  };
}

const mb = (bytes: number) => Math.round(bytes / 1024 / 1024);

/** The API as a Hono app, for mounting into another Hono app or any fetch-based runtime. */
export function createGameApp(
  manager: GameManager,
  {
    maxBodyBytes = 64 * 1024,
    heartbeatMs = 15_000,
    logger = defaultLogger(),
    metrics = newMetrics(),
  }: Omit<GameServerOptions, 'registry' | 'store' | 'statsIntervalMs'> & { metrics?: HttpMetrics } = {},
): Hono {
  const app = new Hono();

  // One log line per request. Never the headers (they carry keys) or bodies (moves can be secret).
  app.use(async (c, next) => {
    const start = performance.now();
    const requestId = randomUUID();
    c.header('x-request-id', requestId);
    await next();

    const { status } = c.res;
    metrics.requests[`${Math.min(5, Math.max(2, Math.floor(status / 100)))}xx` as keyof HttpMetrics['requests']] += 1;
    const error = c.error;
    const fields = {
      requestId,
      method: c.req.method,
      route: matchedRoute(c) ?? c.req.path, // the raw path only when no route matched (404s)
      gameId: /^\/games\/([^/]+)/.exec(c.req.path)?.[1],
      status,
      durationMs: Math.round((performance.now() - start) * 10) / 10,
      ...(error instanceof GameError ? { code: error.code } : {}),
      ...(status >= 500 && error ? { err: error } : {}),
    };
    if (status >= 500) logger.error(fields, 'request failed');
    else if (status >= 400) logger.info(fields, 'request rejected');
    else logger.debug(fields, 'request');
  });

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

  app.get('/games/:id/events', (c) => streamEvents(c, manager, heartbeatMs, logger, metrics));

  // Known paths with the wrong method get a 405 rather than falling through to a 404.
  for (const path of [
    '/game-types',
    '/games',
    '/games/:id',
    '/games/:id/players',
    '/games/:id/start',
    '/games/:id/moves',
    '/games/:id/events',
  ]) {
    app.all(path, (c) => c.json(errorBody(ErrorCode.INVALID_REQUEST, 'Method not allowed'), 405));
  }
  app.notFound((c) => c.json(errorBody(ErrorCode.NOT_FOUND, 'Route not found'), 404));

  // The request logger above logs the error (with its stack, for 500s).
  app.onError((error, c) => {
    if (error instanceof GameError && error.code !== ErrorCode.INTERNAL) {
      return c.json(errorBody(error.code, error.message), STATUS_BY_CODE[error.code]);
    }
    return c.json(errorBody(ErrorCode.INTERNAL, 'Internal server error'), 500);
  });

  return app;
}

/**
 * Stream a game's public view: the current state on connect, then every change.
 * Spectator view only, because EventSource can't send an Authorization header.
 */
async function streamEvents(
  c: Context,
  manager: GameManager,
  heartbeatMs: number,
  logger: Logger,
  metrics: HttpMetrics,
): Promise<Response> {
  const gameId = c.req.param('id')!;
  const { you } = await manager.get(gameId); // 404 before we commit to a stream
  const log = logger.child({ gameId, viewer: you ?? 'spectator' });

  const lastEventId = Number(c.req.header('last-event-id'));
  c.header('x-accel-buffering', 'no');

  return streamSSE(c, async (stream) => {
    let lastSent = Number.isInteger(lastEventId) ? lastEventId : -1;
    let queue = Promise.resolve();
    let sent = 0;
    const openedAt = performance.now();
    metrics.streamsOpen += 1;
    log.debug('stream opened');

    // Sends are queued so events go out in order; stale versions are skipped.
    const push = () => {
      queue = queue
        .then(async () => {
          if (stream.aborted) return;
          const game = await manager.get(gameId);
          if (stream.aborted || game.version <= lastSent) return;
          lastSent = game.version;
          await stream.writeSSE({ id: String(game.version), event: 'state', data: JSON.stringify(game) });
          sent += 1;
        })
        .catch((err: unknown) => {
          // Writing to a stream the client just closed fails; that's expected, not worth a warning.
          if (!stream.aborted) log.warn({ err }, 'stream push failed');
        });
    };

    const unsubscribe = manager.onChange(gameId, push);
    const heartbeat = setInterval(() => void stream.write(': ping\n\n'), heartbeatMs);
    heartbeat.unref();
    push();

    // Keep the stream open until the client goes away.
    await new Promise<void>((resolve) => stream.onAbort(resolve));
    unsubscribe();
    clearInterval(heartbeat);
    metrics.streamsOpen -= 1;
    log.debug({ sent, durationMs: Math.round(performance.now() - openedAt) }, 'stream closed');
  });
}

// ---------------------------------------------------------------------------

/** The route pattern that answered (`/games/:id/moves`, not the actual path), if any did. */
function matchedRoute(c: Context): string | undefined {
  try {
    const path = routePath(c);
    return path === '*' || path === '/*' ? undefined : path;
  } catch {
    return undefined;
  }
}

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
