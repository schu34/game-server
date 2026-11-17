/**
 * Load test: many concurrent tic-tac-toe games against one server, played by bots over HTTP + SSE,
 * the way real clients would (every player holds its own authenticated stream and moves when the
 * stream says it's their turn).
 *
 *   pnpm run bench                                  # 1000 games for 30s
 *   pnpm run bench --games 2000 --think 50 --duration 60
 *   pnpm run bench --url http://localhost:3000      # against a server you started yourself
 *   pnpm run bench --profile                        # also write a CPU profile of the server
 *
 * By default it starts the dev server in a child process and samples its memory and CPU. The bots
 * run in worker threads (--workers), each with its own event loop and connections, because one
 * thread can't drive thousands of streams without becoming the bottleneck itself. Each slot plays games back to back until
 * the time is up, so "concurrent games" stays constant.
 *
 * Reported latencies:
 * - move: POST /moves round trip, as the mover sees it.
 * - push: from sending a move to the opponent's stream delivering it (what a player waits for).
 * - setup: creating a game and seating both players.
 * The bots' own event-loop delay is reported too: if it's high, the load generator is the bottleneck,
 * not the server.
 */
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { availableParallelism } from 'node:os';
import { monitorEventLoopDelay, performance } from 'node:perf_hooks';
import { parseArgs, promisify } from 'node:util';
import { isMainThread, parentPort, Worker, workerData } from 'node:worker_threads';
import { GameServer, type PlayerSession, type Subscription } from '@gs/client';
import type { GameView } from '@gs/sdk';
import type { TicTacToeMove, TicTacToeState } from '@gs/game-tic-tac-toe';

const { values: args } = parseArgs({
  options: {
    games: { type: 'string', default: '1000' },
    duration: { type: 'string', default: '30' },
    think: { type: 'string', default: '100' },
    'setup-concurrency': { type: 'string', default: '50' },
    workers: { type: 'string', default: String(Math.max(1, Math.min(6, availableParallelism() - 2))) },
    url: { type: 'string' },
    profile: { type: 'boolean', default: false },
  },
});
const GAMES = Number(args.games);
const DURATION_MS = Number(args.duration) * 1000;
const THINK_MS = Number(args.think); // mean; each move waits 0.5x..1.5x this
const SETUP_CONCURRENCY = Number(args['setup-concurrency']);
const WORKERS = Number(args.workers);

type Seat = PlayerSession<TicTacToeState, TicTacToeMove>;
type View = GameView<TicTacToeState>;

// ---------------------------------------------------------------------------
// Metrics
// ---------------------------------------------------------------------------

const samples = { move: [] as number[], push: [] as number[], setup: [] as number[] };
let movesMade = 0;
let gamesFinished = 0;
const errors = new Map<string, number>();
const countError = (where: string, e: unknown) => {
  // fetch wraps network errors as "fetch failed"; the cause says what actually happened.
  const cause =
    e instanceof Error && e.cause instanceof Error
      ? ` (${(e.cause as { code?: string }).code ?? e.cause.message})`
      : '';
  const key = `${where}: ${e instanceof Error ? e.message : String(e)}${cause}`;
  errors.set(key, (errors.get(key) ?? 0) + 1);
};

function percentiles(values: number[]) {
  if (values.length === 0) return 'n/a';
  const sorted = [...values].sort((a, b) => a - b);
  const at = (p: number) => sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))]!;
  const f = (n: number) => `${n.toFixed(1)}ms`;
  return `p50 ${f(at(50))}  p95 ${f(at(95))}  p99 ${f(at(99))}  max ${f(sorted.at(-1)!)}  (n=${values.length})`;
}

// ---------------------------------------------------------------------------
// Server process
// ---------------------------------------------------------------------------

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer().listen(0, () => {
      const { port } = probe.address() as { port: number };
      probe.close(() => resolve(port));
    });
    probe.on('error', reject);
  });
}

async function startServer(): Promise<{ url: string; child: ChildProcess }> {
  const port = await freePort();
  // --profile writes a V8 CPU profile of the server (open it in Chrome DevTools or VS Code).
  const nodeArgs = args.profile ? ['--cpu-prof', '--cpu-prof-dir=bench-profiles'] : [];
  const child = spawn(process.execPath, [...nodeArgs, 'apps/dev-server/src/main.ts'], {
    env: { ...process.env, PORT: String(port) },
    stdio: ['ignore', 'ignore', 'inherit'],
  });
  const url = `http://localhost:${port}`;
  for (let i = 0; i < 100; i++) {
    try {
      await new GameServer(url).gameTypes();
      return { url, child };
    } catch {
      await sleep(100);
    }
  }
  child.kill();
  throw new Error('server did not start');
}

/** CPU time used by a process, in seconds, and its resident memory in MB, from `ps`. */
async function processStats(pid: number): Promise<{ cpuSeconds: number; rssMb: number } | null> {
  try {
    const { stdout } = await promisify(execFile)('ps', ['-o', 'rss=,time=', '-p', String(pid)]);
    const [rss, time] = stdout.trim().split(/\s+/);
    // "MM:SS.ss" (macOS) or "[DD-]HH:MM:SS" (Linux)
    const parts = time!.replace(/^\d+-/, '').split(':').map(Number);
    const cpuSeconds = parts.reduce((total, part) => total * 60 + part, 0);
    return { cpuSeconds, rssMb: Number(rss) / 1024 };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Bots
// ---------------------------------------------------------------------------

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const think = () => sleep(THINK_MS * (0.5 + Math.random()));

let stopping = false;
let setupsSettled = 0;
const openSubscriptions = new Set<Subscription>();

/** One table: plays games back to back until the test ends. */
async function runSlot(server: GameServer): Promise<void> {
  while (!stopping) {
    try {
      await playOneGame(server);
    } catch (e) {
      countError('game', e);
      await sleep(250);
    }
  }
}

async function playOneGame(server: GameServer): Promise<void> {
  const setupStart = performance.now();
  let x: Seat, o: Seat;
  try {
    const game = await server.create('tic-tac-toe');
    x = await server.join<TicTacToeState, TicTacToeMove>(game.id, 'X');
    o = await server.join<TicTacToeState, TicTacToeMove>(game.id, 'O');
    samples.setup.push(performance.now() - setupStart);
  } finally {
    setupsSettled++;
  }

  // When the move that makes each version was sent, and by whom, so the *opponent's* stream can
  // time its arrival. Recorded before sending: the push can beat the move's own response.
  const sentAt = new Map<number, { at: number; by: string }>();
  let finish!: () => void;
  const finished = new Promise<void>((resolve) => (finish = resolve));

  const bot = async (me: Seat) => {
    let actedOn = -1;
    const subscription = await me.subscribe((view: View) => {
      const sent = sentAt.get(view.version);
      if (sent !== undefined && sent.by !== me.playerId) {
        sentAt.delete(view.version);
        samples.push.push(performance.now() - sent.at);
      }
      if (view.status === 'finished') return finish();
      if (view.status !== 'active' || stopping) return;
      if (view.activePlayers[0] !== me.playerId || view.version <= actedOn) return;
      actedOn = view.version;
      void (async () => {
        await think();
        if (stopping) return finish();
        const empty = view.state.board.flatMap((cell, i) => (cell === null ? [i] : []));
        const cell = empty[Math.floor(Math.random() * empty.length)]!;
        const start = performance.now();
        sentAt.set(view.version + 1, { at: start, by: me.playerId }); // each move adds exactly one version
        try {
          await me.move({ cell });
          samples.move.push(performance.now() - start);
          movesMade++;
        } catch (e) {
          countError('move', e);
          finish();
        }
      })();
    });
    openSubscriptions.add(subscription);
    return subscription;
  };

  const subs = await Promise.all([bot(x), bot(o)]);
  await finished;
  for (const sub of subs) {
    sub.close();
    openSubscriptions.delete(sub);
  }
  if (!stopping) gamesFinished++;
}

/** Start `count` slots, at most `concurrency` setting up at once, so the start isn't one giant burst. */
async function startSlots(server: GameServer, count: number, concurrency: number): Promise<Promise<void>[]> {
  const running: Promise<void>[] = [];
  for (let i = 0; i < count; i += concurrency) {
    const batch = Math.min(concurrency, count - i);
    const before = setupsSettled;
    for (let j = 0; j < batch; j++) running.push(runSlot(server));
    while (setupsSettled < before + batch) await sleep(5);
  }
  return running;
}

// ---------------------------------------------------------------------------
// Worker: runs its share of the tables and reports back.
// ---------------------------------------------------------------------------

type WorkerResults = {
  samples: typeof samples;
  movesMade: number;
  gamesFinished: number;
  errors: [string, number][];
  loopP99Ms: number;
  loopMaxMs: number;
};

async function worker(): Promise<void> {
  const port = parentPort!;
  const { url, games } = workerData as { url: string; games: number };
  const server = new GameServer(url);
  const loopDelay = monitorEventLoopDelay({ resolution: 10 });
  loopDelay.enable();

  const slots = await startSlots(server, games, Math.max(1, Math.round(SETUP_CONCURRENCY / WORKERS)));
  port.postMessage({ type: 'ready' });
  const tick = setInterval(
    () => port.postMessage({ type: 'tick', moves: movesMade, streams: openSubscriptions.size }),
    250,
  );

  port.on('message', async (message: 'measure' | 'stop') => {
    if (message === 'measure') {
      samples.move.length = 0;
      samples.push.length = 0;
      movesMade = 0;
      gamesFinished = 0;
      loopDelay.reset();
      return;
    }
    stopping = true;
    clearInterval(tick);
    for (const sub of openSubscriptions) sub.close();
    await Promise.race([Promise.all(slots), sleep(5000)]);
    loopDelay.disable();
    const results: WorkerResults = {
      samples,
      movesMade,
      gamesFinished,
      errors: [...errors],
      // Samples include the 10ms sampling interval; subtract it so an idle loop reads 0.
      loopP99Ms: Math.max(0, loopDelay.percentile(99) / 1e6 - 10),
      loopMaxMs: Math.max(0, loopDelay.max / 1e6 - 10),
    };
    port.postMessage({ type: 'results', results });
    process.exit(0); // in a worker, ends just this thread (pooled keep-alive sockets would keep it alive)
  });
}

// ---------------------------------------------------------------------------
// Main: starts the server and the workers, samples, and reports.
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const external = args.url !== undefined;
  const { url, child } = external ? { url: args.url!, child: undefined } : await startServer();
  console.log(
    `Load test: ${GAMES} concurrent tic-tac-toe games (${GAMES * 2} player streams), think ${THINK_MS}ms, ` +
      `${DURATION_MS / 1000}s, ${WORKERS} bot workers, against ${url}${external ? '' : ' (child process)'}`,
  );

  type Handle = { thread: Worker; moves: number; streams: number; results?: WorkerResults };
  const handles: Handle[] = [];
  const startedAt = performance.now();
  await Promise.all(
    Array.from({ length: WORKERS }, (_, i) => {
      const games = Math.floor(GAMES / WORKERS) + (i < GAMES % WORKERS ? 1 : 0);
      const handle: Handle = {
        thread: new Worker(new URL(import.meta.url), { workerData: { url, games }, argv: process.argv.slice(2) }),
        moves: 0,
        streams: 0,
      };
      handles.push(handle);
      return new Promise<void>((resolve, reject) => {
        handle.thread.on('error', reject);
        handle.thread.on(
          'message',
          (m: { type: string; moves?: number; streams?: number; results?: WorkerResults }) => {
            if (m.type === 'ready') resolve();
            if (m.type === 'tick') Object.assign(handle, { moves: m.moves, streams: m.streams });
            if (m.type === 'results') handle.results = m.results;
          },
        );
      });
    }),
  );
  const rampMs = performance.now() - startedAt;
  console.log(`All ${GAMES} games running after ${(rampMs / 1000).toFixed(1)}s\n`);

  // Measure the steady state only: reset counters once everything is running.
  for (const h of handles) {
    h.thread.postMessage('measure');
    h.moves = 0;
  }

  const total = (key: 'moves' | 'streams') => handles.reduce((sum, h) => sum + h[key], 0);
  const serverSamples: { rssMb: number; cpuPercent: number }[] = [];
  let last = child?.pid ? await processStats(child.pid) : null;
  let lastAt = performance.now();
  let lastMoves = 0;
  const steadyStart = performance.now();
  while (performance.now() - steadyStart < DURATION_MS) {
    await sleep(1000);
    const now = performance.now();
    const stats = child?.pid ? await processStats(child.pid) : null;
    const rate = ((total('moves') - lastMoves) * 1000) / (now - lastAt);
    let line = `${((now - steadyStart) / 1000).toFixed(0).padStart(3)}s  ${rate.toFixed(0).padStart(6)} moves/s  streams ${total('streams')}`;
    if (stats && last) {
      const cpuPercent = ((stats.cpuSeconds - last.cpuSeconds) / ((now - lastAt) / 1000)) * 100;
      serverSamples.push({ rssMb: stats.rssMb, cpuPercent });
      line += `  server cpu ${cpuPercent.toFixed(0).padStart(3)}%  rss ${stats.rssMb.toFixed(0)}MB`;
    }
    console.log(line);
    last = stats;
    lastAt = now;
    lastMoves = total('moves');
  }
  const elapsedS = (performance.now() - steadyStart) / 1000;

  for (const h of handles) h.thread.postMessage('stop');
  await Promise.all(handles.map((h) => new Promise((resolve) => h.thread.once('exit', resolve))));
  if (child) {
    // SIGINT, so the server shuts down normally and (with --profile) writes its profile.
    const exited = new Promise((resolve) => child.once('exit', resolve));
    child.kill('SIGINT');
    await Promise.race([exited, sleep(10_000)]);
    if (args.profile) console.log('\nServer CPU profile written to bench-profiles/');
  }

  const results = handles.map((h) => h.results!).filter(Boolean);
  const all = (key: keyof typeof samples) => results.flatMap((r) => r.samples[key]);
  const sum = (key: 'movesMade' | 'gamesFinished') => results.reduce((n, r) => n + r[key], 0);
  const allErrors = new Map<string, number>();
  for (const r of results) for (const [m, n] of r.errors) allErrors.set(m, (allErrors.get(m) ?? 0) + n);
  const avg = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / Math.max(1, xs.length);

  console.log(`\n=== Results (steady state, ${elapsedS.toFixed(0)}s) ===`);
  console.log(`ramp-up        ${(rampMs / 1000).toFixed(1)}s to start ${GAMES} games`);
  console.log(
    `throughput     ${(sum('movesMade') / elapsedS).toFixed(0)} moves/s, ${(sum('gamesFinished') / elapsedS).toFixed(1)} games finished/s` +
      `  (ideal ≈ ${((GAMES * 1000) / THINK_MS).toFixed(0)} moves/s if the server added no delay)`,
  );
  console.log(`move latency   ${percentiles(all('move'))}`);
  console.log(`push latency   ${percentiles(all('push'))}`);
  console.log(`setup latency  ${percentiles(all('setup'))}  (create + 2 joins, whole run)`);
  if (serverSamples.length) {
    const peak = Math.max(...serverSamples.map((s) => s.rssMb));
    const cpu = serverSamples.map((s) => s.cpuPercent);
    console.log(
      `server         cpu avg ${avg(cpu).toFixed(0)}%, max ${Math.max(...cpu).toFixed(0)}% (100% = one core), rss peak ${peak.toFixed(0)}MB`,
    );
  }
  console.log(
    `bots           event-loop delay p99 ${Math.max(...results.map((r) => r.loopP99Ms)).toFixed(1)}ms, ` +
      `max ${Math.max(...results.map((r) => r.loopMaxMs)).toFixed(1)}ms (worst worker; high means the bots are the bottleneck)`,
  );
  if (allErrors.size) {
    console.log('errors:');
    for (const [message, count] of allErrors) console.log(`  ${count} × ${message}`);
  } else {
    console.log('errors         none');
  }
  process.exit(0);
}

if (isMainThread) await main();
else await worker();
