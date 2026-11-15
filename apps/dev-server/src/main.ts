import { buildServer } from './app.ts';

const port = Number(process.env.PORT ?? 3000);
const { server, manager } = buildServer();

server.listen(port, () => {
  console.log(`Game server listening on http://localhost:${port}`);
  console.log(`Game types: ${manager.registry.list().map((g) => g.type).join(', ')}`);
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    server.close();
    server.closeAllConnections();
  });
}
