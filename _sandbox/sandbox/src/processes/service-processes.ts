import { type ChildProcess, spawn } from "node:child_process";
import { closeSync, mkdirSync, openSync, renameSync, statSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { type Backoff, createBackoff } from "@intentic/base/async";
import type { Logger } from "pino";
import { publishRuntimeChange } from "../system/runtime-watch.js";
import { freePort } from "./free-port.js";

// Daemon-supervised background services (messaging gateways, `contributes.processes` extensions), not terminal panels:
// exits are events, and a crash respawns on the shared backoff ladder. dockerd and local model servers stay out, since
// they must survive a daemon restart and a child cannot outlive its parent.

// Own prefix so terminal.ts knows to tail this log, not attach a tmux session; none exists here.
export const SERVICE_SESSION_PREFIX = "svc-";
export const serviceSession = (key: string): string => `${SERVICE_SESSION_PREFIX}${key}`;

// Stamped into every child's env so a later boot can find one orphaned by an unclean daemon death.
export const SERVICE_ENV = "INTENTIC_SERVICE";

export interface ServiceSpec {
    // Runs via `sh -c` in `cwd` with PORT (stable across respawns) and `env`; PATH gets node_modules/.bin.
    readonly command: string;
    readonly cwd: string;
    readonly env?: Record<string, string>;
}

export interface ServiceStatus {
    readonly key: string;
    // No terminal 'failed' state on purpose: a wanted service keeps retrying; restarts and the log show trouble.
    readonly state: "running" | "backoff";
    readonly port: number;
    // Uninvited respawns since start(); resets only on a fresh start(), so flapping accumulates, not blinks.
    readonly restarts: number;
    // Epoch ms of the last state change, the terminals row's activity clock.
    readonly since: number;
    readonly lastExitCode?: number;
}

export interface ServiceProcesses {
    // Assigns a port and supervises until stop(); no-op if already tracked, even mid-backoff.
    readonly start: (key: string, spec: ServiceSpec) => Promise<void>;
    // Untracks, then SIGTERMs the process group, SIGKILL after a grace a wedged SDK can't veto.
    readonly stop: (key: string) => void;
    readonly running: (key: string) => boolean;
    readonly portOf: (key: string) => number | undefined;
    readonly statusOf: (key: string) => ServiceStatus | undefined;
    readonly list: () => ServiceStatus[];
    // Where this service's output is, for the terminal route's `tail -F` view; defined while tracked.
    readonly logPathOf: (key: string) => string | undefined;
    // SIGTERMs every child; killOrphanServiceProcesses at next boot backstops one that ignored it.
    readonly stopAll: () => void;
}

export interface ServiceTiming {
    readonly backoffStartMs: number;
    readonly backoffCapMs: number;
    // A child that stayed up at least this long ran; its next crash starts the backoff ladder over.
    readonly stableMs: number;
    readonly termGraceMs: number;
}

const DEFAULT_TIMING: ServiceTiming = { backoffStartMs: 1_000, backoffCapMs: 60_000, stableMs: 60_000, termGraceMs: 3_000 };

// One rotation, size-capped, so a chatty gateway can't fill /history; one prior generation is enough.
const LOG_ROTATE_BYTES = 4 * 1_048_576;

// SIGTERMs the child's process group, SIGKILLs any survivor after the grace; its own children die with it.
const killGroup = (child: ChildProcess, graceMs: number): void => {
    const pid = child.pid;
    if (pid === undefined) {
        return;
    }
    try {
        process.kill(-pid, "SIGTERM");
    } catch {
        return; // already gone
    }
    const hardKill = setTimeout(() => {
        try {
            process.kill(-pid, "SIGKILL");
        } catch {
            // exited within the grace
        }
    }, graceMs);
    hardKill.unref();
    child.once("exit", () => clearTimeout(hardKill));
};

interface Entry {
    readonly spec: ServiceSpec;
    readonly port: number;
    child: ChildProcess | undefined;
    state: "running" | "backoff";
    restarts: number;
    since: number;
    lastExitCode: number | undefined;
    spawnedAt: number;
    readonly ladder: Backoff;
    retry: NodeJS.Timeout | undefined;
}

export const createServiceProcesses = (logsDir: string, logger: Logger, timing: ServiceTiming = DEFAULT_TIMING): ServiceProcesses => {
    const current = new Map<string, Entry>();

    const logPath = (key: string): string => join(logsDir, `${key}.log`);

    // Append fd for stdout+stderr, rotated past the cap. An fd, not a stream, so the kernel does the writing and a slow
    // disk backpressures the child, not the daemon.
    const openLog = (key: string): number => {
        mkdirSync(logsDir, { recursive: true });
        const path = logPath(key);
        try {
            if (statSync(path).size > LOG_ROTATE_BYTES) {
                renameSync(path, `${path}.1`);
            }
        } catch {
            // no log yet
        }
        return openSync(path, "a");
    };

    const spawnChild = (key: string, entry: Entry): void => {
        const fd = openLog(key);
        const binDir = join(entry.spec.cwd, "node_modules", ".bin");
        const child = spawn("sh", ["-c", entry.spec.command], {
            cwd: entry.spec.cwd,
            env: {
                ...process.env,
                ...entry.spec.env,
                PATH: `${binDir}:${process.env["PATH"] ?? ""}`,
                PORT: String(entry.port),
                [SERVICE_ENV]: key,
            },
            // Own process group, killable as a unit; found after a crash by its env stamp, not by parentage.
            detached: true,
            stdio: ["ignore", fd, fd],
        });
        closeSync(fd);
        entry.child = child;
        entry.state = "running";
        entry.since = Date.now();
        entry.spawnedAt = entry.since;
        child.on("error", (error) => {
            // Spawn itself failing (no `sh`?) is treated like an instant exit; the backoff handles it.
            logger.error({ err: error, service: key }, "service process failed to spawn");
        });
        child.on("exit", (code, signal) => {
            const tracked = current.get(key);
            if (tracked !== entry) {
                return; // stop() untracked it, or a fresh start() replaced it — nothing to respawn
            }
            entry.child = undefined;
            entry.lastExitCode = code ?? undefined;
            entry.state = "backoff";
            entry.since = Date.now();
            entry.restarts += 1;
            // A run that lasted resets the ladder, rather than inheriting a cap grown during an earlier bad stretch.
            const retryInMs = entry.ladder.next(Date.now() - entry.spawnedAt);
            logger.warn({ service: key, code, signal, restarts: entry.restarts, retryInMs }, "service process exited, respawning after backoff");
            publishRuntimeChange("panels", "terminals");
            entry.retry = setTimeout(() => {
                entry.retry = undefined;
                if (current.get(key) === entry) {
                    spawnChild(key, entry);
                    publishRuntimeChange("panels", "terminals");
                }
            }, retryInMs);
        });
    };

    return {
        start: async (key, spec) => {
            if (current.has(key)) {
                return;
            }
            const port = await freePort();
            // A concurrent start of the same key won the race during the port await; leave it be.
            if (current.has(key)) {
                return;
            }
            const entry: Entry = {
                spec,
                port,
                child: undefined,
                state: "running",
                restarts: 0,
                since: Date.now(),
                lastExitCode: undefined,
                spawnedAt: Date.now(),
                ladder: createBackoff({ floorMs: timing.backoffStartMs, capMs: timing.backoffCapMs, stableMs: timing.stableMs }),
                retry: undefined,
            };
            current.set(key, entry);
            spawnChild(key, entry);
            publishRuntimeChange("panels", "terminals");
        },
        stop: (key) => {
            const entry = current.get(key);
            if (entry === undefined) {
                return;
            }
            current.delete(key); // first, so the exit handler sees an untracked entry and stays quiet
            clearTimeout(entry.retry);
            if (entry.child !== undefined) {
                killGroup(entry.child, timing.termGraceMs);
            }
            publishRuntimeChange("panels", "terminals");
        },
        running: (key) => current.get(key)?.state === "running",
        portOf: (key) => current.get(key)?.port,
        statusOf: (key) => {
            const entry = current.get(key);
            return entry === undefined ? undefined : status(key, entry);
        },
        list: () => [...current.entries()].map(([key, entry]) => status(key, entry)),
        logPathOf: (key) => (current.has(key) ? logPath(key) : undefined),
        stopAll: () => {
            for (const [, entry] of current) {
                clearTimeout(entry.retry);
                if (entry.child !== undefined) {
                    killGroup(entry.child, timing.termGraceMs);
                }
            }
            const stopped = current.size > 0;
            current.clear();
            if (stopped) {
                publishRuntimeChange("panels", "terminals");
            }
        },
    };
};

const status = (key: string, entry: Entry): ServiceStatus => ({
    key,
    state: entry.state,
    port: entry.port,
    restarts: entry.restarts,
    since: entry.since,
    ...(entry.lastExitCode === undefined ? {} : { lastExitCode: entry.lastExitCode }),
});

// Boot backstop for an unclean daemon death: orphans keep holding ports and connections the new daemon knows nothing
// about. Found via the env stamp in procfs, killed by group; the SIGKILL is unref'd so boot doesn't wait.
export const killOrphanServiceProcesses = async (logger: Logger): Promise<void> => {
    let pids: string[];
    try {
        pids = (await readdir("/proc")).filter((name) => /^\d+$/.test(name));
    } catch {
        return; // no procfs (mac dev), and no orphans without a prior container daemon either
    }
    await Promise.all(
        pids.map(async (pidName) => {
            const pid = Number(pidName);
            if (pid === process.pid) {
                return;
            }
            try {
                const environ = await readFile(`/proc/${pidName}/environ`, "utf8");
                const stamped = environ.split("\0").find((entry) => entry.startsWith(`${SERVICE_ENV}=`));
                if (stamped === undefined) {
                    return;
                }
                logger.warn({ pid, service: stamped.slice(SERVICE_ENV.length + 1) }, "killing a service process orphaned by a previous daemon");
                const group = -pid; // detached spawn made each service child its own group leader
                process.kill(group, "SIGTERM");
                setTimeout(() => {
                    try {
                        process.kill(group, "SIGKILL");
                    } catch {
                        // gone within the grace
                    }
                }, DEFAULT_TIMING.termGraceMs).unref();
            } catch {
                // raced away, or not ours to read; not an orphan we can act on
            }
        }),
    );
};
