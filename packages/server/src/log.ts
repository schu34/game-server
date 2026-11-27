import { pino, type Logger } from 'pino';

export type { Logger };

/**
 * The logger used when none is passed in: JSON lines on stdout, at `LOG_LEVEL` (default `info`).
 * Pass your own (for example with pino-pretty, or a different destination) through the options.
 *
 * What gets logged, by level:
 * - error: unexpected failures (500s, deadline handlers that throw), with stacks.
 * - warn:  things that went wrong but were handled (a push to a live stream failing).
 * - info:  games starting and finishing, requests rejected with a 4xx, periodic stats.
 * - debug: every request, game created, player joined, each move and deadline, streams opening and closing.
 *
 * Never logged: player keys, the Authorization header, and move contents (a move can be a secret).
 */
export function defaultLogger(): Logger {
  return pino({ level: process.env.LOG_LEVEL ?? 'info' });
}
