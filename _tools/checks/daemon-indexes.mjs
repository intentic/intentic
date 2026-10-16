#!/usr/bin/env node
// The daemon's generated indexes (src/bootstrap/state-registry.ts, src/app-raw-routes.ts and
// src/bootstrap/slices/slice-registry.ts) read back exactly what
// _sandbox/sandbox/scripts/write-indexes.mjs writes from the source: a definition added, moved or removed without
// regenerating is caught here, and `--fix` rewrites them. Plain node over the source text: no install, no network.
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { cannotMeasure, finish } from "./lib/report.mjs";
import { root } from "./lib/repo.mjs";

const DAEMON = join(root, "_sandbox/sandbox");
const run = (...args) => spawnSync(process.execPath, ["scripts/write-indexes.mjs", ...args], { cwd: DAEMON, encoding: "utf8" });

if (process.argv.includes("--fix")) {
    const fixed = run();
    if (fixed.status === 0 && /wrote /.test(fixed.stdout)) {
        console.log(`rewrote ${fixed.stdout.trim().replace(/^daemon indexes: wrote /, "")}`);
    }
}

const checked = run("--check");
if (checked.status !== 0 && checked.status !== 1) {
    cannotMeasure(`daemon-indexes: the generator could not run: ${(checked.stderr || checked.error?.message || "").trim()}`);
}
finish(
    [["a daemon index is out of date (run node _tools/checks/daemon-indexes.mjs --fix)", checked.status === 1 ? [checked.stderr.trim()] : []]],
    [checked.stdout.trim()],
);
