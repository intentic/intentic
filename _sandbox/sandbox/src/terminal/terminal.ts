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

// One interactive terminal the browser drives over a WebSocket, the sandbox's "open a terminal in here"
// surface, so the owner can watch processes, re-run a failed dev command and see WHY it failed, and generally
// poke around. The container runs as root and IS the isolation boundary (the agent already has an autonomous
// root shell), so a shell for the authenticated owner adds no new trust surface.
//
// The thing on the other end of the socket is a tmux CONTROL-MODE client (tmux-control.ts), not a screen: the
// pane's bytes reach the browser raw, as binary frames, and xterm there is the terminal, with its own
// scrollback, selection and search. tmux is the persistence: the session outlives this socket, so a reload or
// a dropped tunnel ends only the control client (onClose below) while the shell and whatever it is running
// survive, and the reconnect replays the pane's history and screen into the fresh xterm.

// Backpressure watermarks. A browser that stops reading (a phone that went to sleep, a tab throttled in the
// background) lets the socket's send buffer grow; past HIGH the pane's bytes are DROPPED rather than queued,
// and once the buffer drains below LOW the pane is replayed whole from tmux's copy, the same replay an attach
// gets. That is what a slow terminal does too: it coalesces the redraws it could not keep up with. (A service's
// log tail has no copy to replay from, so its pty is paused and resumed instead: nothing is lost there, it
// just arrives late.)
const BUFFER_HIGH = 1_048_576;
const BUFFER_LOW = 262_144;
const DRAIN_POLL_MS = 100;
// Protocol-level liveness: browsers answer ws pings automatically, so a missed pong means the peer is gone
// (half-open TCP), terminate() fires onClose, which releases the tmux client.
const LIVENESS_MS = 30_000;
// Bound on pre-attach buffering: node-server does NOT await the async onOpen, so frames arrive while the
// ticket check is in flight, they're queued and replayed after the attach; a flood beyond the cap is dropped.
const PENDING_MAX = 64;
// Ceiling on concurrent attach clients (each is a tmux client process), a resource bound for one owner's
// browsers, not a quota. 1013 = "try again later"; the client's normal backoff handles it.
const MAX_TERMINALS = 32;
let active = 0;

// What a socket drives, whichever kind of session is behind it.
interface Driver {
    readonly input: (bytes: Buffer) => void;
    readonly resize: (cols: number, rows: number) => void;
    // The browser fell behind / caught up again (the watermarks above).
    readonly stall: () => void;
    readonly recover: () => void;
    readonly close: () => void;
}

interface DriverSink {
    readonly output: (bytes: Buffer) => void;
    readonly exit: (code: number, reason: string) => void;
}

// The session's tmux argv. `-A` makes new-session attach if `session` already exists, so the same call serves
// a brand-new tab and a reconnect/reload of an existing one. `-c <dir>` sets the session's working dir on
// CREATION only (a re-attach keeps the session's own cwd, a reattached tab shouldn't jump). Panel sessions
// (`panel-<key>`, owned by processes/managed-processes.ts), agent sessions (`agent-<id>`, owned by the agent's
// tmux runner) and job sessions (`job-<key>`, owned by system/terminal-run.ts) are ATTACH-ONLY: create-on-attach
// would spawn a bare zsh masquerading as the dev server / agent terminal / job when it isn't running, instead
// tmux answers "can't find session" and the client ends, which the exit frame relays honestly. `=` forces an
// exact target match.
const tmuxArgv = (session: string, dir: string): string[] =>
    session.startsWith(PANEL_SESSION_PREFIX) || session.startsWith(AGENT_SESSION_PREFIX) || session.startsWith(JOB_SESSION_PREFIX)
        ? ["attach-session", "-t", `=${session}`]
        : ["new-session", "-A", "-s", session, "-c", dir];

// A `svc-<key>` name is not a tmux session at all: it is a supervised service's read-only log view (the
// processes popover's "View logs"), and a pty runs `tail -F` on the service's log file, from the top, and
// following, so the tab shows history and live output. The pty is what turns the file's `\n` into the `\r\n`
// a terminal draws. A key the supervisor doesn't track gets an honest one-liner and an exit.
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

// `cwd` is a workspace-relative path from the ?cwd= query; it must resolve inside /work (resolveWithin returns
// undefined on escape) and exist, else we fall back to the root. The session name is validated by the caller.
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

// The /system/terminal route. node-server's upgradeWebSocket runs after the Hono auth middleware, which the
// browser's header-less WebSocket can't satisfy, so app.ts exempts this path and we authorize the ticket from
// the query string here instead.
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
                // The client's 30s keepalive against tunnel idle-reaping; the pong is its read-side liveness
                // signal (an idle-but-healthy connection provably delivers a frame per ping interval).
                ws.send(serverFrame({ type: "pong" }));
            }
        };

        // Idempotent (onClose and onError can both fire, and terminate() re-enters via onClose).
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
                    // A terminal is a shell over the whole sandbox, the ship-and-operate tier, not the driving one.
                    const caller = redeemTicket(services, url, "maintainer");
                    if (caller !== undefined) {
                        unregisterAccess = services.auth?.connections.register(caller, () => ws.close(1008, "authorization revoked"));
                    }
                } catch (err) {
                    // The close frame only says "unauthorized"; whether the ticket was unknown, already spent or
                    // expired is only visible here.
                    services.logger.warn({ err }, "terminal ticket rejected");
                    ws.close(1008, "unauthorized");
                    return;
                }
                // The tmux session this tab attaches. Validated because it reaches a `tmux -s <name>` argv (a name
                // like `-C` would be read as a flag even in a spawn argv array).
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
                // node-server hands the real `ws` socket on .raw; WebSocketLike just types a subset (main.ts
                // makes the mirror assertion for the server). Needed for bufferedAmount/ping/terminate.
                const raw = ws.raw as unknown as WebSocket;
                const started = spawnDriver(services, session, url.searchParams.get("cwd") ?? undefined, cols, rows, {
                    // The pane's bytes go as a BINARY frame, straight through the raw socket: node's `ws`
                    // takes a Buffer as-is, where the adapter's typed send wants a plain ArrayBuffer view.
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
