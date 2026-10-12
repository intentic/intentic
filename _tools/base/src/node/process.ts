import { type ChildProcess, type SpawnOptions, spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import { sleep } from "../async.js";
import { errnoCode } from "../errors.js";

// ONE BOUNDED CHILD PROCESS, AS EVERY NODE TIER OUTSIDE THE DAEMON RUNS ONE: its own process group, ended whole at its
// deadline or an abort, settled once it has exited even if a grandchild still holds its pipes, and its output kept in
// bounded memory. The device agent's shell and adb runners each had their own copy of these rules, and the sync
// runner beside them had none of them: it SIGKILLed only its direct child and waited for `close`, so a background
// process holding the pipe kept the call open past its own timeout, and it buffered without limit. The daemon has its
// own door (`runCheck`, which also schedules by workload class) and does not use this.

// Characters kept per stream by default: generous, since callers parse what comes back (JSON from a CLI, a file
// list), and a cut answer is only better than an unbounded one when it is too big to be meant.
export const DEFAULT_MAX_OUTPUT = 8 * 1024 * 1024;
// How long the pipes may stay quiet once the command has exited. Whatever holds them after that was left running in
// the background, and does not get to hold the call open until it ends.
const PIPE_QUIET_MS = 1_000;
// However chatty that leftover is, the call ends this long after the command did.
const PIPE_LINGER_MS = 5_000;
const PIPE_POLL_MS = 50;
// How long a stopped command's processes get to act on SIGTERM before SIGKILL.
const KILL_GRACE_MS = 2_000;

export interface CollectedOutput {
    readonly text: string;
    // Characters left out of the middle; the text marks where.
    readonly dropped: number;
}

export interface RunOptions {
    readonly cwd?: string | undefined;
    // The child's whole environment, as spawn takes it; absent inherits this process's.
    readonly env?: NodeJS.ProcessEnv | undefined;
    // Milliseconds before the command and everything it started are stopped; absent is no deadline.
    readonly timeoutMs?: number | undefined;
    readonly signal?: AbortSignal | undefined;
    // Written to stdin, which is then closed. Absent, stdin is closed from the start: anything that asks a question
    // reads EOF and fails fast instead of waiting out the deadline.
    readonly input?: string | Buffer | undefined;
    // Characters kept per stream, half from the start and half from the end.
    readonly maxOutput?: number | undefined;
    readonly killGraceMs?: number | undefined;
    // Told the child once it is spawned, for a caller that tracks what it has running (to stop it on shutdown).
    readonly onSpawn?: ((child: ChildProcess) => void) | undefined;
}

export interface ProcessResult<Out = CollectedOutput> {
    // Null when the command was ended by a signal or never started.
    readonly exitCode: number | null;
    readonly exitSignal: NodeJS.Signals | null;
    readonly stdout: Out;
    readonly stderr: CollectedOutput;
    readonly timedOut: boolean;
    readonly aborted: boolean;
    // Something the command started still held its output after it exited, and the call returned without waiting.
    readonly lingering: boolean;
    // The command could not be started at all (a missing binary is `ENOENT` here), never thrown.
    readonly spawnError?: Error;
}

// One stream in bounded memory: the head, a rolling tail, and a count of what fell between. Decoded as a stream, so a
// character split across two chunks arrives whole.
// Where one stream's chunks go and what it amounts to once the command is done.
export interface OutputSink<Out> {
    readonly write: (chunk: Buffer) => void;
    readonly end: () => Out;
}

export interface CollectedBytes {
    readonly bytes: Buffer;
    // Bytes past the limit, counted and not kept.
    readonly dropped: number;
}

export const textCollector = (maxOutput: number): OutputSink<CollectedOutput> => {
    const decoder = new StringDecoder("utf8");
    const half = Math.floor(maxOutput / 2);
    let head = "";
    let tail = "";
    let dropped = 0;
    const take = (text: string): void => {
        const room = Math.max(half - head.length, 0);
        head += text.slice(0, room);
        tail += text.slice(room);
        if (tail.length > half) {
            dropped += tail.length - half;
            tail = tail.slice(-half);
        }
    };
    return {
        write: (chunk) => take(decoder.write(chunk)),
        end: () => {
            take(decoder.end());
            return { text: dropped === 0 ? `${head}${tail}` : `${head}\n… [${dropped} characters cut] …\n${tail}`, dropped };
        },
    };
};

// A text already in hand, cut the same way: for output that arrived whole (a byte stream read as text afterwards).
export const clipText = (text: string, maxOutput: number): CollectedOutput => {
    if (text.length <= maxOutput) {
        return { text, dropped: 0 };
    }
    const half = Math.floor(maxOutput / 2);
    const dropped = text.length - half * 2;
    return { text: `${text.slice(0, half)}\n… [${dropped} characters cut] …\n${text.slice(-half)}`, dropped };
};

// Raw bytes up to a limit, the rest counted: for output that is not text (a screenshot), where a cut middle would be
// a corrupt file rather than a shorter one.
const byteCollector = (limit: number): OutputSink<CollectedBytes> => {
    const chunks: Buffer[] = [];
    let kept = 0;
    let dropped = 0;
    return {
        write: (chunk) => {
            const room = Math.max(limit - kept, 0);
            if (room > 0) {
                const part = chunk.length <= room ? chunk : chunk.subarray(0, room);
                chunks.push(part);
                kept += part.length;
            }
            dropped += chunk.length - Math.min(chunk.length, room);
        },
        end: () => ({ bytes: Buffer.concat(chunks), dropped }),
    };
};

const delay = (ms: number): Promise<void> => sleep(ms, { unref: true });

const signalGroup = (pid: number, signal: NodeJS.Signals): void => {
    try {
        process.kill(-pid, signal);
    } catch (error) {
        // ESRCH: nothing of the group is left to signal, which is what stopping it was for. Anything else is a fault.
        if (errnoCode(error) !== "ESRCH") {
            throw error;
        }
    }
};

const GROUP_POLL_MS = 25;

// Signal 0 asks only whether the group still has a member: ESRCH is the answer "none"; EPERM means a member exists
// that this process may not signal, so it is still there.
const groupAlive = (pid: number): boolean => {
    try {
        process.kill(-pid, 0);
        return true;
    } catch (error) {
        return errnoCode(error) !== "ESRCH";
    }
};

// Everything the command started, not only its direct child: SIGTERM to its process group, then SIGKILL to what is
// left. Windows has no process groups, and no SIGTERM a console program hears, so taskkill ends the whole tree at once.
export const stopProcessTree = async (child: ChildProcess, killGraceMs: number = KILL_GRACE_MS): Promise<void> => {
    const pid = child.pid;
    if (pid === undefined) {
        return;
    }
    if (process.platform === "win32") {
        await new Promise<void>((resolve) => {
            spawn("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true })
                .once("exit", () => resolve())
                .once("error", () => resolve());
        });
        // The child at least, should taskkill have failed; a no-op once it has done its job.
        child.kill();
        return;
    }
    signalGroup(pid, "SIGTERM");
    // Only as long as something of the group is left: a command that heeds SIGTERM is reported stopped at once rather
    // than after the whole grace.
    const until = Date.now() + killGraceMs;
    while (groupAlive(pid) && Date.now() < until) {
        await delay(GROUP_POLL_MS);
    }
    signalGroup(pid, "SIGKILL");
};

const spawnOptions = (options: RunOptions): SpawnOptions => {
    const spawned: SpawnOptions = {
        stdio: [options.input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
        // A process group of its own, which a deadline ends whole. On Windows this would open a console window
        // instead, and taskkill /T finds the tree without one.
        detached: process.platform !== "win32",
        windowsHide: true,
    };
    if (options.cwd !== undefined) {
        spawned.cwd = options.cwd;
    }
    if (options.env !== undefined) {
        spawned.env = options.env;
    }
    return spawned;
};

// The child as it starts, or why it could not: spawn throws synchronously for arguments it refuses (a NUL byte).
const start = (command: string, args: readonly string[], options: RunOptions): ChildProcess | Error => {
    try {
        return spawn(command, [...args], spawnOptions(options));
    } catch (error) {
        return error instanceof Error ? error : new Error(String(error));
    }
};

interface Stopper {
    readonly timedOut: () => boolean;
    readonly aborted: () => boolean;
    // Settles once a stop that began has run its course; at once when none did.
    readonly stopped: () => Promise<void>;
    readonly dispose: () => void;
}

// The deadline and the abort, each ending the whole tree, and each remembered so the result can say which it was.
const stopperFor = (child: ChildProcess, options: RunOptions): Stopper => {
    let stopping: Promise<void> | undefined;
    let timedOut = false;
    let aborted = false;
    const stop = (): void => {
        stopping ??= stopProcessTree(child, options.killGraceMs);
    };
    const deadline =
        options.timeoutMs === undefined
            ? undefined
            : setTimeout(() => {
                  timedOut = true;
                  stop();
              }, options.timeoutMs);
    const onAbort = (): void => {
        aborted = true;
        stop();
    };
    options.signal?.addEventListener("abort", onAbort, { once: true });
    return {
        timedOut: () => timedOut,
        aborted: () => aborted,
        stopped: async () => {
            await stopping;
        },
        dispose: () => {
            clearTimeout(deadline);
            options.signal?.removeEventListener("abort", onAbort);
        },
    };
};

// Done once the pipes close, or once they have gone quiet with the command already gone, or at the linger bound.
// False means something else still holds them, and they were let go.
const drain = async (child: ChildProcess, closed: Promise<true>, lastData: () => number): Promise<boolean> => {
    const exitedAt = Date.now();
    for (;;) {
        if (await Promise.race([closed, delay(PIPE_POLL_MS).then(() => false)])) {
            return true;
        }
        const now = Date.now();
        if (now - lastData() >= PIPE_QUIET_MS || now - exitedAt >= PIPE_LINGER_MS) {
            child.stdout?.destroy();
            child.stderr?.destroy();
            return false;
        }
    }
};

type Ending = { readonly code: number | null; readonly signal: NodeJS.Signals | null } | Error;

const run = async <Out>(command: string, args: readonly string[], options: RunOptions, stdout: OutputSink<Out>): Promise<ProcessResult<Out>> => {
    const stderr = textCollector(options.maxOutput ?? DEFAULT_MAX_OUTPUT);
    const failed = (spawnError: Error, aborted: boolean): ProcessResult<Out> => ({
        exitCode: null,
        exitSignal: null,
        stdout: stdout.end(),
        stderr: stderr.end(),
        timedOut: false,
        aborted,
        lingering: false,
        spawnError,
    });
    if (options.signal?.aborted === true) {
        return failed(new Error(`${command} was not started: the call was aborted`), true);
    }
    const child = start(command, args, options);
    if (child instanceof Error) {
        return failed(child, false);
    }
    options.onSpawn?.(child);
    let lastData = Date.now();
    const heard =
        (sink: OutputSink<unknown>) =>
        (chunk: Buffer): void => {
            lastData = Date.now();
            sink.write(chunk);
        };
    child.stdout?.on("data", heard(stdout));
    child.stderr?.on("data", heard(stderr));
    if (options.input !== undefined && child.stdin !== null) {
        // A command that exits without reading its input closes the pipe under the write; that is its answer, not ours.
        child.stdin.on("error", () => undefined);
        child.stdin.end(options.input);
    }
    // Listened for from the start: `close` can follow `exit` within the same tick.
    const closed = new Promise<true>((resolve) => child.once("close", () => resolve(true)));
    const stopper = stopperFor(child, options);
    const ended = await new Promise<Ending>((resolve) => {
        child.once("exit", (code, signal) => resolve({ code, signal }));
        child.once("error", (error) => resolve(error));
    });
    stopper.dispose();
    if (ended instanceof Error) {
        return failed(ended, stopper.aborted());
    }
    await stopper.stopped();
    const drained = await drain(child, closed, () => lastData);
    return {
        exitCode: ended.code,
        exitSignal: ended.signal,
        stdout: stdout.end(),
        stderr: stderr.end(),
        timedOut: stopper.timedOut(),
        aborted: stopper.aborted(),
        lingering: !drained,
    };
};

// Runs a command to its end, never throwing: a non-zero exit, a deadline, an abort and a spawn failure are all in the
// result, each said one way.
export const runBounded = async (command: string, args: readonly string[], options: RunOptions = {}): Promise<ProcessResult> =>
    await run(command, args, options, textCollector(options.maxOutput ?? DEFAULT_MAX_OUTPUT));

// The same, with stdout kept as raw bytes up to `maxStdoutBytes` (the rest counted in `dropped`).
export const runBoundedBytes = async (
    command: string,
    args: readonly string[],
    options: RunOptions & { readonly maxStdoutBytes: number },
): Promise<ProcessResult<CollectedBytes>> =>
    await run(command, args, options, byteCollector(options.maxStdoutBytes));

// A failed command in execFile's rejection shape, so a caller moving off `promisify(execFile)` keeps reading `code`
// (the exit code, or the errno a spawn failed with), `stdout` and `stderr` off what it catches.
export class ProcessError extends Error {
    readonly code: number | string | undefined;
    readonly killed: boolean;
    readonly signal: NodeJS.Signals | null;
    readonly stdout: string;
    readonly stderr: string;
    readonly timedOut: boolean;

    constructor(command: string, args: readonly string[], result: ProcessResult) {
        const line = [command, ...args].join(" ");
        const reason =
            result.spawnError !== undefined
                ? result.spawnError.message
                : result.timedOut
                  ? "it ran past its deadline and was stopped"
                  : result.aborted
                    ? "it was aborted"
                    : `exit ${result.exitCode ?? result.exitSignal ?? "unknown"}`;
        super(`Command failed: ${line} (${reason})${result.stderr.text.trim() === "" ? "" : `\n${result.stderr.text.trimEnd()}`}`, (result.spawnError === undefined ? {} : { cause: result.spawnError }));
        this.name = "ProcessError";
        this.code = result.spawnError !== undefined ? errnoCode(result.spawnError) : (result.exitCode ?? undefined);
        this.killed = result.timedOut || result.aborted;
        this.signal = result.exitSignal;
        this.stdout = result.stdout.text;
        this.stderr = result.stderr.text;
        this.timedOut = result.timedOut;
    }
}

// The output of a command that succeeded, or a thrown ProcessError: what `promisify(execFile)` callers expect, with
// the deadline, the group kill and the output cap underneath.
export const execBounded = async (
    command: string,
    args: readonly string[],
    options: RunOptions = {},
): Promise<{ readonly stdout: string; readonly stderr: string }> => {
    const result = await runBounded(command, args, options);
    if (result.exitCode !== 0) {
        throw new ProcessError(command, args, result);
    }
    return { stdout: result.stdout.text, stderr: result.stderr.text };
};
