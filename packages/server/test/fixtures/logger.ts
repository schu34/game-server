import { pino } from 'pino';

export type LogEntry = { level: number; msg: string; [field: string]: unknown };

/** A logger that keeps every entry in memory, as parsed JSON, so tests can assert on them. */
export function captureLogger(level = 'debug') {
  const entries: LogEntry[] = [];
  const logger = pino({ level }, { write: (line: string) => void entries.push(JSON.parse(line) as LogEntry) });
  return { logger, entries };
}

export const LEVEL = { debug: 20, info: 30, warn: 40, error: 50 } as const;
