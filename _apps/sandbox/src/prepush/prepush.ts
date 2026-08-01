import { spawn } from "node:child_process";
import type { PrepushRun } from "@intentic/sandbox-contract";
import type { Services } from "../composition.js";

/* THE PRE-PUSH CHECK — the workspace's own answer to "would this push go red", asked at the push and answered
 * while the user waits for it.
 *
 * WHY THE PUSH AND NOT THE LAND, which is where this used to run. A post-land verdict is about a tree that keeps
 * moving: the user commits by parts, another agent lands, an edit arrives. So the verdict spent its life either
 * stale or being recomputed, and it needed a content fingerprint, a staleness rule, a persisted store and a badge
 * to say which of those it was — machinery whose entire job was answering "is this still about the tree in front
 * of me". The push asks that question for free. There is exactly one artifact at the push, the user is standing
 * in front of it, and nothing else is going to change underneath before it leaves the machine.
 *
 * SO NOTHING IS PERSISTED AND NOTHING IS POLLED AT REST. A run exists while it runs, reports to the dialog that
 * started it, and is gone with the process. Nothing survives a daemon restart because nothing needs to: the next
 * push asks again, and an answer the user is not waiting on has no reader.
 *
 * WHAT IT RUNS ON. The main working tree, always — that is where the commits about to be pushed live, and it is
 * the tree whose node_modules resolve this monorepo's cross-package imports to the sources that will actually
 * ship (agents/worktrees.ts explains why an isolated worktree cannot answer this).
 */

// The output kept from one run, tail-first. Enough to see the actual failure, bounded so the fix turn seeded
// from it stays about fixing rather than scrolling. The TAIL, because a suite's verdict and its failure summary
// are at the end — a head-capped buffer of a chatty build is all progress bars.
const PREPUSH_OUTPUT_BYTES = 24_000;

// SIGTERM first so a test runner can tear down its own children; SIGKILL for one that ignores it. The same
// two-step (and the same grace) as intentic/intentic-runner.ts.
const KILL_GRACE_MS = 5_000;

const IDLE: PrepushRun = { status: "idle", command: "", output: "" };

export interface PrepushCheck {
    /* Start the check. Idempotent while one is already going — two clicks must never mean two suites fighting
     * over the same tree, the same ports and the same CPU.
     *
     * IT RESOLVES WHEN THE RUN IS VISIBLE TO `state`, not when the suite finishes. The route awaits it for
     * exactly that reason: the caller polls `state` the moment the POST returns, and a `run` that resolved
     * before the child existed handed that first poll an `idle` the dialog reads as "already settled" — a push
     * dialog that closed itself on a check it never waited for. The suite itself still outlives the request. */
    readonly run: () => Promise<void>;
    // The run as it stands, with the live output tail while it is going. What the push dialog polls.
    readonly state: () => Promise<PrepushRun>;
    readonly cancel: () => void;
    // Daemon shutdown: kill a live child, so a dying daemon doesn't leave a suite running.
    readonly stop: () => void;
}

// A tail-capped accumulator: append forever, keep the last `cap` bytes. The slice is O(cap) per chunk, which at
// 24 KB against a suite's output rate is nothing, and it keeps the buffer from tracking a build's whole log.
const tailBuffer = (cap: number): { readonly append: (chunk: string) => void; readonly read: () => string } => {
    let held = "";
    return {
        append: (chunk) => {
            held = (held + chunk).slice(-cap);
        },
        read: () => held,
    };
};

/* Signal a check's whole process TREE, via the group `detached` gave it (see `execute`). A pid that has already
 * gone takes ESRCH, which is the normal race between the watchdog firing and the suite finishing on its own —
 * there is nothing to report and nothing to do. `undefined` pid means the spawn itself failed; the `error`
 * listener has that covered. */
const killGroup = (pid: number | undefined, signal: NodeJS.Signals): void => {
    if (pid === undefined) {
        return;
    }
    try {
        process.kill(-pid, signal);
    } catch {
        // Already gone.
    }
};

// What this reaches for out of the daemon: sandboxSettings. Stated rather than taking Services whole,
// so a test stands up three seams instead of a hundred and thirty.
export type PrepushDeps = Pick<Services, "logger" | "sandboxSettings" | "workspace">;

/* THE ONE CHECK THIS PROCESS HAS. A module singleton because the routes (the dialog's clicks) and the shutdown
 * hook all have to reach the SAME live child, and there is only one main working tree for them to be about.
 * Tests build their own with createPrepushCheck instead, which is why that stays exported. */
let instance: PrepushCheck | undefined;
export const prepushCheck = (services: PrepushDeps): PrepushCheck => (instance ??= createPrepushCheck(services));

export const createPrepushCheck = (services: PrepushDeps): PrepushCheck => {
    const { logger, workspace } = services;
    let current: PrepushRun = IDLE;
    // The live run: its child (for cancel/kill), its buffer (a running state reads output from here), and the
    // promise every concurrent caller joins instead of starting a second suite.
    let child: ReturnType<typeof spawn> | undefined;
    let liveOutput: (() => string) | undefined;
    let running: Promise<PrepushRun> | undefined;
    // True from the moment `run` is entered until the child exists — the window `running` cannot cover, because
    // reading the settings is an await (see `run`).
    let starting = false;
    // Set by `cancel` and cleared by the next `run`, so a cancelled run reports as cancelled rather than as the
    // failure its own SIGTERM produced. A flag rather than a handle: cancel stays ignorant of which run it stops.
    let cancelled = false;

    const execute = async (command: string, timeoutMs: number): Promise<PrepushRun> => {
        const startedAt = Date.now();
        const buffer = tailBuffer(PREPUSH_OUTPUT_BYTES);
        /* `detached` MAKES THE CHILD A PROCESS-GROUP LEADER, and the whole timeout guarantee rests on it.
         *
         * `sh -c "<command>"` forks for anything it cannot exec directly, and a real check command is a process
         * TREE: pnpm spawns turbo, turbo spawns vitest, vitest spawns a worker per core. Signalling the pid
         * kills only `sh` — every descendant survives, holding the inherited stdout/stderr open, so `close` does
         * not fire until the suite finishes on its own. Measured: killing the pid of `sh -c "sleep 30"` at 150ms
         * still took the full 30s to close. That is the timeout silently not working, on exactly the runaway
         * suite it exists for.
         *
         * With a group of its own, one `process.kill(-pid)` reaches the entire tree. */
        const spawned = spawn("sh", ["-c", command], { cwd: workspace.root, env: process.env, detached: true });
        child = spawned;
        liveOutput = buffer.read;
        // Never spawned at all — no `sh`, an unreadable cwd, a fork failure. `error`, not `failed`: nothing was
        // learned about the code, so nobody should be sent to fix it. The child still emits `close` after this,
        // which is where the result is written; this only records WHY.
        let spawnError: string | undefined;
        spawned.on("error", (error: Error) => {
            spawnError = error.message;
        });
        /* EVERY LISTENER IS ATTACHED BEFORE THE NEXT AWAIT, and that ordering is load-bearing rather than
         * stylistic. `exit 1` from a typo'd command finishes in microseconds, and an EventEmitter does not
         * replay: a `close` listener attached on the far side of an await never fires at all, and the check sits
         * on `running` for the life of the daemon — with the push dialog spinning over it. */
        for (const stream of [spawned.stdout, spawned.stderr]) {
            stream.setEncoding("utf8");
            stream.on("data", (chunk: string) => buffer.append(chunk));
        }
        const closed = new Promise<[number | null, NodeJS.Signals | null]>((resolve) =>
            spawned.on("close", (exit, killedBy) => resolve([exit, killedBy])),
        );
        let timedOut = false;
        // Counted from the spawn — a ceiling measured from anywhere else is not the ceiling the setting promises.
        const watchdog = setTimeout(() => {
            timedOut = true;
            logger.warn({ command, pid: spawned.pid, timeoutMs }, "prepush: check timed out — killing");
            killGroup(spawned.pid, "SIGTERM");
            setTimeout(() => killGroup(spawned.pid, "SIGKILL"), KILL_GRACE_MS).unref();
        }, timeoutMs);
        watchdog.unref();
        logger.info({ command, pid: spawned.pid }, "prepush: check started");
        current = { status: "running", command, startedAt, output: "" };
        const [code, signal] = await closed;
        clearTimeout(watchdog);
        child = undefined;
        liveOutput = undefined;
        const output = buffer.read();
        // A run that died on a signal nobody asked for (the OOM killer, a crashed runner) is a failure of the
        // check, not a pass — its exit code is null, so this cannot be folded into `code !== 0`.
        const passed = code === 0 && !timedOut && signal === null;
        // A cancel that the watchdog caused is a TIMEOUT, not a cancellation — the user asked for neither, and
        // reporting it as cancelled would hide the one outcome this check most needs to be loud about.
        const status: PrepushRun["status"] = spawnError !== undefined ? "error" : cancelled && !timedOut ? "cancelled" : passed ? "passed" : "failed";
        const settled: PrepushRun = {
            status,
            command,
            startedAt,
            finishedAt: Date.now(),
            ...(code !== null ? { exitCode: code } : {}),
            ...(timedOut ? { timedOut: true } : {}),
            output: spawnError !== undefined ? `${command}: ${spawnError}` : output,
        };
        current = settled;
        logger.info({ command, status, exitCode: code, timedOut, durationMs: Date.now() - startedAt }, "prepush: check settled");
        return settled;
    };

    return {
        run: async () => {
            // `starting` and not just `running`: the settings read below is an await, so two calls in the same
            // tick would both find `running` unset and spawn a suite each. This flag is set before any await,
            // which is the only kind of guard that can hold across one.
            if (running !== undefined || starting) {
                return;
            }
            starting = true;
            try {
                const { prepushCommand, prepushTimeoutMs } = await services.sandboxSettings.get();
                // No command ⇒ nothing to run and nothing to say. The dialog never opens without one, so this is
                // the race where the setting was cleared between the click and the request.
                if (prepushCommand === "") {
                    current = IDLE;
                    return;
                }
                cancelled = false;
                // NOT awaited: `execute` runs synchronously as far as the spawn — which is where it publishes the
                // `running` state this function's caller is about to poll for — and only then awaits the suite.
                running = execute(prepushCommand, prepushTimeoutMs).finally(() => {
                    running = undefined;
                });
                running.catch((error: unknown) => logger.warn({ err: error }, "prepush: check failed"));
            } finally {
                starting = false;
            }
        },
        state: async () => {
            const { prepushCommand } = await services.sandboxSettings.get();
            // No command ⇒ the check is off, whatever the last run concluded. A result from before the setting
            // was cleared would otherwise gate a push on a check nobody can run any more.
            if (prepushCommand === "") {
                return IDLE;
            }
            if (current.status === "running" && liveOutput !== undefined) {
                return { ...current, output: liveOutput() };
            }
            return current;
        },
        cancel: () => {
            cancelled = true;
            const doomed = child?.pid;
            killGroup(doomed, "SIGTERM");
            setTimeout(() => killGroup(doomed, "SIGKILL"), KILL_GRACE_MS).unref();
        },
        stop: () => {
            // No grace on shutdown: the daemon is going, and there is nothing left to report a result to.
            killGroup(child?.pid, "SIGKILL");
        },
    };
};
