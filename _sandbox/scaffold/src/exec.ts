import { type ChildProcess, execFile, fork } from "node:child_process";
import { existsSync } from "node:fs";
import { availableParallelism } from "node:os";
import { promisify } from "node:util";
import type { ForkRequest, ForkResponse } from "./git-forker.js";

// Shared promisified execFile, the most repeated one-liner across both apps (12+ files). Centralised here so
// consumers import one symbol instead of repeating the import + promisify dance.
export const exec = promisify(execFile);

// The policy flags every git invocation carries, whichever runner executes it.
//
// `core.fileMode=false`: workspace files arrive by browser upload, and the File API cannot expose Unix
// permissions, the packer stamps every entry 0644 (tarStream.ts), so executables committed as 100755 land
// 100644 and git reports each as a mode-only change. A dropped repo keeps its own .git (dropEntries.ts, so it
// stays connected to its remote), and the `filemode = true` that git init/clone writes there outranks system and
// global config, and is restored by the next upload. `-c` is the ONLY precedence that beats it.
//
// `--no-optional-locks`: a plain `git status` refreshes the stat cache, which takes .git/index.lock and rewrites
// .git/index. The daemon polls status on every workspace change, including while the browser is still uploading
// a dropped repo's own .git/index, two writers on one file. Reads must not mutate the repo they inspect, so the
// optional locks are off; the locks a commit/add genuinely needs are unaffected.
export const GIT_GLOBAL_ARGS = ["--no-optional-locks", "-c", "core.fileMode=false"] as const;

// Node's execFile buffers stdout and REJECTS past its default 1 MiB, which real git output clears easily: an
// `ls-files`/`status` over a workspace with a large untracked tree (an un-gitignored node_modules, a build dir,
// a repo mid-upload) blows the limit and the caller sees ERR_CHILD_PROCESS_STDIO_MAXBUFFER instead of a repo.
// 16 MiB is ~200k paths, past any tree a human reviews, and it matches what history.ts and iq-engine already
// pass. Not unbounded on purpose: a runaway git should fail, not exhaust the daemon's heap.
const MAX_GIT_OUTPUT = 16 * 1024 * 1024;

// Concurrency, not flakiness: `.git/index.lock` exists for the length of one index write, and in this product
// TWO writers share every worktree, the agent running `git add` in its turn and the owner clicking Stage in
// the panel. Whoever arrives second gets "Unable to create '.../index.lock': File exists", which is not an
// error about the repo, it is an error about the timing. Retry it (quadratic backoff, ~1.4s over 6 attempts,
// the shape VSCode's git extension settled on) and the loser simply proceeds a moment later.
//
// Only that one message retries. A genuinely failed command, bad ref, conflict, rejected push, must surface
// on its first attempt, because retrying it would just make the user wait to be told the same thing.
const LOCK_CONTENTION = /index\.lock.*File exists|Unable to create.*\.lock/i;
const RETRY_ATTEMPTS = 6;

const isLockContention = (error: unknown): boolean => {
    const stderr = (error as { stderr?: unknown }).stderr;
    return typeof stderr === "string" && LOCK_CONTENTION.test(stderr);
};

// Runs a git subcommand inside `dir`; injectable so git operations are unit-testable without a real repo.
// Shared between the sandbox's git module and the CLI's adopt.
//
// `env` is MERGED over the daemon's own, for the handful of git behaviours that have no command-line spelling,
// GIT_INDEX_FILE above all, which is how the checkpoint snapshot stages a worktree into an index of its own
// (history/history.ts) without touching the one the user stages into. Optional, so every existing runner and
// every test double stays assignable unchanged.
export type GitRunner = (
    dir: string,
    args: readonly string[],
    env?: Readonly<Record<string, string>>,
) => Promise<{ readonly stdout: string; readonly stderr: string }>;

// git's stdout as RAW BYTES, for `cat-file -p` on a blob that is not text, an image side of a diff, which the
// browser renders from the bytes themselves. GitRunner cannot serve that read at all: it decodes stdout as
// utf8, which replaces every invalid sequence with U+FFFD, so a PNG comes back corrupted rather than merely
// unreadable. `maxBytes` is the caller's own cap (the route 413s above it), not this module's policy.
//
// No lock retry, unlike defaultGit: the object store is append-only and a worktree file read takes no lock, so
// there is no index.lock contention to lose. Nor does it go through the resident forker below, bytes would
// have to be base64'd across the IPC channel, and this read serves an interactive file open (one spawn), never
// the per-poll storm the forker exists for.
export const gitBytes = async (dir: string, args: readonly string[], maxBytes: number): Promise<Buffer> => {
    const { stdout } = await exec("git", [...GIT_GLOBAL_ARGS, "-C", dir, ...args], { maxBuffer: maxBytes, encoding: "buffer" });
    return stdout;
};

/* THE RESIDENT FORKER, why this module does not call execFile directly any more.
 *
 * fork() copies the page tables of whoever calls it, so what a spawn COSTS is set by the resident size of the
 * process doing the spawning, and the parent pays it synchronously, on its event loop. Measured in this
 * daemon, forking the same `git`: 1.5 ms from a 55 MB process, 9.6 ms at 476 MB, 26.9 ms at the 1.8 GB it
 * actually runs at (the iq engine's worker, chokidar's worker and the provider SDK streams all share that
 * address space). The Changes review fires hundreds of git reads per scan, so the multiplier was whole seconds
 * of frozen control plane per poll, every one of them showing up as a loop-watchdog stall with quiet PSI and
 * no DNS in flight, which is the signature that means "this process".
 *
 * So the daemon stops forking git. One child starts on the first git call and stays; it holds nothing but
 * node's own baseline (git-forker.ts is deliberately import-free), and every git after that forks from ~50 MB.
 * The expensive fork is paid exactly once, at startup.
 *
 * It is a transparent optimisation and never a dependency. A child that cannot start (no dist beside this
 * file, a sandbox that forbids the fork) or that dies mid-flight leaves this module exec'ing git directly,
 * which is exactly what it did before the forker existed.
 */
type GitOutput = { readonly stdout: string; readonly stderr: string };
// What one invocation cost, as opposed to what the caller waited: see ForkResponse.execMs for why the two are
// different numbers and why only the far side can answer the first. Internal to this module, the exported
// GitRunner still hands back stdout/stderr and nothing else.
type GitRun = GitOutput & { readonly execMs: number };
const inFlight = new Map<number, { readonly resolve: (value: GitRun) => void; readonly reject: (error: unknown) => void }>();
let forker: ChildProcess | undefined;
let forkerUnavailable = false;
let nextRequestId = 0;

// The IPC channel is the only handle keeping the loop alive for an outstanding read, so it is referenced
// exactly while one is in flight: a CLI whose last act is a git call still waits for it, and an idle daemon (or
// a finished test) is never held open by a forker with nothing left to do.
const settle = (id: number): void => {
    inFlight.delete(id);
    if (inFlight.size === 0) {
        forker?.channel?.unref();
    }
};

// execFile's rejection, rebuilt from the wire, callers read `stderr` (isLockContention below, the daemon's
// gitFailureReason) and `code` (politeGit's ENOENT fallback) off the error object itself.
const forkerFailure = (response: ForkResponse, failure: NonNullable<ForkResponse["failure"]>): Error =>
    Object.assign(new Error(failure.message), {
        ...(failure.code !== undefined ? { code: failure.code } : {}),
        stdout: response.stdout,
        stderr: response.stderr,
        // Rides the failure too: a git that fails after eight seconds is the most useful line in an incident
        // log, and "eight seconds of git" and "eight seconds of stalled loop" are different incidents.
        execMs: response.execMs,
    });

// The far side's clock off a rejection, for the observation. Zero when the failure happened before any child
// ran at all (a dead channel, a fork that never started), which is honest: nothing executed.
const failedExecMs = (error: unknown): number => {
    const reported = (error as { execMs?: unknown }).execMs;
    return typeof reported === "number" ? reported : 0;
};

/* The compiled child, beside this file, and the one case where it legitimately is not there. Packages here
 * expose an `@intentic/src` export condition, so a test or a dev run imports THIS file as `src/exec.ts`, where
 * the sibling `git-forker.js` does not exist (only its .ts source does, which node cannot fork). Forking it
 * anyway would spawn a child that dies of ERR_MODULE_NOT_FOUND, per git call, forever. One sync stat answers
 * "am I running from dist" once, and every caller in a src-condition run simply execs git directly. */
const forkerModule = new URL("./git-forker.js", import.meta.url);

const gitForker = (): ChildProcess | undefined => {
    if (forker !== undefined || forkerUnavailable) {
        return forker;
    }
    if (!existsSync(forkerModule)) {
        forkerUnavailable = true;
        return undefined;
    }
    // `execArgv: []` so the child inherits none of the daemon's own node flags, it is a forking stub, and
    // anything that grows its heap is paid back on every git call the workspace makes. Its stderr is inherited
    // so a child that dies says why; its stdout would only ever be node's, and git's rides the channel.
    const started = fork(forkerModule, { execArgv: [], stdio: ["ignore", "ignore", "inherit", "ipc"] });
    started.on("message", (message) => {
        const response = message as ForkResponse;
        const waiting = inFlight.get(response.id);
        if (waiting === undefined) {
            return;
        }
        settle(response.id);
        if (response.failure !== undefined) {
            waiting.reject(forkerFailure(response, response.failure));
            return;
        }
        waiting.resolve({ stdout: response.stdout, stderr: response.stderr, execMs: response.execMs });
    });
    // A dead forker takes its in-flight reads with it, fail them rather than leave callers hanging forever,
    // and drop the handle so the next call starts a fresh one.
    started.on("exit", () => {
        forker = undefined;
        const orphaned = [...inFlight.values()];
        inFlight.clear();
        for (const waiting of orphaned) {
            waiting.reject(new Error("git forker exited"));
        }
    });
    // A fork that cannot even start is not a git failure, stop trying and let every call exec directly.
    started.on("error", () => {
        forkerUnavailable = true;
    });
    started.unref();
    started.channel?.unref();
    forker = started;
    return forker;
};

/* THE SPAWN CAP, the other half of the forker's argument.
 *
 * The forker made each spawn cheap; nothing made the NUMBER of them bounded. `git-forker.ts` execs whatever
 * arrives the instant it arrives, so a Changes scan over six repos, a fleet-wide standing pass and three agents
 * starting turns all run at once. The obvious next move is a slot queue over ALL of it. That was measured, and
 * it is wrong, which is worth recording so nobody re-derives it: 512 reads against this workspace take 581ms
 * through the forker unbounded and 1,443ms behind a 14-slot queue. The kernel is a better scheduler than a
 * promise chain, and a slot queue adds an event-loop round trip per wave that the unbounded path pipelines
 * away. Capping interactive git makes the panel slower, full stop.
 *
 * What is NOT free is the other class. `politeGit` marks work done in bulk on an agent's behalf, and one
 * conversation's turn-start checkout is the whole monorepo hitting the disk; several conversations start
 * together. That work is already demoted with `nice`/`ionice`, which is the scheduler's answer and covers CPU
 * and IO, and covers memory not at all: concurrent gits have been observed holding 682MB resident together on
 * a box whose processes already peak at 25GB against 20GB of RAM, and that overcommit is what pushes the
 * DAEMON's own pages into swap, which is what turns a garbage collection into the multi-second stall every
 * inflated number in the perf log actually is.
 *
 * So the cap is on BULK ONLY, and it is a memory bound rather than a scheduling one. Interactive git, every
 * read the browser is waiting on, is never queued by this module and runs exactly as fast as it did before.
 * A fleet of agents starting cannot flood the machine; nothing an agent does can make the panel wait.
 *
 * NETWORK SUBCOMMANDS DO NOT TAKE A SLOT AT ALL, even in bulk. A fetch against a slow remote is latency, not
 * work: it holds nothing but a socket, so a handful of them would idle out the whole bulk allowance while
 * consuming none of the memory it exists to bound. */
const BULK_SLOTS = Math.max(2, Math.floor(availableParallelism() / 4));

/* Latency-bound, not memory-bound: these wait on a remote, so a slot spent on one bounds nothing.
 *
 * `remote` is deliberately NOT here, though it looks like it belongs: `git remote` and `git remote -v` read
 * local config and nothing else (they are 1,503 of the slow ops in the log, all of them 1ms commands), and the
 * one spelling that does touch the network, `remote update`, has no caller in this workspace. Listing the verb
 * would exempt the reads and catch nothing. */
const UNBOUNDED = new Set(["push", "fetch", "pull", "clone", "ls-remote", "submodule"]);

/* Which git verb this is, which is NOT `args[0]`: every call carries GIT_GLOBAL_ARGS, so the first token is
 * `--no-optional-locks` and the third is a `-c core.fileMode=false` pair, and a naive read classifies the whole
 * daemon as running a subcommand called `-c`. (The perf log shows exactly that: 1,417 slow ops filed under
 * `--no-optional-locks` and 99 under `-c`.) Skip flags, skip the value that follows a `-c`, take the first bare
 * word. `-C <dir>` is skipped by the same rule. */
const subcommandOf = (args: readonly string[]): string | undefined => {
    for (let index = 0; index < args.length; index += 1) {
        const arg = args[index]!;
        // The one-letter options this module itself passes, each of which takes a separate value token.
        if (arg === "-c" || arg === "-C") {
            index += 1;
            continue;
        }
        if (!arg.startsWith("-")) {
            return arg;
        }
    }
    return undefined;
};

let activeBulk = 0;
// Woken in arrival order. A plain array: this holds resolvers for a queue that is empty in the steady state
// and tens deep at its worst, never the thousands a real structure would earn.
const waitingBulk: (() => void)[] = [];

// A slot, or a promise for one. Undefined return means "start now", which keeps the uncontended case off the
// microtask queue entirely rather than paying a promise per call to express "there was nothing to wait for".
const acquireBulk = (): Promise<void> | undefined => {
    if (activeBulk < BULK_SLOTS) {
        activeBulk += 1;
        return undefined;
    }
    return new Promise<void>((resolve) => waitingBulk.push(resolve));
};

const releaseBulk = (): void => {
    activeBulk -= 1;
    const next = waitingBulk.shift();
    if (next === undefined) {
        return;
    }
    activeBulk += 1;
    next();
};

/** How much agent-side git is running and how much is parked behind the bulk cap. Exported for the daemon's
 *  resource series and for the tests that pin the cap: a queue standing above zero across samples is what
 *  separates "git is slow" from "git was never started", and it is unknowable from outside this module.
 *  Interactive git is absent by design, nothing here queues it, so there is no number to report. */
export const gitSpawnStats = (): { readonly activeBulk: number; readonly queuedBulk: number; readonly bulkSlots: number } => ({
    activeBulk,
    queuedBulk: waitingBulk.length,
    bulkSlots: BULK_SLOTS,
});

const runGit = async (command: string, args: readonly string[], env: Readonly<Record<string, string>> | undefined): Promise<GitRun> => {
    // Merged, never replaced: execFile's `env` REPLACES the child's whole environment, and git without
    // PATH/HOME finds neither its helpers nor its config.
    const resolved = env === undefined ? undefined : { ...process.env, ...env };
    const channel = gitForker();
    if (channel === undefined) {
        /* No forker: THIS process execs git, so its own clock is the child's. There is no IPC hop to cross and
         * no second loop between the exit and the callback, which is exactly what makes the forked path's two
         * clocks worth reporting separately and this one's not. */
        const from = process.hrtime.bigint();
        try {
            const output = await exec(command, [...args], { maxBuffer: MAX_GIT_OUTPUT, ...(resolved !== undefined ? { env: resolved } : {}) });
            return { ...output, execMs: Number(process.hrtime.bigint() - from) / 1e6 };
        } catch (error) {
            // Only ever an execFile Error in practice; the typeof guard is so a non-object throw is rethrown
            // untouched rather than boxed into a wrapper that loses whatever it was.
            if (typeof error === "object" && error !== null) {
                Object.assign(error, { execMs: Number(process.hrtime.bigint() - from) / 1e6 });
            }
            throw error;
        }
    }
    const id = nextRequestId;
    nextRequestId += 1;
    const request: ForkRequest = { id, command, args, maxBuffer: MAX_GIT_OUTPUT, ...(resolved !== undefined ? { env: resolved } : {}) };
    return await new Promise<GitRun>((resolve, reject) => {
        inFlight.set(id, { resolve, reject });
        channel.channel?.ref();
        channel.send(request, (error) => {
            // The channel closed between the check above and the write, the exit handler may already have
            // rejected this id, and settle/reject are both no-ops once it has.
            if (error !== null) {
                settle(id);
                reject(error);
            }
        });
    });
};

/* One invocation, holding a bulk slot for exactly as long as git is running. Separate from `runGit` so the
 * acquire and the release are one bracket a reader can check: a slot leaked here stops the daemon's agent-side
 * git for good, and there is no timeout underneath to paper over it. The `finally` covers the throw, which is
 * the path that matters, git fails for ordinary reasons dozens of times a minute (a missing ref, a repo
 * mid-upload). Interactive work never reaches the queue at all, it is the first branch. */
const runGitSlotted = async (
    command: string,
    args: readonly string[],
    env: Readonly<Record<string, string>> | undefined,
    bulk: boolean,
    unbounded: boolean,
): Promise<GitRun> => {
    if (!bulk || unbounded) {
        return await runGit(command, args, env);
    }
    await acquireBulk();
    try {
        return await runGit(command, args, env);
    } finally {
        releaseBulk();
    }
};

/* THE MEASUREMENT SEAM. Every git this process runs passes through the loop below, both exported runners are
 * built from it, and the 70-odd call sites that take `git: GitRunner = defaultGit` are covered by construction.
 * That is the whole reason the hook lives here rather than being wrapped on around the daemon's service object:
 * a wrapper there would have measured the handful of calls that go through `services.git` and silently missed
 * every module that reaches for `defaultGit` itself, which is most of them.
 *
 * A callback rather than a logger import, because this package is shared with the CLI and must not acquire a
 * pino dependency (nor an opinion about where lines go). Unset by default, nothing is measured until a host
 * asks, and an unset hook costs one undefined check per git call.
 *
 * `attempts` is what the caller cannot see from outside: a read that reports 1.4s having retried six times lost
 * that time to index.lock contention with another writer, not to git being slow, and those two have completely
 * different fixes. */
export interface GitObservation {
    readonly dir: string;
    readonly args: readonly string[];
    readonly ms: number;
    /* HOW MUCH OF `ms` WAS GIT, summed over the attempts. `ms - execMs` is everything else: the slot queue, the
     * IPC hop, and, dominating both, however long this process's event loop was away before it read the result.
     *
     * The two were one number until a performance review read `git.run mean 77ms` off the summary and concluded
     * the repositories were slow. They are not: the same commands, run at a shell against the same workspace,
     * are 1-9ms, and the log's own `for-each-ref ... 3500ms` is a 2ms read that spanned a garbage collection.
     * A measurement that cannot tell those apart does not merely lack detail, it points at the wrong subsystem,
     * and it pointed at this one for two days. Same split, same reason, as git.lock.wait against
     * git.lock.hold one layer up. */
    readonly execMs: number;
    // 1 for a clean first-try run; higher means the lock retry loop below spun (see LOCK_CONTENTION).
    readonly attempts: number;
    readonly failed: boolean;
    // Whether the resident forker served it. False means every spawn is paying the parent's page-table copy,
    // the exact cost the forker exists to avoid, and a real regression when it shows up in a dist run.
    readonly forked: boolean;
    // Agent-side callers parked behind the bulk cap when this one finished. Non-zero means the cap was binding
    // and the fan-out above it is what to look at. Always zero on an interactive call, which is never queued.
    readonly queueDepth: number;
}

let gitObserver: ((observation: GitObservation) => void) | undefined;

/** Report every subsequent git invocation to `observer`. The daemon points this at its perf tracker at boot;
 *  the CLI and tests leave it unset. */
export const observeGitCommands = (observer: (observation: GitObservation) => void): void => {
    gitObserver = observer;
};

const gitRunnerVia =
    (argv: readonly string[], bulk: boolean): GitRunner =>
    async (dir, args, env) => {
        const [command, ...rest] = argv;
        // Classified from the CALLER's args, never the assembled command line: `politeGit` prefixes `nice -n 10
        // ionice -c 2 -n 7`, whose first bare token is `10`, and this runner's own GIT_GLOBAL_ARGS sit in front
        // of everything either way. The caller's args are the only list whose first bare word is a git verb.
        const unbounded = UNBOUNDED.has(subcommandOf(args) ?? "");
        const from = process.hrtime.bigint();
        // Summed across attempts, not overwritten by the last one: six lock-contended tries are six real git
        // runs, and charging the caller for only the last of them would credit the backoff to the event loop.
        let execMs = 0;
        // Reported whether the call succeeds or throws: a git that fails after 8 seconds is the single most
        // useful line in an incident log, and measuring only the happy path is how it stays missing.
        const observe = (attempts: number, failed: boolean): void => {
            gitObserver?.({
                dir,
                args,
                ms: Number(process.hrtime.bigint() - from) / 1e6,
                execMs,
                attempts,
                failed,
                forked: forker !== undefined,
                queueDepth: waitingBulk.length,
            });
        };
        for (let attempt = 1; ; attempt += 1) {
            try {
                const output = await runGitSlotted(command!, [...rest, ...GIT_GLOBAL_ARGS, "-C", dir, ...args], env, bulk, unbounded);
                execMs += output.execMs;
                observe(attempt, false);
                return { stdout: output.stdout, stderr: output.stderr };
            } catch (error) {
                execMs += failedExecMs(error);
                if (attempt >= RETRY_ATTEMPTS || !isLockContention(error)) {
                    observe(attempt, true);
                    throw error;
                }
                // Outside the slot on purpose (runGitSlotted released it on the way out): a caller sleeping off
                // another writer's index.lock is not using the machine, and holding a slot through the backoff
                // would let six contended writes idle out a third of the cap.
                await new Promise((resolve) => setTimeout(resolve, attempt * attempt * 50));
            }
        }
    };

export const defaultGit: GitRunner = gitRunnerVia(["git"], false);

/* The same runner, demoted, and the two forms it takes are built once rather than per call. CPU nice +10, IO
 * best-effort lowest. For git work done ON BEHALF OF agents in bulk (a conversation's worktree checkout is the
 * whole monorepo hitting the disk at once, and several start together): priorities only bind under contention,
 * and contention is exactly when the daemon's own loop, the thing serving every browser, must win.
 *
 * Both spellings are BULK-classed, including the fallback. Demotion and the spawn cap's bulk ceiling are the
 * same policy expressed against two different resources (the scheduler's, and this module's), so a checkout
 * that loses `ionice` must not silently gain a claim on half the slot queue as its consolation. */
const nicedGit: GitRunner = gitRunnerVia(["nice", "-n", "10", "ionice", "-c", "2", "-n", "7", "git"], true);
const plainBulkGit: GitRunner = gitRunnerVia(["git"], true);

// Falls back to plain git where the wrappers don't exist (macOS dev has no ionice), because a checkout that
// fails to start is worse than one that competes.
export const politeGit: GitRunner = async (dir, args, env) => {
    try {
        return await nicedGit(dir, args, env);
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
            return await plainBulkGit(dir, args, env);
        }
        throw error;
    }
};
