import { randomBytes, randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { carriesStamp, SPAWN_STAMP_ENV, spawnAs } from "../../workload/workload-class.js";

// Starting and stopping the daemon's own `opencode serve`. OpenCode 2's client ships no spawner, and its CLI otherwise
// prefers one shared background server per user, which reads none of the caller's environment; so the daemon starts a
// private server itself, on loopback, with the environment it needs, and owns its pid from the first instant.

// How long `opencode serve` gets to print its listening line; a cold spawn on a loaded host can take seconds.
export const BOOT_TIMEOUT_MS = 60_000;

// A server still there after the grace is killed outright: on CI one ran the signal handlers it had installed, which
// took themselves off, and stayed up and idle until a SIGKILL ended it at once (run 37232648385). Only a process that
// still carries this boot's spawn stamp is killed, so a pid the kernel has handed to something else is left alone.
const STOP_GRACE_MS = 3_000;
const STOP_TIMEOUT_MS = 10_000;

// How much of the server's own output is kept, for the sentence a failed boot ends in.
const OUTPUT_TAIL_CHARS = 4_000;

// What the server prints once it accepts connections (2.0.26: `server listening on http://127.0.0.1:41235`). Read to the
// line's end: a pipe can hand the line over in two reads, and the first may stop partway through the port.
const LISTENING = /listening on (http:\/\/\S+)\r?\n/u;

// How long a server that exited before it was ready gets for its pipes to close, which is what says all it printed has
// been read. Bounded, since anything it started that kept a pipe open would hold them open for as long as it runs.
const LAST_WORDS_MS = 500;

// The served process: its pid and the stamp its environment carries, by which a later kill knows it is still the one.
export interface ServedProcess {
    readonly pid: number;
    readonly stamp: string;
}

export interface ServeRequest {
    // The `opencode` binary to run.
    readonly binary: string;
    // 0 lets the kernel pick a free port, which the listening line then names.
    readonly port: number;
    // Added to the daemon's own environment for this child only.
    readonly env: Readonly<Record<string, string>>;
    readonly timeoutMs?: number;
}

export interface ServedServer {
    readonly url: string;
    // The HTTP basic credential every request to this server carries; minted per boot.
    readonly headers: Readonly<Record<string, string>>;
    readonly process: ServedProcess | undefined;
    // Sends SIGTERM; waiting for the exit (and the SIGKILL after it) is waitForExit's.
    readonly close: () => void;
    // Runs once the process exits, however it does; at once if it already has.
    readonly onExit: (listener: (summary: string) => void) => void;
}

export type SpawnServer = (request: ServeRequest) => Promise<ServedServer>;

/**
 * Starts `opencode serve` on loopback and resolves once it prints its address. A server that exits or stays silent
 * first is killed and the boot rejects with the tail of what it printed, the only account of why there is.
 */
export const spawnOpencodeServe: SpawnServer = async ({ binary, port, env, timeoutMs = BOOT_TIMEOUT_MS }) => {
    const stamp = randomUUID();
    // OpenCode answers every request with a 401 unless it carries this; nothing but this daemon is handed it.
    const password = randomBytes(24).toString("base64url");
    const child = spawnAs({ class: "agentRuntime", spawnDepth: 0 }, binary, ["serve", "--hostname", "127.0.0.1", "--port", String(port)], {
        env: { ...process.env, ...env, OPENCODE_SERVER_PASSWORD: password, [SPAWN_STAMP_ENV]: stamp },
        stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    let exited: string | undefined;
    const exitListeners: ((summary: string) => void)[] = [];
    // Drained for the server's whole life: a pipe nobody reads fills, and the server then blocks on its next log line.
    const keep = (chunk: Buffer): void => {
        output = (output + chunk.toString("utf8")).slice(-OUTPUT_TAIL_CHARS);
    };
    child.stdout.on("data", keep);
    child.stderr.on("data", keep);
    const url = await new Promise<string>((resolve, reject) => {
        const timer = setTimeout(() => {
            child.kill("SIGKILL");
            reject(new Error(`OpenCode did not start within ${String(Math.round(timeoutMs / 1000))}s.${tail(output)}`));
        }, timeoutMs);
        timer.unref();
        const listening = (): void => {
            const match = LISTENING.exec(output);
            if (match?.[1] !== undefined) {
                clearTimeout(timer);
                child.stdout.off("data", listening);
                child.stderr.off("data", listening);
                resolve(match[1]);
            }
        };
        child.stdout.on("data", listening);
        child.stderr.on("data", listening);
        child.once("error", (error) => {
            clearTimeout(timer);
            reject(new Error(`OpenCode could not be started: ${error.message}`));
        });
        child.once("exit", (code, signal) => {
            clearTimeout(timer);
            // The exit can arrive before the last of its output does, and that output is the only account of why.
            const fail = (): void => reject(new Error(`OpenCode exited before it was ready (${signal ?? `code ${String(code)}`}).${tail(output)}`));
            const unread = setTimeout(fail, LAST_WORDS_MS);
            unread.unref();
            child.once("close", () => {
                clearTimeout(unread);
                fail();
            });
        });
    });
    child.once("exit", (code, signal) => {
        exited = `OpenCode's server exited (${signal ?? `code ${String(code)}`}).${tail(output)}`;
        for (const listener of exitListeners.splice(0)) {
            listener(exited);
        }
    });
    return {
        url,
        headers: { authorization: `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}` },
        process: child.pid === undefined ? undefined : { pid: child.pid, stamp },
        close: () => {
            if (exited === undefined) {
                child.kill("SIGTERM");
            }
        },
        onExit: (listener) => {
            if (exited === undefined) {
                exitListeners.push(listener);
            } else {
                listener(exited);
            }
        },
    };
};

const tail = (output: string): string => {
    const trimmed = output.trim();
    return trimmed === "" ? "" : ` It said: ${trimmed.slice(-1_000)}`;
};

// Whether a process still exists; signal 0 checks without sending anything, and EPERM still means it is there.
export const processAlive = (pid: number): boolean => {
    try {
        process.kill(pid, 0);
        return true;
    } catch (error) {
        return (error as NodeJS.ErrnoException).code === "EPERM";
    }
};

/** Waits for a stopped server to be gone, killing it once the grace runs out; rejects if even that does not end it. */
export const waitForExit = async ({ pid, stamp }: ServedProcess, alive: (pid: number) => boolean): Promise<void> => {
    const started = Date.now();
    let killed = false;
    while (alive(pid)) {
        const waited = Date.now() - started;
        if (waited >= STOP_TIMEOUT_MS) {
            throw new Error("OpenCode's previous runtime has not finished stopping. Retry once it exits.");
        }
        if (!killed && waited >= STOP_GRACE_MS) {
            killed = true;
            if (carriesStamp(pid, stamp)) {
                try {
                    process.kill(pid, "SIGKILL");
                } catch {
                    // allow(silent-catch): it exited between the look and the kill, which is what the kill was for
                }
            }
        }
        await delay(20);
    }
};
