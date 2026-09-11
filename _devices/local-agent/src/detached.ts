import { spawn } from "node:child_process";
import { openSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { uptime } from "node:os";
import { basename } from "node:path";
import { setTimeout } from "node:timers/promises";
import { type CliLauncher, stubCommand, windowsLaunchStub } from "./launcher.js";

// Resident background loop, one per machine, found again across processes via a pidfile. A stale pid (crash, power
// loss) must read as not-running, not a lie, so it's probed and paired with a boot token, never trusted alone.

// Signal 0 probes without touching the process: ESRCH means gone, EPERM means it exists (owned by another user), both
// alive. Exported for waits that watch one pid, where re-reading the pidfile would ask a different question.
export const isProcessAlive = (pid: number): boolean => {
    try {
        process.kill(pid, 0);
        return true;
    } catch (error) {
        return (error as NodeJS.ErrnoException).code === "EPERM";
    }
};

// Records which boot wrote the pidfile: probing a pid alone can't tell today's loop from an unrelated process that
// reused its number after reboot. A record from another boot is stale by construction and its pid is never probed.
const bootToken = async (): Promise<string> => {
    // Linux/WSL: a fresh UUID per boot, exact and immune to clock changes (e.g. a resynced WSL clock).
    const bootId = (await readFile("/proc/sys/kernel/random/boot_id", "utf8").catch(() => "")).trim();
    // Elsewhere: boot start time via uptime(), which counts through sleep so a resumed laptop is the same boot.
    return bootId === "" ? `at:${Math.round(Date.now() - uptime() * 1000)}` : `id:${bootId}`;
};

// Tolerance for `at:` stamps only (anchored to Date.now, which can step); a false mismatch risks a duplicate loop.
// `id:` stamps compare exactly.
const SAME_BOOT_MS = 120_000;

const sameBoot = (written: string, current: string): boolean => {
    if (!written.startsWith("at:") || !current.startsWith("at:")) {
        return written === current;
    }
    return Math.abs(Number(written.slice(3)) - Number(current.slice(3))) <= SAME_BOOT_MS;
};

// Writes pid, boot token, and an optional build note as one line; one producer keeps `livePidRecord`'s shape single.
// The note is the only way another process (upgrade, status) can tell a fresh loop from an old one.
export const pidFileBody = async (pid: number = process.pid, note?: string): Promise<string> =>
    `${pid} ${await bootToken()}${note === undefined ? "" : ` ${note}`}`;

// The loop behind a pidfile: its pid and whatever it stamped. Undefined covers every case with nothing to reach (no
// file, half-written, stale boot, exited pid), since callers treat them alike.
export interface PidRecord {
    readonly pid: number;
    /** What the writer stamped beside the pid, if anything; the machine agent stamps the build it runs. */
    readonly note?: string;
}

export const livePidRecord = async (pidPath: string): Promise<PidRecord | undefined> => {
    const [written = "", stamp = "", note] = (await readFile(pidPath, "utf8").catch(() => "")).trim().split(/\s+/);
    const pid = Number(written);
    if (!Number.isInteger(pid) || pid <= 0) {
        return undefined;
    }
    if (!sameBoot(stamp, await bootToken())) {
        return undefined;
    }
    if (!isProcessAlive(pid)) {
        return undefined;
    }
    return { pid, ...(note === undefined || note === "" ? {} : { note }) };
};

// The pid alone, for callers that only ask whether a loop exists (e.g. VPN and exit-node pidfiles, which stamp no
// note).
export const livePid = async (pidPath: string): Promise<number | undefined> => (await livePidRecord(pidPath))?.pid;

// `detached` on every platform: POSIX gives the loop its own session; on Windows, without it the loop dies with its
// parent. DETACHED_PROCESS and CREATE_NO_WINDOW cannot be combined, so every child spawned from inside the loop passes
// windowsHide itself; the launcher stub uses CREATE_NO_WINDOW instead, which its own children inherit.

// How long to wait to confirm the loop is really up: short enough for a setup command, long enough that slow process
// creation isn't mistaken for a crash.
const SETTLE_MS = 2_000;
const SETTLE_POLL_MS = 100;

// How long the stub (which just starts one process and exits) is given to answer with a pid before it's treated as
// wedged.
const STUB_REPLY_MS = 10_000;

// How long a stub that has already exited in failure is given to finish saying why: `exit` can beat the last of its
// stderr, and that text is the whole of the error message.
const STUB_DRAIN_MS = 250;

// Starts the loop directly, the way every platform without a stub does.
const spawnHere = (logPath: string, launcher: CliLauncher, args: readonly string[]): number => {
    const logFd = openSync(logPath, "a");
    const [command, ...leading] = launcher;
    const child = spawn(command, [...leading, ...args], { detached: true, stdio: ["ignore", logFd, logFd] });
    child.unref();
    if (child.pid === undefined) {
        throw new Error(`could not start ${command} in the background. Details: ${logPath}`);
    }
    return child.pid;
};

/* Reads the pid the stub prints on stdout, since the stub's own pid belongs to a process that's already exited by the
 * time anything checks it. Stub failures are reported from its log and stderr.
 *
 * THE LINE IS THE ANSWER, NOT THE END OF THE PIPE, and the difference is the whole of this function. The stub prints a
 * pid and exits within milliseconds, but the pipes it was handed are INHERITABLE and the loop it starts inherits them
 * — CreateProcess copies every inheritable handle to the child, not only the three named in STARTUPINFO — so their
 * write end stays open for as long as the loop runs, which is forever by design. Waiting for stdio EOF (node's `close`
 * event, which is `exit` AND every stream ended) therefore waits for the resident loop to exit, and every `setup` on
 * Windows failed with "intentic-launch.exe did not answer within 10000ms" ten seconds after starting the loop
 * perfectly. Measured on Windows 11: pid on stdout at 21 ms, stub exited at 28 ms, stdout EOF only when the child died.
 *
 * So success is the first complete line, failure is a non-zero exit, and the pipes are dropped either way: a handle the
 * loop still owns would otherwise hold this process's event loop open after the stub has said all it has to say.
 *
 * Exported for its own tests: the stub path only runs on Windows in production, but a child that inherits the pipes is
 * every platform's behaviour, so a stand-in stub reproduces it in CI where no Windows runner is. */
export const spawnThroughStub = async (stub: string, logPath: string, launcher: CliLauncher, args: readonly string[]): Promise<number> => {
    const [command, ...rest] = stubCommand(stub, logPath, [...launcher, ...args]);
    const child = spawn(command, rest, { detached: true, stdio: ["ignore", "pipe", "pipe"] });
    let answered = "";
    let complained = "";
    try {
        return await new Promise<number>((resolve, reject) => {
            const timer = globalThis.setTimeout(() => {
                child.kill();
                reject(new Error(`${basename(stub)} did not answer within ${STUB_REPLY_MS}ms. Details: ${logPath}`));
            }, STUB_REPLY_MS);
            timer.unref();
            const settle = (outcome: () => void): void => {
                clearTimeout(timer);
                outcome();
            };
            const refused = (): Error => {
                const said = complained.trim();
                return new Error(`${basename(stub)} could not start the background loop${said === "" ? "" : `: ${said}`}. Details: ${logPath}`);
            };
            child.stdout?.on("data", (chunk: Buffer) => {
                answered += chunk.toString();
                const end = answered.indexOf("\n");
                if (end < 0) {
                    return;
                }
                const pid = Number(answered.slice(0, end).trim());
                settle(() => (Number.isInteger(pid) && pid > 0 ? resolve(pid) : reject(refused())));
            });
            child.stderr?.on("data", (chunk: Buffer) => (complained += chunk.toString()));
            child.once("error", (error) => settle(() => reject(error)));
            // A stub that exits 0 has started something and printed its pid; the line is already in flight and the
            // timeout above covers one that never arrives. Only a non-zero exit is news, and it comes with no loop
            // holding the pipes open, so its stderr ends on its own.
            child.once("exit", (code) => {
                if (code === 0) {
                    return;
                }
                void setTimeout(STUB_DRAIN_MS).then(() => settle(() => reject(refused())));
            });
        });
    } finally {
        child.stdout?.destroy();
        child.stderr?.destroy();
        child.unref();
    }
};

// Answers the pid only once the loop survives the settle window: a pid alone proves only that a process was created,
// not that it kept running.
export const spawnDetached = async (logPath: string, launcher: CliLauncher, args: readonly string[]): Promise<number> => {
    const stub = windowsLaunchStub(launcher);
    const pid = stub === undefined ? spawnHere(logPath, launcher, args) : await spawnThroughStub(stub, logPath, launcher, args);
    for (let waited = 0; waited < SETTLE_MS; waited += SETTLE_POLL_MS) {
        await setTimeout(SETTLE_POLL_MS);
        if (!isProcessAlive(pid)) {
            throw new Error(`the background loop started and stopped immediately (pid ${pid}). Details: ${logPath}`);
        }
    }
    return pid;
};
