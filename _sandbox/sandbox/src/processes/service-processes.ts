import { type ChildProcess, spawn } from "node:child_process";
import { closeSync, mkdirSync, openSync, renameSync, statSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import net from "node:net";
import { join } from "node:path";
import type { Logger } from "pino";
import { publishRuntimeChange } from "../system/runtime-watch.js";

/* SERVICE PROCESSES: the daemon's own children, supervised, for everything that is a background SERVICE
 * rather than a terminal — the messaging connectors' gateway processes and any other process an extension
 * declares (`contributes.processes`).
 *
 * These used to ride the panel machinery: the command TYPED into a shell in a tmux session, tracked by
 * session. That shape is right for the interactive surfaces (a dev server the owner attaches, Ctrl+C's and
 * ↑-reruns) and was wrong for services, in ways every consumer had to compensate for one by one: a command
 * that died left a live shell the manager reported as running for the life of the container (the spawn gate's
 * original reason), a crashed gateway could not be restarted by `start` because its session was still
 * tracked (the web's stop-then-start workaround), nothing restarted a crashed connector until the owner
 * flipped something, and the exit code lived in a pane nobody read.
 *
 * Here the daemon is the parent, which is what a supervisor is: exits are events, not poll results; a crash
 * respawns with capped backoff (the backend host's pattern, backend-supervisor.ts); `running` means the
 * process is alive; and the output goes to one log file per service, which the terminal panel's read-only
 * log view tails (terminal.ts spawns `tail -F` for `svc-*` names — no tmux session exists).
 *
 * What deliberately does NOT move here: dockerd and the local model servers. Both are designed to SURVIVE a
 * daemon restart (main.ts re-adopts their tmux sessions at boot — killing dockerd kills the user's
 * containers, killing llama-server throws away a loaded model), and a direct child cannot outlive its
 * parent. A gateway dying with the daemon costs a few seconds of reconnect and was already the behavior (the
 * boot sweep killed ext-* sessions); a dockerd dying with the daemon costs the user's running containers. */

// The name a service's read-only log view attaches under, in the terminals list and the /system/terminal
// socket. A prefix of its own so terminal.ts can tell "tail this service's log" from "attach this tmux
// session" — there IS no tmux session behind these.
export const SERVICE_SESSION_PREFIX = "svc-";
export const serviceSession = (key: string): string => `${SERVICE_SESSION_PREFIX}${key}`;

// Stamped into every service child's environment, so a daemon that died without unwinding (crash, OOM kill)
// leaves children a later boot can FIND: they are in their own process groups and outlive their parent.
export const SERVICE_ENV = "INTENTIC_SERVICE";

export interface ServiceSpec {
    // Run via `sh -c` in `cwd` with PORT (assigned once per start, stable across respawns) + `env` in the
    // environment, node_modules/.bin of the cwd prepended to PATH (the panel launcher's rule, same reason).
    readonly command: string;
    readonly cwd: string;
    readonly env?: Record<string, string>;
}

export interface ServiceStatus {
    readonly key: string;
    // running = the child is alive right now. backoff = it exited uninvited and the respawn timer is set;
    // there is no terminal "failed" state on purpose: a service that is wanted keeps being retried at the
    // capped interval, and `restarts` + the log file are the evidence something is wrong.
    readonly state: "running" | "backoff";
    readonly port: number;
    // Uninvited respawns since start(). Resets only with a fresh start(), so a flapping service shows a
    // number that grows rather than a row that merely blinks.
    readonly restarts: number;
    // Epoch ms of the last state change, the terminals row's activity clock.
    readonly since: number;
    readonly lastExitCode?: number;
}

export interface ServiceProcesses {
    // Assigns a port, spawns, and supervises until stop(). No-op when the key is already tracked — a tracked
    // service in backoff is already being retried, and a second start must not double-spawn it.
    readonly start: (key: string, spec: ServiceSpec) => Promise<void>;
    // Untrack, then SIGTERM the child's process group (SIGKILL after a grace a wedged provider SDK doesn't
    // get to veto — the connectors cap their own shutdown at 3s for the same reason).
    readonly stop: (key: string) => void;
    readonly running: (key: string) => boolean;
    readonly portOf: (key: string) => number | undefined;
    readonly statusOf: (key: string) => ServiceStatus | undefined;
    readonly list: () => ServiceStatus[];
    // Where this service's output is, for the terminal route's `tail -F` log view. Defined while tracked.
    readonly logPathOf: (key: string) => string | undefined;
    // SIGTERM every child on daemon shutdown. The delayed SIGKILLs may not fire (the daemon is exiting);
    // killOrphanServiceProcesses at the next boot is the backstop for a child that ignored the SIGTERM.
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

// One rotation, size-capped: a chatty gateway must not fill the /history volume, and one previous generation
// is enough to see what happened before the last respawn.
const LOG_ROTATE_BYTES = 4 * 1_048_576;

// An OS-assigned free port (the managed-processes pattern): a tiny TOCTOU window before the child binds it,
// fine for a handful of services that own their port a moment later.
const freePort = (): Promise<number> =>
    new Promise((resolve, reject) => {
        const server = net.createServer();
        server.on("error", reject);
        server.listen(0, "127.0.0.1", () => {
            const address = server.address();
            const port = typeof address === "object" && address !== null ? address.port : 0;
            server.close(() => resolve(port));
        });
    });

// SIGTERM the child's whole process group now, SIGKILL whatever of it is left after the grace. The group is
// the child's own (detached spawn), so a gateway's own children (an ffmpeg, a headless helper) go with it.
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
            // exited within the grace, which is the good ending
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
    backoffMs: number;
    retry: NodeJS.Timeout | undefined;
}

export const createServiceProcesses = (logsDir: string, logger: Logger, timing: ServiceTiming = DEFAULT_TIMING): ServiceProcesses => {
    const current = new Map<string, Entry>();

    const logPath = (key: string): string => join(logsDir, `${key}.log`);

    // Append fd for the child's stdout+stderr, rotated once past the cap. Sync on purpose: it runs at spawn
    // time on a daemon-owned directory, and an fd (not a stream) means the kernel does the writing and a slow
    // disk backpressures the child, never the daemon.
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
            // Its own process group: the whole tree is killable as a unit, and a child that must be found
            // after a daemon crash is found by the env stamp rather than by parentage.
            detached: true,
            stdio: ["ignore", fd, fd],
        });
        closeSync(fd);
        entry.child = child;
        entry.state = "running";
        entry.since = Date.now();
        entry.spawnedAt = entry.since;
        child.on("error", (error) => {
            // Spawn itself failed (no `sh`?): treated exactly like an instant exit, the backoff says so.
            logger.error({ err: error, service: key }, "service process failed to spawn");
        });
        child.on("exit", (code, signal) => {
            const tracked = current.get(key);
            if (tracked !== entry) {
                return; // stop() untracked it, or a fresh start() replaced it — nothing to respawn
            }
            entry.child = undefined;
            entry.lastExitCode = code ?? undefined;
            // A run that lasted was a working service; its next crash starts the ladder over rather than
            // inheriting a cap it grew during some earlier bad hour.
            if (Date.now() - entry.spawnedAt >= timing.stableMs) {
                entry.backoffMs = timing.backoffStartMs;
            }
            entry.state = "backoff";
            entry.since = Date.now();
            entry.restarts += 1;
            logger.warn(
                { service: key, code, signal, restarts: entry.restarts, retryInMs: entry.backoffMs },
                "service process exited, respawning after backoff",
            );
            publishRuntimeChange("panels", "terminals");
            entry.retry = setTimeout(() => {
                entry.retry = undefined;
                if (current.get(key) === entry) {
                    spawnChild(key, entry);
                    publishRuntimeChange("panels", "terminals");
                }
            }, entry.backoffMs);
            entry.backoffMs = Math.min(entry.backoffMs * 2, timing.backoffCapMs);
        });
    };

    return {
        start: async (key, spec) => {
            if (current.has(key)) {
                return;
            }
            const port = await freePort();
            // A concurrent start of the same key won the race while we awaited the port; leave the winner be.
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
                backoffMs: timing.backoffStartMs,
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

/* THE BOOT BACKSTOP for a daemon that died without unwinding. Service children live in their own process
 * groups, so a crashed daemon leaves them running, holding ports and provider connections the new daemon
 * knows nothing about — a second gateway would then answer the same Discord bot twice. Found by the env
 * stamp (procfs environ, the leftovers scanner's trick), killed by group. SIGTERM first out of manners; the
 * delayed SIGKILL is unref'd, boot does not wait on it. */
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
                // raced away, or not ours to read — either way not an orphan we can act on
            }
        }),
    );
};
