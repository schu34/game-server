import { pino } from 'pino';
import pretty from 'pino-pretty';
import { buildServer } from './app.ts';

const port = Number(process.env.PORT ?? 3000);

// Readable lines in a terminal; JSON lines otherwise (piped, or in production), for log tools to parse.
const level = process.env.LOG_LEVEL ?? 'info';
const logger = process.stdout.isTTY ? pino({ level }, pretty({ translateTime: 'HH:MM:ss.l' })) : pino({ level });

const { server, manager } = buildServer({ logger });

// No-op with an empty MemoryStore, but required once games are restored from a snapshot or a DB.
await manager.restoreTimers();

server.listen(port, () => {
  logger.info(
    { port, gameTypes: manager.registry.list().map((g) => g.type) },
    `Game server listening on http://localhost:${port}`,
  );
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    logger.info({ signal }, 'shutting down');
    manager.close();
    server.close();
    server.closeAllConnections();
  });
}
