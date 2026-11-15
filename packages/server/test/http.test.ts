import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { after, before, describe, it } from 'node:test';
import type { GameView } from '@gs/sdk';
import { createGameServer, GameRegistry } from '../src/index.ts';
import { counterGame, secretPickGame, type SecretPickState } from './fixtures/games.ts';

const { server } = createGameServer({
  registry: new GameRegistry().register(counterGame).register(secretPickGame),
  onError: () => {},
});
let base = '';

before(async () => {
  await new Promise<void>((resolve) => server.listen(0, resolve));
  base = `http://localhost:${(server.address() as AddressInfo).port}`;
});
after(() => {
  server.closeAllConnections();
  server.close();
});

async function call(method: string, path: string, { body, key }: { body?: unknown; key?: string } = {}) {
  const headers: Record<string, string> = {};
  if (key) headers.authorization = `Bearer ${key}`;
  if (body !== undefined) headers['content-type'] = 'application/json';
  const res = await fetch(base + path, { method, headers, body: typeof body === 'string' ? body : JSON.stringify(body) });
  return { status: res.status, body: (await res.json()) as any };
}

/** Minimal SSE reader for tests. */
async function openStream(path: string) {
  const controller = new AbortController();
  const res = await fetch(base + path, { signal: controller.signal });
  const reader = res.body!.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = '';
  return {
    status: res.status,
    headers: res.headers,
    async next(): Promise<{ id: string; data: GameView }> {
      for (;;) {
        const boundary = buffer.indexOf('\n\n');
        if (boundary !== -1) {
          const block = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          if (block.startsWith(':')) continue;
          const fields = Object.fromEntries(block.split('\n').map((l) => [l.slice(0, l.indexOf(':')), l.slice(l.indexOf(':') + 2)]));
          return { id: fields.id!, data: JSON.parse(fields.data!) };
        }
        const { value, done } = await reader.read();
        if (done) throw new Error('stream ended');
        buffer += value;
      }
    },
    close: () => controller.abort(),
  };
}

async function newCounterGame() {
  const created = await call('POST', '/games', { body: { type: 'counter', config: { target: 5 } } });
  const id = created.body.id as string;
  const ann = (await call('POST', `/games/${id}/players`, { body: { name: 'Ann' } })).body;
  const ben = (await call('POST', `/games/${id}/players`, { body: { name: 'Ben' } })).body;
  return { id, ann, ben, created };
}

describe('HTTP API', () => {
  it('lists game types', async () => {
    const { status, body } = await call('GET', '/game-types');
    assert.equal(status, 200);
    assert.deepEqual(body.gameTypes.map((g: { type: string }) => g.type), ['counter', 'secret-pick']);
  });

  it('plays a full game with correct status codes', async () => {
    const { id, ann, ben, created } = await newCounterGame();
    assert.equal(created.status, 201);
    assert.match(ann.key, /^[\w-]{43}$/);

    assert.equal((await call('POST', `/games/${id}/start`)).status, 401);
    assert.equal((await call('POST', `/games/${id}/start`, { key: ann.key })).status, 200);

    assert.equal((await call('POST', `/games/${id}/moves`, { body: { move: { add: 1 } } })).status, 401);
    assert.equal((await call('POST', `/games/${id}/moves`, { body: { move: { add: 1 } }, key: 'wrong' })).status, 401);
    assert.equal((await call('POST', `/games/${id}/moves`, { body: { move: { add: 1 } }, key: ben.key })).status, 403);
    const invalid = await call('POST', `/games/${id}/moves`, { body: { move: { add: 9 } }, key: ann.key });
    assert.equal(invalid.status, 400);
    assert.equal(invalid.body.error.code, 'INVALID_MOVE');

    const stale = await call('POST', `/games/${id}/moves`, { body: { move: { add: 1 }, expectedVersion: 0 }, key: ann.key });
    assert.equal(stale.status, 409);

    await call('POST', `/games/${id}/moves`, { body: { move: { add: 3 } }, key: ann.key });
    const win = await call('POST', `/games/${id}/moves`, { body: { move: { add: 2 } }, key: ben.key });
    assert.equal(win.status, 200);
    assert.equal(win.body.status, 'finished');
    assert.deepEqual(win.body.outcome, { winners: ['p2'] });
    assert.equal((await call('POST', `/games/${id}/moves`, { body: { move: { add: 1 } }, key: ann.key })).status, 409);
  });

  it('GET supports ?since= for cheap polling', async () => {
    const { id } = await newCounterGame();
    const current = (await call('GET', `/games/${id}`)).body as GameView;
    assert.deepEqual((await call('GET', `/games/${id}?since=${current.version}`)).body, { unchanged: true, version: current.version });
    assert.equal((await call('GET', `/games/${id}?since=${current.version - 1}`)).body.id, id);
  });

  it('never exposes key hashes, seeds or the move log', async () => {
    const { id, ann } = await newCounterGame();
    await call('POST', `/games/${id}/start`, { key: ann.key });
    await call('POST', `/games/${id}/moves`, { body: { move: { add: 1 } }, key: ann.key });
    const { body } = await call('GET', `/games/${id}`, { key: ann.key });
    const text = JSON.stringify(body);
    for (const secret of ['keyHash', 'seed', 'moves']) assert.ok(!text.includes(secret), `leaked ${secret}`);
  });

  it('returns clean errors for bad requests', async () => {
    assert.equal((await call('GET', '/nope')).status, 404);
    assert.equal((await call('DELETE', '/games')).status, 405);
    assert.equal((await call('GET', '/games/missing')).status, 404);
    assert.equal((await call('POST', '/games', { body: '{not json' })).status, 400);
    assert.equal((await call('POST', '/games', { body: [] })).status, 400);
    assert.equal((await call('POST', '/games', { body: { type: 'nope' } })).status, 400);
    const big = await call('POST', '/games', { body: { type: 'counter', pad: 'x'.repeat(70_000) } });
    assert.equal(big.status, 400);
  });

  it('answers CORS preflight', async () => {
    const res = await fetch(`${base}/games`, { method: 'OPTIONS' });
    assert.equal(res.status, 204);
    assert.match(res.headers.get('access-control-allow-headers') ?? '', /authorization/);
  });
});

describe('SSE', () => {
  it('sends current state on connect, then each change', async () => {
    const { id, ann } = await newCounterGame();
    const stream = await openStream(`/games/${id}/events`);
    assert.equal(stream.status, 200);
    assert.match(stream.headers.get('content-type') ?? '', /text\/event-stream/);

    const first = await stream.next();
    assert.equal(first.data.status, 'lobby');
    assert.equal(first.id, String(first.data.version));

    await call('POST', `/games/${id}/start`, { key: ann.key });
    const second = await stream.next();
    assert.equal(second.data.status, 'active');
    assert.equal(second.data.you, null);
    stream.close();
  });

  it('404s for unknown games', async () => {
    const res = await fetch(`${base}/games/missing/events`);
    assert.equal(res.status, 404);
    await res.body?.cancel();
  });

  it('never reveals pending simultaneous picks', async () => {
    const created = (await call('POST', '/games', { body: { type: 'secret-pick', config: { rounds: 1 } } })).body;
    const ann = (await call('POST', `/games/${created.id}/players`, { body: { name: 'Ann' } })).body;
    const ben = (await call('POST', `/games/${created.id}/players`, { body: { name: 'Ben' } })).body;
    await call('POST', `/games/${created.id}/start`, { key: ann.key });

    const stream = await openStream(`/games/${created.id}/events`);
    await stream.next(); // current state
    await call('POST', `/games/${created.id}/moves`, { body: { move: { pick: 8 } }, key: ann.key });
    const pending = await stream.next();
    assert.equal(pending.data.status, 'active');
    assert.deepEqual((pending.data.state as SecretPickState).pending, { p1: null });
    assert.ok(!JSON.stringify(pending.data.state).includes('8'), 'pick leaked over SSE');

    await call('POST', `/games/${created.id}/moves`, { body: { move: { pick: 3 } }, key: ben.key });
    const resolved = await stream.next();
    assert.equal(resolved.data.status, 'finished');
    assert.deepEqual((resolved.data.state as SecretPickState).history, [{ p1: 8, p2: 3 }]);
    stream.close();
  });
});
