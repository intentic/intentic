import { existsSync } from "node:fs";
import { upgradeWebSocket, type WebSocketLike } from "@hono/node-server";
import type { TerminalClientMessage, TerminalServerMessage } from "@intentic/sandbox-contract";
import { AGENT_SESSION_PREFIX, JOB_SESSION_PREFIX } from "@intentic/sandbox-contract/session-names";
import type { WSContext } from "hono/ws";
import { spawn } from "node-pty";
import type { WebSocket } from "ws";
import type { Services } from "../composition.js";
import { PANEL_SESSION_PREFIX } from "../processes/managed-processes.js";
import { SERVICE_SESSION_PREFIX } from "../processes/service-processes.js";
import { resolveWithin } from "../workspace/files/workspace-files-paths.js";
import { isValidSessionName } from "./terminal-session.js";
import { redeemTicket } from "../auth/ws-tickets.js";
import { attachControlTerminal } from "./tmux-control.js";

// Interactive terminal over a WebSocket; the container is root and is the isolation boundary, so this adds no new trust
// surface. The far end is a tmux control-mode client (tmux-control.ts), not a screen: tmux persists the session, so a
// reload or dropped tunnel only ends the control client while the shell survives.

// Above BUFFER_HIGH the pane's bytes are dropped, not queued; below BUFFER_LOW the pane replays whole from tmux's copy
// (a service log tail pauses/resumes instead, no copy to replay).
const BUFFER_HIGH = 1_048_576;
const BUFFER_LOW = 262_144;
const DRAIN_POLL_MS = 100;
// Missed pong means the peer is gone (half-open TCP); terminate() fires onClose, releasing the tmux client.
const LIVENESS_MS = 30_000;
// node-server does not await onOpen; frames arriving meanwhile are queued here and replayed after attach.
const PENDING_MAX = 64;
// Per-owner resource bound, not a quota; 1013 close code triggers the client's normal backoff.
const MAX_TERMINALS = 32;
let active = 0;

// What a socket drives, whatever kind of session backs it.
interface Driver {
    readonly input: (bytes: Buffer) => void;
    readonly resize: (cols: number, rows: number) => void;
    // Browser fell behind the socket buffer, or caught back up (see the backpressure watermarks).
    readonly stall: () => void;
    readonly recover: () => void;
    readonly close: () => void;
}

interface DriverSink {
    readonly output: (bytes: Buffer) => void;
    readonly exit: (code: number, reason: string) => void;
}

// `-A` lets one call both create a tab and reattach an existing one; `-c <dir>` sets the cwd only on creation.
// Panel/agent/job sessions are attach-only: a missing session fails honestly, not a bare shell in its place.
const tmuxArgv = (session: string, dir: string): string[] =>
    session.startsWith(PANEL_SESSION_PREFIX) || session.startsWith(AGENT_SESSION_PREFIX) || session.startsWith(JOB_SESSION_PREFIX)
        ? ["attach-session", "-t", `=${session}`]
        : ["new-session", "-A", "-s", session, "-c", dir];

// A `svc-<key>` session is not tmux: a pty tails the service's log file from the top (`tail -F`), turning its `\n` into
// the `\r\n` a terminal draws. An untracked key gets an honest one-liner and exit.
const serviceLogDriver = (services: Services, session: string, dir: string, cols: number, rows: number, sink: DriverSink): Driver => {
    const logPath = services.serviceProcesses.logPathOf(session.slice(SERVICE_SESSION_PREFIX.length));
    const argv = logPath === undefined ? ["-c", "echo no such service"] : ["-c", `exec tail -n +1 -F "$0"`, logPath];
    const pty = spawn("sh", argv, { name: "xterm-256color", cwd: dir, env: process.env, cols, rows });
    pty.onData((data) => sink.output(Buffer.from(data, "utf8")));
    pty.onExit(({ exitCode }) => sink.exit(exitCode, ""));
    return {
        input: () => undefined,
        resize: (c, r) => pty.resize(c, r),
        stall: () => pty.pause(),
        recover: () => pty.resume(),
        close: () => pty.kill(),
    };
};

// `cwd` is workspace-relative from `?cwd=`; it must resolve inside /work and exist, else falls back to the root.
// Session name is validated by the caller.
const spawnDriver = (services: Services, session: string, cwd: string | undefined, cols: number, rows: number, sink: DriverSink): Driver => {
    const root = services.workspace.root;
    const requested = cwd !== undefined && cwd !== "" ? resolveWithin(root, cwd) : undefined;
    const dir = requested !== undefined && existsSync(requested) ? requested : root;
    if (session.startsWith(SERVICE_SESSION_PREFIX)) {
        return serviceLogDriver(services, session, dir, cols, rows, sink);
    }
    let stalled = false;
    const terminal = attachControlTerminal(tmuxArgv(session, dir), { cols, rows }, {
        output: (bytes) => {
            if (!stalled) {
                sink.output(bytes);
            }
        },
        exit: sink.exit,
    });
    return {
        input: terminal.input,
        resize: terminal.resize,
        stall: () => {
            stalled = true;
        },
        recover: () => {
            stalled = false;
            terminal.resync();
        },
        close: terminal.close,
    };
};

const dimension = (value: string | undefined, fallback: number): number => {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
};

const serverFrame = (message: TerminalServerMessage): string => JSON.stringify(message);

// node-server's upgradeWebSocket runs after Hono auth middleware, which a header-less WebSocket cannot satisfy; app.ts
// exempts this path and the ticket is authorized from the query string here.
export const createTerminalRoute = (services: Services) =>
    upgradeWebSocket((c) => {
        let driver: Driver | undefined;
        // Client frames that raced the auth await (see PENDING_MAX), replayed once the driver exists.
        let pending: TerminalClientMessage[] | undefined = [];
        let drain: NodeJS.Timeout | undefined;
        let liveness: NodeJS.Timeout | undefined;
        let counted = false;
        let unregisterAccess: (() => void) | undefined;

        const handle = (message: TerminalClientMessage, ws: WSContext<WebSocketLike>): void => {
            if (message.type === "input") {
                driver?.input(Buffer.from(message.data, "utf8"));
            } else if (message.type === "resize") {
                driver?.resize(dimension(String(message.cols), 80), dimension(String(message.rows), 24));
            } else if (message.type === "ping") {
                // Answers the client's 30s tunnel-idle keepalive; the pong is the read-side liveness signal.
                ws.send(serverFrame({ type: "pong" }));
            }
        };

        // Idempotent: onClose and onError can both fire, and terminate() re-enters via onClose.
        const cleanup = (): void => {
            clearInterval(drain);
            clearInterval(liveness);
            drain = undefined;
            liveness = undefined;
            if (counted) {
                counted = false;
                active -= 1;
            }
            driver?.close();
            unregisterAccess?.();
            unregisterAccess = undefined;
        };

        return {
            onOpen: async (_event, ws) => {
                const url = new URL(c.req.url);
                try {
                    // A terminal is a shell over the whole sandbox: the ship-and-operate tier, not the driving one.
                    const caller = redeemTicket(services, url, "maintainer");
                    if (caller !== undefined) {
                        unregisterAccess = services.auth?.connections.register(caller, () => ws.close(1008, "authorization revoked"));
                    }
                } catch (err) {
                    // Close frame only says "unauthorized"; whether the ticket was unknown, spent or expired is logged
                    // here only.
                    services.logger.warn({ err }, "terminal ticket rejected");
                    ws.close(1008, "unauthorized");
                    return;
                }
                // Session name reaches a `tmux -s <name>` argv; validated so a name like `-C` can't be read as a flag.
                const session = url.searchParams.get("session") ?? "";
                if (!isValidSessionName(session)) {
                    ws.close(1008, "invalid session");
                    return;
                }
                if (active >= MAX_TERMINALS) {
                    ws.close(1013, "too many terminals");
                    return;
                }
                active += 1;
                counted = true;
                const cols = dimension(url.searchParams.get("cols") ?? undefined, 80);
                const rows = dimension(url.searchParams.get("rows") ?? undefined, 24);
                // WebSocketLike types only a subset; the real socket is needed for bufferedAmount/ping/terminate.
                const raw = ws.raw as unknown as WebSocket;
                const started = spawnDriver(services, session, url.searchParams.get("cwd") ?? undefined, cols, rows, {
                    // Sent as a binary frame straight through the raw socket; node's `ws` takes a Buffer as-is.
                    output: (bytes) => {
                        raw.send(bytes, { binary: true });
                        if (drain === undefined && raw.bufferedAmount > BUFFER_HIGH) {
                            started.stall();
                            drain = setInterval(() => {
                                if (raw.bufferedAmount < BUFFER_LOW) {
                                    clearInterval(drain);
                                    drain = undefined;
                                    started.recover();
                                }
                            }, DRAIN_POLL_MS);
                        }
                    },
                    exit: (code, reason) => {
                        ws.send(serverFrame(reason === "" ? { type: "exit", code } : { type: "exit", code, reason }));
                        ws.close();
                    },
                });
                driver = started;
                let alive = true;
                raw.on("pong", () => {
                    alive = true;
                });
                liveness = setInterval(() => {
                    if (!alive) {
                        raw.terminate();
                        return;
                    }
                    alive = false;
                    raw.ping();
                }, LIVENESS_MS);
                const queued = pending ?? [];
                pending = undefined;
                for (const message of queued) {
                    handle(message, ws);
                }
            },
            onMessage: (event, ws) => {
                let message: TerminalClientMessage;
                try {
                    message = JSON.parse(String(event.data)) as TerminalClientMessage;
                } catch {
                    return;
                }
                if (driver === undefined) {
                    if (pending !== undefined && pending.length < PENDING_MAX) {
                        pending.push(message);
                    }
                    return;
                }
                handle(message, ws);
            },
            onClose: cleanup,
            onError: cleanup,
        };
    });
