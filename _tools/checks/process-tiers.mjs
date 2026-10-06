#!/usr/bin/env node
// The daemon starts a process to completion through one door: workload/run-check.ts's runCheck (its own process
// group killed whole at a deadline or an abort, in a workload class, output capped) for a command it waits on, spawnAs
// (workload/workload-class.ts) for one it supervises, and @intentic/base/git's `exec` / `forkedExec` for a short call
// (git, a probe). A hand-rolled `promisify(execFile)` or a bare `node:child_process` spawn/exec/execFile/execSync in
// _sandbox/sandbox/src is how every copy runCheck replaced began: the shell alone killed at the deadline, its children
// left holding the pipe, no class, so the work kept the daemon's own OOM rank. Standing sites are held per file in
// baselines/process-tiers.json, which may only shrink; a site that is right says why with
// `// allow(process-tiers): <reason>` (lib/allow.mjs).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { processCalls } from "./lib/process-calls.mjs";
import { finish } from "./lib/report.mjs";
import { ADOPTING, ratchet } from "./lib/ratchet.mjs";
import { root, subjectFiles } from "./lib/repo.mjs";

const DAEMON = `_sandbox/sandbox/src/`;
const CODE = /\.(ts|mts|js|mjs)$/;
// A suite starts processes to stand the code up, and a fixture module is part of the suite.
const EXEMPT = /(\.(test|bench)\.[cm]?[jt]s$|(^|\/)testing\.ts$|\.testing\.ts$|\.d\.[cm]?ts$)/;

// The modules whose job is starting processes, each for a reason about what it IS, not about one call being awkward.
const SUPERVISORS = new Map([
    // spawnAs itself: the one raw spawn, which puts the child in its class before returning it.
    [`${DAEMON}workload/workload-class.ts`, `spawnAs`],
    // The tmux client every visible run, pane and session goes through; tmux, not the daemon, is those processes' parent.
    [`${DAEMON}terminal/terminal-run.ts`, `the tmux client`],
]);

const files = subjectFiles(`${DAEMON}*`).filter((path) => CODE.test(path) && !EXEMPT.test(path) && !SUPERVISORS.has(path));
const found = new Map();
for (const path of files) {
    const text = readFileSync(join(root, path), `utf8`);
    if (!text.includes(`child_process`)) {
        continue;
    }
    const calls = processCalls(text);
    if (calls.length > 0) {
        found.set(path, calls);
    }
}

const { grown } = ratchet(`process-tiers`, `process-tiers`, new Map([...found].map(([path, calls]) => [path, calls.length])));
if (ADOPTING) {
    process.exit(0);
}
const problems = grown.flatMap(({ key, count, allowed }) => [
    ...found.get(key).map(({ line, what }) => `${key}:${line}  ${what}`),
    `${key}: ${count} hand-started process(es), the baseline allows ${allowed}`,
]);

finish(
    [
        [
            `a process started by hand in the daemon: runCheck (workload/run-check.ts) for a command it waits on, spawnAs for one it supervises, @intentic/base/git's exec or forkedExec for a short call, or say why with // allow(process-tiers): <reason>`,
            problems,
        ],
    ],
    [`${files.length} daemon source files read: no new hand-started process (${[...found.values()].reduce((sum, calls) => sum + calls.length, 0)} standing, held by the baseline)`],
);
