// Rebuilds the stale dist a run is about to read, instead of telling the agent to (2026-10-27).
//
// A worktree's dist is an overlay of main's, which landing did not rebuild, so the tooling found it stale and printed
// the rebuild command for each agent to run itself: `suites` said "stale dist" in 184 conversations in the week of
// 10-16 (about half of that week's), the symptoms ("has no exported member", "Cannot find module '@intentic/…'") rose
// from 1.9 to 9.0 per 1,000 Bash calls over five weeks, and agents ran emit-declarations by hand over 1,100 times. The
// check already knows what is stale; this builds just that (emit-declarations takes the packages), once, and answers
// with what it did, so the run that follows reads a current dist. A rebuild that fails leaves the old warning to say it.
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { REBUILD, staleDist, staleDistWarning } from "./dist-staleness.mjs";
import { root } from "../../checks/lib/repo.mjs";

// Generous for the whole set (p90 41 s in agents' worktrees); a scoped one is usually seconds.
const REBUILD_TIMEOUT_MS = 5 * 60_000;

/** The commands that rebuild `stale` (staleDist entries): one scoped emit-declarations for every package it builds, then
 *  each package's own build where it has one. */
export const rebuildCommands = (stale) => {
    const emitted = stale.filter(({ rebuild }) => rebuild === REBUILD).map(({ dir }) => dir);
    const own = [...new Set(stale.filter(({ rebuild }) => rebuild !== REBUILD).map(({ rebuild }) => rebuild))];
    return [...(emitted.length === 0 ? [] : [`${REBUILD} ${emitted.join(" ")}`]), ...own];
};

/** Runs them from the repository root; `{ ok, seconds, failed? }`, never throws. `run` is swapped in tests. */
export const rebuildStale = (stale, { run = (command) => spawnSync("sh", ["-c", command], { cwd: root, stdio: ["ignore", "pipe", "pipe"], timeout: REBUILD_TIMEOUT_MS }) } = {}) => {
    const started = Date.now();
    for (const command of rebuildCommands(stale)) {
        const result = run(command);
        if (result.status !== 0) {
            const said = `${result.stdout ?? ""}${result.stderr ?? ""}`.trim().split("\n").slice(-3).join(" | ");
            return { ok: false, seconds: Math.round((Date.now() - started) / 1000), failed: `${command}${said === "" ? "" : `: ${said}`}` };
        }
    }
    return { ok: true, seconds: Math.round((Date.now() - started) / 1000) };
};

/** The line a run prints: what it rebuilt, or the warning it would have printed and why the rebuild did not take. */
export const rebuildNote = (stale, outcome) =>
    outcome.ok
        ? `rebuilt stale dist before running (${stale.map(({ name }) => name).join(", ")}; ${outcome.seconds} s)`
        : `${staleDistWarning(stale)} (the automatic rebuild failed: ${outcome.failed})`;

// `node dist-rebuild.mjs`: every stale package in this checkout, rebuilt. What the sandbox runs in the main tree after a
// land that touched a package's source (fixers.mjs DERIVED "dist"), so the dist every worktree overlays is current
// before the next turn reads it. Always exits 0: a failed rebuild is reported, and a run's own check still catches it.
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
    const stale = staleDist();
    console.log(stale.length === 0 ? "dist: current for every package read from dist" : rebuildNote(stale, rebuildStale(stale)));
}
