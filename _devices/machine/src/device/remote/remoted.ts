import { spawn } from "node:child_process";
import type { Log } from "@intentic/local-agent";
import { nextBackoff } from "../egress/follower.js";
import { lineSplitter } from "../tools/sandboxes.js";
import { parseStatusLine, type RemotedStatus } from "./remoted-files.js";

/* intentic-remoted AS THE AGENT'S CHILD (2026-11-20): `intentic-remoted run --config <path> --parent-stdin`, its stdin a
   pipe the agent holds, so it exits when the agent does, however the agent ends. Started while some link holds an
   uplink, stopped once none does: stdin closed, three seconds to leave, then killed. An exit nobody asked for is logged
   with its code and the last thing it said, and it is started again after a second, doubling to a minute, and after a
   second again once a run has held for a minute (the egress follower's ladder). Its stderr lines go to the agent's log;
   its stdout carries its status, a whole snapshot on each change, and nothing else is read from it. */

// How long a remoted asked to leave (stdin closed) gets before it is killed.
const STOP_GRACE_MS = 3_000;

// How one run ended: the exit code or the signal, and an error when it could not start at all.
export interface RemotedExit {
    readonly code: number | null;
    readonly signal: NodeJS.Signals | null;
    readonly error?: string;
}

// One running remoted.
export interface RemotedChild {
    readonly pid: number | undefined;
    readonly exited: Promise<RemotedExit>;
    readonly closeStdin: () => void;
    readonly kill: () => void;
}

export type SpawnRemoted = (binary: string, configPath: string, onStdout: (line: string) => void, onStderr: (line: string) => void) => RemotedChild;

export interface RemotedProcessSeams {
    readonly spawn: SpawnRemoted;
    readonly configPath: string;
    readonly log: Log;
    // Every status remoted printed, and undefined once it is no longer running (nobody is connected through it then).
    readonly onStatus: (status: RemotedStatus | undefined) => void;
    readonly now: () => number;
}

export interface RemotedProcess {
    // Starts it with this binary unless it already runs or waits to be started again.
    readonly ensure: (binary: string) => void;
    // Asks it to leave, then makes it; nothing starts it again until the next `ensure`.
    readonly stop: () => Promise<void>;
    readonly running: () => boolean;
    readonly status: () => RemotedStatus | undefined;
    // The first status `wanted` accepts, the current one included; undefined once `timeoutMs` passes without one.
    readonly waitFor: (wanted: (status: RemotedStatus) => boolean, timeoutMs: number) => Promise<RemotedStatus | undefined>;
}

type State =
    | { readonly kind: "idle" }
    | { readonly kind: "running"; readonly child: RemotedChild; readonly startedAt: number }
    | { readonly kind: "waiting"; readonly timer: NodeJS.Timeout };

const FIRST_BACKOFF_MS = 1_000;

// How a run ended, as the log says it.
export const exitWords = (exit: RemotedExit, lastLine: string | undefined): string => {
    const how = exit.error ?? (exit.signal === null ? `exited with code ${exit.code ?? 1}` : `was ended by ${exit.signal}`);
    return lastLine === undefined ? how : `${how}; its last line: ${lastLine}`;
};

// Asks a running remoted to leave by closing its stdin, and kills it once STOP_GRACE_MS have passed without its exit.
const endChild = async (child: RemotedChild, log: Log): Promise<void> => {
    child.closeStdin();
    let timer: NodeJS.Timeout | undefined;
    const left = await Promise.race([
        child.exited.then(() => true),
        new Promise<false>((resolve) => {
            timer = setTimeout(() => resolve(false), STOP_GRACE_MS);
        }),
    ]);
    clearTimeout(timer);
    if (!left) {
        log(`remoted: still running ${STOP_GRACE_MS / 1_000}s after it was asked to leave; killing it`);
        child.kill();
        await child.exited;
    }
};

// The first status `wanted` accepts, the current one included, told of each new one through `listeners`; undefined once
// `timeoutMs` has passed without one.
const firstStatus = async (
    latest: () => RemotedStatus | undefined,
    listeners: Set<() => void>,
    wanted: (status: RemotedStatus) => boolean,
    timeoutMs: number,
): Promise<RemotedStatus | undefined> => {
    const now = latest();
    if (now !== undefined && wanted(now)) {
        return now;
    }
    return await new Promise<RemotedStatus | undefined>((resolve) => {
        const check = (): void => {
            const status = latest();
            if (status !== undefined && wanted(status)) {
                settle(status);
            }
        };
        const timer = setTimeout(() => settle(undefined), timeoutMs);
        const settle = (answer: RemotedStatus | undefined): void => {
            clearTimeout(timer);
            listeners.delete(check);
            resolve(answer);
        };
        listeners.add(check);
    });
};

export const createRemotedProcess = (seams: RemotedProcessSeams): RemotedProcess => {
    let state: State = { kind: "idle" };
    let binary: string | undefined;
    let backoff = FIRST_BACKOFF_MS;
    let latest: RemotedStatus | undefined;
    const listeners = new Set<() => void>();

    const publish = (status: RemotedStatus | undefined): void => {
        latest = status;
        seams.onStatus(status);
        for (const listener of listeners) {
            listener();
        }
    };

    const launch = (): void => {
        if (binary === undefined) {
            return;
        }
        let lastLine: string | undefined;
        // Only the child this state holds speaks: one asked to leave may still print on its way out.
        const current = (): boolean => state.kind === "running" && state.child === child;
        const child: RemotedChild = seams.spawn(
            binary,
            seams.configPath,
            (line) => {
                const status = parseStatusLine(line);
                if (status !== undefined && current()) {
                    publish(status);
                }
            },
            (line) => {
                if (line.trim() === "") {
                    return;
                }
                lastLine = line;
                seams.log(`remoted: ${line}`);
            },
        );
        const startedAt = seams.now();
        state = { kind: "running", child, startedAt };
        seams.log(`remoted: started${child.pid === undefined ? "" : ` (pid ${child.pid})`}`);
        void child.exited.then((exit) => {
            if (!current()) {
                return;
            }
            publish(undefined);
            const { wait, next } = nextBackoff(backoff, startedAt, seams.now());
            backoff = next;
            seams.log(`remoted: ${exitWords(exit, lastLine)}; starting it again in ${Math.round(wait / 1_000)}s`);
            const timer = setTimeout(() => {
                if (state.kind === "waiting" && state.timer === timer) {
                    launch();
                }
            }, wait);
            timer.unref();
            state = { kind: "waiting", timer };
        });
    };

    return {
        ensure: (path) => {
            binary = path;
            if (state.kind === "idle") {
                backoff = FIRST_BACKOFF_MS;
                launch();
            }
        },
        stop: async () => {
            const was = state;
            state = { kind: "idle" };
            if (was.kind === "waiting") {
                clearTimeout(was.timer);
                return;
            }
            if (was.kind !== "running") {
                return;
            }
            await endChild(was.child, seams.log);
            seams.log("remoted: stopped");
            if (state.kind === "idle") {
                publish(undefined);
            }
        },
        running: () => state.kind !== "idle",
        status: () => latest,
        waitFor: async (wanted, timeoutMs) => await firstStatus(() => latest, listeners, wanted, timeoutMs),
    };
};

// The real child: stdin a pipe this agent holds (`--parent-stdin` is remoted's word to leave when it closes), stdout and
// stderr read a line at a time, and no window on Windows.
export const spawnRemoted: SpawnRemoted = (binary, configPath, onStdout, onStderr) => {
    const proc = spawn(binary, ["run", "--config", configPath, "--parent-stdin"], { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    const out = lineSplitter(onStdout);
    const err = lineSplitter(onStderr);
    // A remoted that left first makes the pipe refuse what is still written to it; its exit says why.
    proc.stdin.on("error", () => undefined);
    proc.stdout.setEncoding("utf8").on("data", out.push);
    proc.stderr.setEncoding("utf8").on("data", err.push);
    let failed: string | undefined;
    const exited = new Promise<RemotedExit>((resolve) => {
        proc.on("error", (error) => {
            failed = `could not run (${error.message})`;
        });
        proc.on("close", (code, signal) => {
            out.end();
            err.end();
            resolve(failed === undefined ? { code, signal } : { code, signal, error: failed });
        });
    });
    return {
        pid: proc.pid,
        exited,
        closeStdin: () => proc.stdin.end(),
        kill: () => void proc.kill(),
    };
};
