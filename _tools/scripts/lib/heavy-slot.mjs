// The sandbox's heavy slot, taken by the script itself rather than left to whoever launched it. The daemon queues a
// command it recognises (`pnpm verify:turn`, `pnpm verify`: platform/resources/heavy-commands.ts wraps them in
// `queue-run --pool heavy`), but `node _tools/scripts/verify/verify-turn.mjs`, a `cd … &&` chain or a script calling
// another is not recognised, and one of those ran beside the post-land check on 2026-09-25 until the machine swapped.
// So a heavy script calls `runInHeavySlot()` first: inside a slot it returns and the script goes on; outside one it runs
// itself again under queue-run, which waits for the slot (and for memory) exactly as a recognised command does, and
// exits with that run's code. Off the sandbox (a laptop, CI) there is no queue-run and it returns at once.
import { spawnSync } from "node:child_process";
import { existsSync, readlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The settings of the `repo-verify` rule (heavy-commands.ts), so a script queued this way competes for the same slot as
// the same command typed by an agent: one at a time, a wait of up to 15 minutes, then not run at all rather than beside
// the holder.
const RULE = { pool: "heavy", limit: "1", wait: "900", memoryGate: "120", maxHold: "1800", onDeadline: "skip" };
const QUEUE_RUN = "/usr/local/bin/queue-run";
// Set on the re-run so it can never queue itself twice: queue-run that could not take a slot (no flock, an unwritable
// directory) runs the command anyway, and that run must not go round again.
const REQUEUED = "INTENTIC_HEAVY_REQUEUED";

const queueRoot = (env) => env.INTENTIC_QUEUE_DIR ?? join(env.TMPDIR ?? tmpdir(), "intentic-queue");

// The heavy slot this process runs inside, or undefined: queue-run names it in the environment of what it starts, and
// keeps it open as fd 9 (the only sign an older queue-run gives).
export const heldHeavySlot = (env = process.env, fd9 = "/proc/self/fd/9") => {
    const pool = join(queueRoot(env), RULE.pool);
    const named = env.INTENTIC_QUEUE_SLOT;
    if (named !== undefined && named.startsWith(`${pool}/`)) {
        return named;
    }
    try {
        const target = readlinkSync(fd9);
        return target.startsWith(`${pool}/slot.`) ? target : undefined;
    } catch {
        // silent-catch: no fd 9 (or no /proc) is the ordinary answer for a process no queue started
        return undefined;
    }
};

// Returns when this process may run its heavy work; otherwise runs it again inside the slot and exits with its code.
export const runInHeavySlot = (label, { env = process.env, argv = process.argv, queueRun = QUEUE_RUN } = {}) => {
    if (heldHeavySlot(env) !== undefined || env[REQUEUED] === "1" || !existsSync(queueRun)) {
        return;
    }
    const { pool, limit, wait, memoryGate, maxHold, onDeadline } = RULE;
    const run = spawnSync(
        queueRun,
        ["--pool", pool, "--limit", limit, "--wait", wait, "--memory-gate", memoryGate, "--max-hold", maxHold, "--on-deadline", onDeadline, "--label", label, "--", process.execPath, ...argv.slice(1)],
        { stdio: "inherit", env: { ...env, [REQUEUED]: "1" } },
    );
    if (run.error !== undefined) {
        // A queue that cannot start is no reason to measure nothing: the run goes ahead unqueued, as queue-run itself
        // does when it cannot take a slot.
        console.error(`${label}: could not wait for the heavy slot (${run.error.message}); running without it`);
        return;
    }
    if (run.status === 75) {
        console.error(`${label}: the sandbox's heavy slot stayed taken for ${Number(wait) / 60} minutes, so nothing was measured; run it again later`);
    }
    process.exit(run.status ?? 1);
};
