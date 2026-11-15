/**
 * Enforces the dependency rules between workspace packages by scanning imports.
 * (npm hoists every workspace into node_modules, so an accidental import of, say,
 * a game from the server would otherwise resolve and silently couple them.)
 *
 *   sdk/src      → nothing (relative only)
 *   sdk/test     → node:*
 *   server       → @gs/sdk, node:*
 *   server/http  → @gs/sdk, node:*, hono, @hono/* (the only place a web framework is allowed)
 *   client       → @gs/sdk
 *   games/X/src  → @gs/sdk
 *   games/X/test → @gs/sdk, node:*
 *   games/X/cli  → @gs/sdk, @gs/client, node:*
 *   apps/*       → anything (this is where games get wired into the server)
 *
 * Relative imports must also stay inside their own package.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';

const root = resolve(import.meta.dirname, '..');

type Rule = {
  dir: string;
  /** A subdirectory this rule skips, because a more specific rule covers it. */
  except?: string;
  packageRoot: string;
  allow: (specifier: string) => boolean;
  label: string;
};

const nodeBuiltin = (s: string) => s.startsWith('node:');
const only = (...names: string[]) => (s: string) => names.includes(s);
/** A package or any of its subpaths, e.g. `hono` and `hono/cors`. */
const pkg = (name: string) => (s: string) => s === name || s.startsWith(`${name}/`);
const either = (...checks: ((s: string) => boolean)[]) => (s: string) => checks.some((check) => check(s));

const rules: Rule[] = [
  { dir: 'packages/sdk/src', packageRoot: 'packages/sdk', allow: () => false, label: 'no imports' },
  { dir: 'packages/sdk/test', packageRoot: 'packages/sdk', allow: nodeBuiltin, label: 'node:*' },
  {
    dir: 'packages/server',
    except: 'packages/server/src/http',
    packageRoot: 'packages/server',
    allow: either(only('@gs/sdk'), nodeBuiltin),
    label: '@gs/sdk, node:*',
  },
  {
    dir: 'packages/server/src/http',
    packageRoot: 'packages/server',
    allow: either(only('@gs/sdk'), nodeBuiltin, pkg('hono'), (s) => s.startsWith('@hono/')),
    label: '@gs/sdk, node:*, hono, @hono/*',
  },
  { dir: 'packages/client', packageRoot: 'packages/client', allow: only('@gs/sdk'), label: '@gs/sdk' },
];

for (const game of listDirs('games')) {
  const pkg = `games/${game}`;
  rules.push(
    { dir: `${pkg}/src`, packageRoot: pkg, allow: only('@gs/sdk'), label: '@gs/sdk' },
    { dir: `${pkg}/test`, packageRoot: pkg, allow: either(only('@gs/sdk'), nodeBuiltin), label: '@gs/sdk, node:*' },
    { dir: `${pkg}/cli`, packageRoot: pkg, allow: either(only('@gs/sdk', '@gs/client'), nodeBuiltin), label: '@gs/sdk, @gs/client, node:*' },
  );
}

const IMPORT_RE = /(?:^|[^\w.])(?:import|export)\s+(?:type\s+)?(?:[^'"]*?\s+from\s+)?['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)/g;

const violations: string[] = [];
let filesChecked = 0;

for (const rule of rules) {
  for (const file of listTsFiles(join(root, rule.dir), rule.except && join(root, rule.except))) {
    filesChecked++;
    const source = readFileSync(file, 'utf8');
    for (const match of source.matchAll(IMPORT_RE)) {
      const specifier = (match[1] ?? match[2])!;
      const where = relative(root, file);
      if (specifier.startsWith('.')) {
        const target = resolve(dirname(file), specifier);
        const pkgRoot = join(root, rule.packageRoot) + sep;
        if (!target.startsWith(pkgRoot)) violations.push(`${where}: relative import "${specifier}" escapes ${rule.packageRoot}`);
      } else if (!rule.allow(specifier)) {
        violations.push(`${where}: imports "${specifier}" (allowed: ${rule.label})`);
      }
    }
  }
}

if (violations.length) {
  console.error(`Dependency boundary violations:\n  ${violations.join('\n  ')}`);
  process.exit(1);
}
console.log(`Boundaries OK (${filesChecked} files checked)`);

function listDirs(dir: string): string[] {
  const full = join(root, dir);
  try {
    return readdirSync(full).filter((name) => statSync(join(full, name)).isDirectory());
  } catch {
    return [];
  }
}

function listTsFiles(dir: string, except?: string): string[] {
  if (dir === except) return [];
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  return entries.flatMap((name) => {
    if (name === 'node_modules') return [];
    const full = join(dir, name);
    if (statSync(full).isDirectory()) return listTsFiles(full, except);
    return /\.(m|c)?ts$/.test(name) ? [full] : [];
  });
}
