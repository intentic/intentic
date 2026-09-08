import { type ChildProcess, execFile, fork } from "node:child_process";
import { existsSync } from "node:fs";
import { availableParallelism } from "node:os";
import { promisify } from "node:util";
import type { ForkRequest, ForkResponse } from "./git-forker.js";

// Import this rather than re-wrapping execFile elsewhere.
export const exec = promisify(execFile);

// core.fileMode=false ignores upload-flattened permissions; --no-optional-locks keeps status off index.lock.
export const GIT_GLOBAL_ARGS = ["--no-optional-locks", "-c", "core.fileMode=false"] as const;

// Filenames after the last `--` get a `:(literal)` prefix so glob characters in real names (`[slug]`) cannot match
// siblings; PLUMBING_PATHS verbs take literal filenames already and are excluded.
const PLUMBING_PATHS = new Set(["update-index", "hash-object", "check-ignore", "check-attr"]);

export const literalPathspecs = (args: readonly string[]): readonly string[] => {
    const separator = args.lastIndexOf("--");
    if (separator === -1 || separator === args.length - 1 || PLUMBING_PATHS.has(subcommandOf(args) ?? "")) {
        return args;
    }
    return [...args.slice(0, separator + 1), ...args.slice(separator + 1).map((path) => `:(literal)${path}`)];
};

// execFile rejects stdout past 1 MiB by default; 16 MiB covers a large untracked tree without going unbounded.
const MAX_GIT_OUTPUT = 16 * 1024 * 1024;

// Retries only on index.lock contention (two writers); any other git failure surfaces on the first attempt.
const LOCK_CONTENTION = /index\.lock.*File exists|Unable to create.*\.lock/i;
const RETRY_ATTEMPTS = 6;

const isLockContention = (error: unknown): boolean => {
    const stderr = (error as { stderr?: unknown }).stderr;
    return typeof stderr === "string" && LOCK_CONTENTION.test(stderr);
};

// Runs a git subcommand in `dir`; injectable so callers are testable without a real repo, shared with the CLI's adopt.
// `env` merges over the process env, for flags with no CLI spelling (GIT_INDEX_FILE), and is optional.
export type GitRunner = (
    dir: string,
    args: readonly string[],
    env?: Readonly<Record<string, string>>,
) => Promise<{ readonly stdout: string; readonly stderr: string }>;

// git stdout as raw bytes, for `cat-file -p` on a non-text blob (an image diff); GitRunner's utf8 decode would corrupt
// it. No lock retry (a read takes no lock) and no forker (one-off interactive read, not the per-poll case it
// optimizes).
export const gitBytes = async (dir: string, args: readonly string[], maxBytes: number): Promise<Buffer> => {
    const { stdout } = await exec("git", [...GIT_GLOBAL_ARGS, "-C", dir, ...literalPathspecs(args)], { maxBuffer: maxBytes, encoding: "buffer" });
    return stdout;
};

// A resident child is forked once at startup; every later git forks from it instead of this process, whose fork cost
// scales with its own resident size. Falls back to exec'ing git directly if the child is unavailable or dies.
type GitOutput = { readonly stdout: string; readonly stderr: string };
// Cost of one invocation, not what the caller waited; internal only, GitRunner exposes just stdout/stderr.
type GitRun = GitOutput & { readonly execMs: number };
const inFlight = new Map<number, { readonly resolve: (value: GitRun) => void; readonly reject: (error: unknown) => void }>();
let forker: ChildProcess | undefined;
let forkerUnavailable = false;
let nextRequestId = 0;

// Refs the IPC channel only while a read is in flight, so an idle daemon or finished test is never held open.
const settle = (id: number): void => {
    inFlight.delete(id);
    if (inFlight.size === 0) {
        forker?.channel?.unref();
    }
};

// Rebuilds execFile's rejection shape; callers read `stderr` and `code` off the returned error.
const forkerFailure = (response: ForkResponse, failure: NonNullable<ForkResponse["failure"]>): Error =>
    Object.assign(new Error(failure.message), {
        ...(failure.code !== undefined ? { code: failure.code } : {}),
        stdout: response.stdout,
        stderr: response.stderr,
        // Included on failure too; a slow failing git and a stalled event loop are different incidents.
        execMs: response.execMs,
    });

// Zero when the failure happened before any child ran: a dead channel, or a fork that never started.
const failedExecMs = (error: unknown): number => {
    const reported = (error as { execMs?: unknown }).execMs;
    return typeof reported === "number" ? reported : 0;
};

// May not exist under the `src` export condition; checked once so a dead child isn't forked on every git call.
const forkerModule = new URL("./git-forker.js", import.meta.url);

const gitForker = (): ChildProcess | undefined => {
    if (forker !== undefined || forkerUnavailable) {
        return forker;
    }
    if (!existsSync(forkerModule)) {
        forkerUnavailable = true;
        return undefined;
    }
    // execArgv: [] keeps the child a bare forking stub; stderr is inherited so a dying child says why.
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
    // A dead forker's in-flight reads are rejected rather than left hanging; the next call starts a fresh child.
    started.on("exit", () => {
        forker = undefined;
        const orphaned = [...inFlight.values()];
        inFlight.clear();
        for (const waiting of orphaned) {
            waiting.reject(new Error("git forker exited"));
        }
    });
    // A fork that cannot start is not a git failure; every call falls back to exec'ing git directly.
    started.on("error", () => {
        forkerUnavailable = true;
    });
    started.unref();
    started.channel?.unref();
    forker = started;
    return forker;
};

// Bulk-only memory cap, not a scheduling one; interactive git is never queued, so agents can't slow the panel.
const BULK_SLOTS = Math.max(2, Math.floor(availableParallelism() / 4));

// Network verbs skip the bulk slot (latency, not memory); `remote`/`remote -v` read local config, so excluded.
const UNBOUNDED = new Set(["push", "fetch", "pull", "clone", "ls-remote", "submodule"]);

// First bare, non-flag word in args; not args[0], which is always a flag from GIT_GLOBAL_ARGS (e.g.
// --no-optional-locks).
const subcommandOf = (args: readonly string[]): string | undefined => {
    for (let index = 0; index < args.length; index += 1) {
        const arg = args[index]!;
        // -c and -C each take a separate value token; skip that token too.
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
// Resolvers woken in arrival order; a plain array, since this queue is empty or a few deep, never large.
const waitingBulk: (() => void)[] = [];

// Undefined means start now, keeping the uncontended case off the microtask queue; otherwise a promise for a slot.
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

/**
 * Agent-side git running vs. parked behind the bulk cap, for the daemon's resource series and the tests that pin the
 * cap. Interactive git is never queued, so there is nothing to report for it.
 */
export const gitSpawnStats = (): { readonly activeBulk: number; readonly queuedBulk: number; readonly bulkSlots: number } => ({
    activeBulk,
    queuedBulk: waitingBulk.length,
    bulkSlots: BULK_SLOTS,
});

const runGit = async (command: string, args: readonly string[], env: Readonly<Record<string, string>> | undefined): Promise<GitRun> => {
    // Merged, not replaced: execFile's `env` replaces the whole environment, and git needs PATH/HOME too.
    const resolved = env === undefined ? undefined : { ...process.env, ...env };
    const channel = gitForker();
    if (channel === undefined) {
        // No forker: this process execs git directly, so there is one clock, not the two the forked path needs.
        const from = process.hrtime.bigint();
        try {
            const output = await exec(command, [...args], { maxBuffer: MAX_GIT_OUTPUT, ...(resolved !== undefined ? { env: resolved } : {}) });
            return { ...output, execMs: Number(process.hrtime.bigint() - from) / 1e6 };
        } catch (error) {
            // Guards a non-object throw, which is rethrown untouched instead of being boxed.
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
            // The exit handler may already have rejected this id; settle/reject are then no-ops.
            if (error !== null) {
                settle(id);
                reject(error);
            }
        });
    });
};

// Holds a bulk slot for exactly as long as git runs, in one bracket with `finally`; a slot leaked here stalls
// agent-side git for good, and there is no timeout underneath to recover it.
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

// Every git call passes through this hook, covering callers that use `defaultGit` directly rather than a wrapped
// service. A callback, not a logger import, since this package is shared with the CLI.
export interface GitObservation {
    readonly dir: string;
    readonly args: readonly string[];
    readonly ms: number;
    // Summed over attempts; `ms - execMs` is time outside git itself (slot queue, IPC hop, event-loop delay).
    readonly execMs: number;
    // 1 for a clean first-try run; higher means the lock-retry loop spun (LOCK_CONTENTION).
    readonly attempts: number;
    readonly failed: boolean;
    // False means every spawn pays the parent's page-table copy cost; a regression if seen in a dist run.
    readonly forked: boolean;
    // Callers parked behind the bulk cap when this one finished; always zero for an interactive call.
    readonly queueDepth: number;
}

let gitObserver: ((observation: GitObservation) => void) | undefined;

/**
 * Reports every subsequent git invocation to `observer`; the daemon sets this at boot, CLI and tests leave it unset.
 */
export const observeGitCommands = (observer: (observation: GitObservation) => void): void => {
    gitObserver = observer;
};

const gitRunnerVia =
    (argv: readonly string[], bulk: boolean): GitRunner =>
    async (dir, args, env) => {
        const [command, ...rest] = argv;
        // Classified from the caller's args, not the full command: politeGit's nice/ionice prefix isn't a verb.
        const unbounded = UNBOUNDED.has(subcommandOf(args) ?? "");
        const from = process.hrtime.bigint();
        // Summed across attempts, not overwritten by the last one; each retry is a real git run.
        let execMs = 0;
        // Called on success and on throw; a failing git's duration matters as much as a succeeding one's.
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
                const output = await runGitSlotted(command!, [...rest, ...GIT_GLOBAL_ARGS, "-C", dir, ...literalPathspecs(args)], env, bulk, unbounded);
                execMs += output.execMs;
                observe(attempt, false);
                return { stdout: output.stdout, stderr: output.stderr };
            } catch (error) {
                execMs += failedExecMs(error);
                if (attempt >= RETRY_ATTEMPTS || !isLockContention(error)) {
                    observe(attempt, true);
                    throw error;
                }
                // Outside the bulk slot (already released); a caller backing off index.lock isn't using the machine.
                await new Promise((resolve) => setTimeout(resolve, attempt * attempt * 50));
            }
        }
    };

export const defaultGit: GitRunner = gitRunnerVia(["git"], false);

// CPU/IO demoted (nice +10, ionice best-effort) for bulk agent work; its ENOENT fallback is bulk-classed too.
const nicedGit: GitRunner = gitRunnerVia(["nice", "-n", "10", "ionice", "-c", "2", "-n", "7", "git"], true);
const plainBulkGit: GitRunner = gitRunnerVia(["git"], true);

// Falls back to plain bulk git if nice/ionice are missing (e.g. macOS dev); failing to start is worse than competing.
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
