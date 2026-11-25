import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { connect, type Socket } from "node:net";
import { join } from "node:path";
import { parseJsonWith } from "@intentic/base/json";
import { readTextIfExists } from "@intentic/base/fs";
import { isProcessAlive } from "@intentic/local-agent";
import { z } from "zod";
import { baseDir } from "../../config.js";
import { lineSplitter } from "../tools/sandboxes.js";

/* HOW THE AGENT FINDS AND ADOPTS A RUNNING intentic-remoted (2026-11-24; remoted's src/control.rs is the other side).
   remoted started with `--control <endpoint>` outlives the agent: an upgrade, a watchdog kill or a crash leaves people's
   terminals and screens running, and the next agent connects to the endpoint and adopts it instead of starting another.
   The endpoint is a Unix socket beside the agent's state (owner-only, 0600) or a named pipe only this user may open;
   remoted greets every connection with `{type: "hello", protocol, accepts, build, pid}`, the agent answers
   `{type: "adopt", protocol}` with the highest protocol both speak, and from then on reads status and log lines.
   remoted holds `remoted.lock` beside its config for its life, so there is one per environment, and leaves by itself
   once unadopted for a while (control.rs says how long). The hello and `{type: "stop"}` keep their shape in every
   protocol, so an agent can always ask a remoted it cannot adopt to leave.

   REMOTED_CONTROL_PROTOCOL moves with remoted's `PROTOCOL`; the protocol it replaces stays in
   PREVIOUS_REMOTED_CONTROL_PROTOCOLS while the agent still speaks it, or an upgrade would end every open terminal
   instead of adopting the remoted the release before started. `_tools/checks/remoted-protocol.mjs` holds the two sides
   equal and refuses a change that drops the protocol main speaks. */

export const REMOTED_CONTROL_PROTOCOL = 1;
const PREVIOUS_REMOTED_CONTROL_PROTOCOLS: readonly number[] = [];
const SPOKEN: readonly number[] = [...PREVIOUS_REMOTED_CONTROL_PROTOCOLS, REMOTED_CONTROL_PROTOCOL];

// What remoted's lock holder writes beside the lock: who it is, for uninstall to name when the endpoint does not answer.
const remotedPidPath = join(baseDir, "remoted.pid");
// remoted's own log (its stderr) while no agent has adopted it; an adopted one also sends each line to the agent.
export const remotedLogPath = join(baseDir, "remoted.log");

// A Unix socket's path must fit sun_path (104 bytes on macOS, 108 on Linux).
const SOCKET_PATH_MAX = 100;

/**
 * This environment's control endpoint: a named pipe on Windows named after the state directory (pipe names are one
 * namespace for every session and user), else `remoted.sock` in it, or in the runtime directory when that path is too
 * long for a socket. Pure.
 */
export const remotedEndpoint = (dir: string = baseDir, platform: NodeJS.Platform = process.platform, env: NodeJS.ProcessEnv = process.env): string => {
    const key = createHash("sha256")
        .update(platform === "win32" ? dir.toLowerCase() : dir)
        .digest("hex")
        .slice(0, 16);
    if (platform === "win32") {
        return `\\\\.\\pipe\\intentic-remoted-control-${key}`;
    }
    const beside = join(dir, "remoted.sock");
    if (Buffer.byteLength(beside) <= SOCKET_PATH_MAX) {
        return beside;
    }
    return join(env["XDG_RUNTIME_DIR"] ?? tmpdir(), `intentic-remoted-${key}.sock`);
};

const HelloSchema = z.looseObject({
    type: z.literal("hello"),
    protocol: z.int(),
    accepts: z.array(z.int()),
    build: z.string(),
    pid: z.int().positive(),
});
export type RemotedHello = z.infer<typeof HelloSchema>;

/** The highest protocol both this agent and a remoted that accepts `accepts` speak; undefined when none. Pure. */
export const commonProtocol = (accepts: readonly number[], spoken: readonly number[] = SPOKEN): number | undefined => {
    const shared = accepts.filter((protocol) => spoken.includes(protocol));
    return shared.length === 0 ? undefined : Math.max(...shared);
};

// What remoted says after its hello: a status, a log line, `replaced`, `refused`, `stopping`, or a type a newer one adds.
const ControlMessageSchema = z.looseObject({ type: z.string() });
export type ControlMessage = z.infer<typeof ControlMessageSchema>;

// What the agent says: the two requests every protocol so far has.
export type ControlRequest = { readonly type: "adopt"; readonly protocol: number } | { readonly type: "stop" };

/** One open control connection, its hello read. */
export interface ControlConnection {
    readonly hello: RemotedHello;
    readonly send: (message: ControlRequest) => void;
    // Each line after the hello, parsed; a line that is not JSON is skipped.
    readonly onMessage: (listener: (message: ControlMessage) => void) => void;
    // Resolves once either end closed it.
    readonly closed: Promise<void>;
    readonly close: () => void;
}

export type ConnectRemoted = (endpoint: string) => Promise<ControlConnection | undefined>;

const HELLO_TIMEOUT_MS = 2_000;

const parseLine = (line: string): ControlMessage | undefined => {
    const trimmed = line.trim();
    return trimmed.startsWith("{") ? parseJsonWith(trimmed, ControlMessageSchema) : undefined;
};

/**
 * Connects to the remoted at `endpoint` and reads its hello: undefined when nothing listens there (no endpoint, a
 * dead remoted's socket) or what answers says no hello within the timeout.
 */
export const connectRemoted = async (endpoint: string, timeoutMs: number = HELLO_TIMEOUT_MS): Promise<ControlConnection | undefined> =>
    await new Promise<ControlConnection | undefined>((resolve) => {
        const socket: Socket = connect(endpoint);
        const listeners = new Set<(message: ControlMessage) => void>();
        const early: ControlMessage[] = [];
        let hello: RemotedHello | undefined;
        const closed = new Promise<void>((done) => socket.once("close", () => done()));
        const timer = setTimeout(() => finish(undefined), timeoutMs);
        const finish = (connection: ControlConnection | undefined): void => {
            clearTimeout(timer);
            if (connection === undefined) {
                socket.destroy();
            }
            resolve(connection);
        };
        const lines = lineSplitter((line) => {
            const message = parseLine(line);
            if (message === undefined) {
                return;
            }
            if (hello === undefined) {
                hello = HelloSchema.safeParse(message).data;
                if (hello === undefined) {
                    finish(undefined);
                    return;
                }
                finish({
                    hello,
                    send: (body) => {
                        if (!socket.destroyed) {
                            socket.write(`${JSON.stringify(body)}\n`);
                        }
                    },
                    onMessage: (listener) => {
                        listeners.add(listener);
                        for (const held of early.splice(0)) {
                            listener(held);
                        }
                    },
                    closed,
                    close: () => void socket.end(),
                });
                return;
            }
            if (listeners.size === 0) {
                early.push(message);
            }
            for (const listener of listeners) {
                listener(message);
            }
        });
        socket.setEncoding("utf8");
        socket.on("data", (chunk: string) => lines.push(chunk));
        // ENOENT and ECONNREFUSED are nothing listening; the close that follows ends the wait.
        socket.on("error", () => finish(undefined));
        socket.on("close", () => {
            lines.end();
            finish(undefined);
        });
    });

const PROBE_TIMEOUT_MS = 5_000;

/**
 * The control protocols the remoted binary at `path` speaks, from `intentic-remoted control-protocol`; undefined for a
 * remoted from before the control endpoint, which has no such word (it exits 2), and for one that does not answer.
 */
export const controlProtocolsOf = (path: string): readonly number[] | undefined => {
    const result = spawnSync(path, ["control-protocol"], { encoding: "utf8", timeout: PROBE_TIMEOUT_MS, windowsHide: true });
    if (result.error !== undefined || result.status !== 0) {
        return undefined;
    }
    return parseJsonWith(result.stdout.trim(), z.looseObject({ accepts: z.array(z.int()) }))?.accepts;
};

const STOP_WAIT_MS = 5_000;

/** How asking this environment's remoted to leave went, for uninstall to say. */
export type RemotedStopped =
    | { readonly kind: "none" }
    | { readonly kind: "stopped"; readonly pid: number }
    | { readonly kind: "still-running"; readonly pid: number };

/**
 * Asks the remoted at `endpoint` to leave and waits for it, killing it once the wait passes; with nothing answering
 * there, the pidfile's remoted is reported when its process still runs (its endpoint gone, a pid alone is not enough
 * to end a process that may have been reused).
 */
export const stopRemotedAt = async (
    endpoint: string = remotedEndpoint(),
    pidPath: string = remotedPidPath,
    { connectTo = connectRemoted, alive = isProcessAlive, waitMs = STOP_WAIT_MS }: { readonly connectTo?: ConnectRemoted; readonly alive?: (pid: number) => boolean; readonly waitMs?: number } = {},
): Promise<RemotedStopped> => {
    const connection = await connectTo(endpoint);
    if (connection === undefined) {
        const recorded = parseJsonWith((await readTextIfExists(pidPath)) ?? "", z.looseObject({ pid: z.int().positive() }))?.pid;
        return recorded !== undefined && alive(recorded) ? { kind: "still-running", pid: recorded } : { kind: "none" };
    }
    const { pid } = connection.hello;
    connection.send({ type: "stop" });
    let timer: NodeJS.Timeout | undefined;
    const left = await Promise.race([connection.closed.then(() => true), new Promise<false>((done) => (timer = setTimeout(() => done(false), waitMs)))]);
    clearTimeout(timer);
    connection.close();
    if (!left && alive(pid)) {
        try {
            process.kill(pid, "SIGKILL");
        } catch {
            // allow(silent-catch): gone between the check and the kill, which is what was asked
        }
    }
    return alive(pid) ? { kind: "still-running", pid } : { kind: "stopped", pid };
};
