#!/usr/bin/env node
// A synchronous filesystem or process call in the daemon blocks its one event loop: every route, every terminal, every
// agent's stream waits behind it. A request path that stats, reads or runs a program synchronously (a route handler, a
// per-tick poll) is how one slow disk or one hung `tmux` becomes a frozen editor. So the daemon's event-loop code may
// not gain one: every `*Sync` call of node:fs, `execSync`, `execFileSync` and `spawnSync` of node:child_process, and the
// `*Sync` helpers of @intentic/base/node/fs, counted per file and ratcheted (baselines/daemon-sync-io.json).
//
// What is counted is the event loop's code, not every file in src: the modules main.ts reaches by value imports. A worker
// entry (`*-worker.ts`, started through `siblingModule`, never imported) and what only it reaches run on their own
// thread and block nothing else, so the graph leaves them out by itself, as it leaves out the suites, their harness
// (`*.testing.ts`, `tests/`, `harness/`) and build scripts no module imports.
//
// Not counted: node:sqlite's `DatabaseSync`. The stores under store/ are synchronous by design (one connection, short
// transactions on a local file), and the heavy readers already run on worker threads
// (sessions/search, git/changes/code-counts). zlib and crypto `*Sync` are CPU, not I/O, and are not counted either.
//
// A sync call that is right where it stands says why at its site: `// allow(daemon-sync-io): <reason>`, e.g. a boot-only
// read before the server listens, or a shutdown path where the loop has nothing left to serve. Boot-only code is not
// exempted by directory: bootstrap/ also starts the schedulers whose ticks run for the daemon's whole life.
import { readFileSync } from "node:fs";
import { dirname, join, normalize } from "node:path";
import { allowedAt } from "./lib/allow.mjs";
import { importsOf } from "./lib/imports.mjs";
import { ADOPTING, ratchet } from "./lib/ratchet.mjs";
import { finish } from "./lib/report.mjs";
import { git, root, subjectFiles } from "./lib/repo.mjs";

const CHECK = `daemon-sync-io`;
const SRC = `_sandbox/sandbox/src`;
const ENTRY = `${SRC}/main.ts`;

// Modules whose sync exports block, and which of their exports count: every `*Sync` of fs and the base helpers, and
// child_process's three blocking runners.
const BLOCKING = new Map([
    [`node:fs`, (name) => name.endsWith(`Sync`)],
    [`fs`, (name) => name.endsWith(`Sync`)],
    [`@intentic/base/node/fs`, (name) => name.endsWith(`Sync`)],
    [`node:child_process`, (name) => name === `execSync` || name === `execFileSync` || name === `spawnSync`],
    [`child_process`, (name) => name === `execSync` || name === `execFileSync` || name === `spawnSync`],
]);

const isProduction = (path) =>
    path.startsWith(`${SRC}/`) && path.endsWith(`.ts`) && !path.endsWith(`.d.ts`) && !/\.(test|testing|bench)\.ts$/.test(path) && !/\/(tests?|fixtures?)\//.test(path);

const escape = (name) => name.replace(/[$]/g, `\\$`);

// The blocking calls in one file's text: `{ line, name }`, minus the ones excused at their site.
const syncCalls = (text) => {
    const callees = [];
    for (const match of text.matchAll(/import\s+(?!type\s)([^;]*?)\s+from\s+["']([^"']+)["']/g)) {
        const counts = BLOCKING.get(match[2]);
        if (counts === undefined) {
            continue;
        }
        const clause = match[1];
        const space = /\*\s+as\s+([\w$]+)/.exec(clause)?.[1] ?? /^([\w$]+)\s*(?:,|$)/.exec(clause)?.[1];
        if (space !== undefined) {
            callees.push({ pattern: new RegExp(`(?<![\\w$.])${escape(space)}\\s*\\.\\s*([\\w$]+)\\s*\\(`, `g`), counts });
        }
        for (const binding of /\{([^}]*)\}/.exec(clause)?.[1].split(`,`) ?? []) {
            const [imported, local = imported] = binding
                .trim()
                .split(/\s+as\s+/)
                .map((part) => part.trim());
            if (imported !== `` && !imported.startsWith(`type `) && counts(imported)) {
                callees.push({ pattern: new RegExp(`(?<![\\w$.])(${escape(local)})\\s*\\(`, `g`), counts: () => true });
            }
        }
    }
    const lines = text.split(`\n`);
    const found = [];
    lines.forEach((line, index) => {
        if (/^\s*(\/\/|\*|\/\*)/.test(line) || /^\s*import\s/.test(line)) {
            return;
        }
        for (const { pattern, counts } of callees) {
            for (const match of line.matchAll(pattern)) {
                if (counts(match[1]) && !allowedAt(lines, index + 1, CHECK)) {
                    found.push({ line: index + 1, name: match[1] });
                }
            }
        }
    });
    return found;
};

// The modules main.ts reaches by value imports, static or `import()`: the code that runs on the event loop.
const eventLoopModules = () => {
    const listed = git(`ls-files`, `-z`, `--cached`, `--others`, `--exclude-standard`, `--`, SRC);
    if (listed === undefined) {
        throw new Error(`git ls-files failed in ${root}: ${CHECK} cannot read the daemon's import graph without it`);
    }
    const present = new Set(listed.split(`\0`).filter(isProduction));
    const reached = new Set();
    const queue = [ENTRY];
    while (queue.length > 0) {
        const path = queue.pop();
        if (reached.has(path) || !present.has(path)) {
            continue;
        }
        reached.add(path);
        let text;
        try {
            text = readFileSync(join(root, path), `utf8`);
        } catch {
            continue;
        }
        for (const { specifier, typeOnly } of importsOf(text)) {
            if (typeOnly || !specifier.startsWith(`.`)) {
                continue;
            }
            const target = normalize(join(dirname(path), specifier)).replace(/\.js$/, `.ts`);
            queue.push(target.endsWith(`.ts`) ? target : `${target}.ts`, `${target}/index.ts`);
        }
    }
    return reached;
};

const eventLoop = eventLoopModules();
const files = subjectFiles(`${SRC}/**/*.ts`).filter((path) => eventLoop.has(path));

const found = new Map();
const sites = new Map();
for (const path of files) {
    const here = syncCalls(readFileSync(join(root, path), `utf8`));
    if (here.length > 0) {
        found.set(path, here.length);
        sites.set(path, here);
    }
}

const { grown } = ratchet(CHECK, CHECK, found);
if (ADOPTING) {
    process.exit(0);
}

const problems = grown.flatMap(({ key, count, allowed }) => [
    ...sites.get(key).map(({ line, name }) => `${key}:${line}  ${name}() blocks the daemon's event loop`),
    `${key}: ${count} sync call(s), the baseline allows ${allowed}`,
]);
const standing = [...found.values()].reduce((sum, count) => sum + count, 0);

finish(
    [
        [
            `a new synchronous fs or process call on the daemon's event loop: use node:fs/promises or the async process helpers, move the work to a worker thread, or, for a boot-only or shutdown-only call, say why with // allow(${CHECK}): <reason>`,
            problems,
        ],
    ],
    [`${files.length} event-loop modules of the daemon read: no new sync fs or process call (${standing} standing, held by the baseline)`],
);
