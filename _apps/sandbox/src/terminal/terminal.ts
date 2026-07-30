import { existsSync } from "node:fs";
import { upgradeWebSocket, type WebSocketLike } from "@hono/node-server";
import type { TerminalClientMessage, TerminalServerMessage } from "@intentic/sandbox-contract";
import { AGENT_SESSION_PREFIX, JOB_SESSION_PREFIX } from "@intentic/sandbox-contract/session-names";
import type { WSContext } from "hono/ws";
import { type IPty, spawn } from "node-pty";
import type { WebSocket } from "ws";
import type { Services } from "../composition.js";
import { PANEL_SESSION_PREFIX } from "../processes/managed-processes.js";
import { resolveWithin } from "../workspace/workspace-files.js";
import { isValidSessionName } from "./terminal-session.js";

// One interactive PTY the browser drives over a WebSocket — the sandbox's "open a terminal in here" surface, so
// the owner can watch processes, re-run a failed dev command and see WHY it failed, and generally poke around.
// The container runs as root and IS the isolation boundary (the agent already has an autonomous root shell), so
// a shell for the authenticated owner adds no new trust surface. The PTY is a `tmux attach` client, not the shell
// itself: the tmux server outlives this socket, so a reload/drop kills only the client (onClose below) while the
// session + its running processes survive — reconnecting re-attaches with a full screen redraw.

// Backpressure watermarks: a slow/stalled browser lets the socket's send buffer grow — past HIGH stop draining
// the pty (the kernel buffer fills and the tmux client blocks on write; tmux coalesces redraws for slow clients,
// so the flooding child never deadlocks), resume once it drains below LOW.
const BUFFER_HIGH = 1_048_576;
const BUFFER_LOW = 262_144;
const DRAIN_POLL_MS = 100;
// Protocol-level liveness: browsers answer ws pings automatically, so a missed pong means the peer is gone
// (half-open TCP) — terminate() fires onClose, which releases the tmux attach client.
const LIVENESS_MS = 30_000;
// Bound on pre-pty buffering: node-server does NOT await the async onOpen, so frames arrive while the JWT
// check is in flight — they're queued and replayed after spawn; a flood beyond the cap is dropped.
const PENDING_MAX = 64;
// Ceiling on concurrent attach clients (each is a node-pty process + tmux client) — a resource bound for one
// owner's browsers, not a quota. 1013 = "try again later"; the client's normal backoff handles it.
const MAX_TERMINALS = 32;
let active = 0;

// Attach (or create) the tab's tmux session. `-A` makes new-session attach if `session` already exists, so the
// same call serves a brand-new tab and a reconnect/reload of an existing one. `-c <dir>` sets the session's
// working dir on CREATION only (a re-attach keeps the session's own cwd — a reattached tab shouldn't jump). `cwd`
// is a workspace-relative path from the ?cwd= query; it must resolve inside /work (resolveWithin returns undefined
// on escape) and exist, else we fall back to the root. The session name is validated by the caller (onOpen).
// Panel sessions (`panel-<key>`, owned by processes/managed-processes.ts), agent sessions (`agent-<id>`, owned
// by the agent's tmux runner) and job sessions (`job-<key>`, owned by system/terminal-run.ts) are ATTACH-ONLY:
// create-on-attach would spawn a bare zsh masquerading as the dev server / agent terminal / job when it isn't
// running — instead tmux prints "no such session" and exits, which the pty's exit frame relays honestly. `=`
// forces an exact target match.
const spawnShell = (root: string, session: string, cwd: string | undefined, cols: number, rows: number): IPty => {
    const requested = cwd !== undefined && cwd !== "" ? resolveWithin(root, cwd) : undefined;
    const dir = requested !== undefined && existsSync(requested) ? requested : root;
    const argv =
        session.startsWith(PANEL_SESSION_PREFIX) || session.startsWith(AGENT_SESSION_PREFIX) || session.startsWith(JOB_SESSION_PREFIX)
            ? ["attach-session", "-t", `=${session}`]
            : ["new-session", "-A", "-s", session, "-c", dir];
    return spawn("tmux", argv, { name: "xterm-256color", cwd: dir, env: process.env, cols, rows });
};

const dimension = (value: string | undefined, fallback: number): number => {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
};

const serverFrame = (message: TerminalServerMessage): string => JSON.stringify(message);

// The /system/terminal route. node-server's upgradeWebSocket runs after the Hono auth middleware, which the
// browser's header-less WebSocket can't satisfy — so app.ts exempts this path and we authorize the token +
// connect token from the query string here instead (short-lived Google JWT over wss/TLS via the tunnel).
export const createTerminalRoute = (services: Services) =>
    upgradeWebSocket((c) => {
        let pty: IPty | undefined;
        // Client frames that raced the auth await (see PENDING_MAX) — replayed once the pty exists.
        let pending: TerminalClientMessage[] | undefined = [];
        let closed = false;
        let drain: NodeJS.Timeout | undefined;
        let liveness: NodeJS.Timeout | undefined;
        let counted = false;

        const handle = (message: TerminalClientMessage, ws: WSContext<WebSocketLike>): void => {
            if (message.type === "input") {
                pty?.write(message.data);
            } else if (message.type === "resize") {
                pty?.resize(dimension(String(message.cols), 80), dimension(String(message.rows), 24));
            } else if (message.type === "ping") {
                // The client's 30s keepalive against tunnel idle-reaping; the pong is its read-side liveness
                // signal (an idle-but-healthy connection provably delivers a frame per ping interval).
                ws.send(serverFrame({ type: "pong" }));
            }
        };

        // Idempotent (onClose and onError can both fire, and terminate() re-enters via onClose).
        const cleanup = (): void => {
            closed = true;
            clearInterval(drain);
            clearInterval(liveness);
            drain = undefined;
            liveness = undefined;
            if (counted) {
                counted = false;
                active -= 1;
            }
            pty?.kill();
        };

        return {
            onOpen: async (_event, ws) => {
                const url = new URL(c.req.url);
                if (services.auth !== undefined) {
                    try {
                        await services.auth.authorize(url.searchParams.get("token") ?? "", url.searchParams.get("connect") ?? undefined);
                    } catch (err) {
                        // The close frame only says "unauthorized"; the actual cause (JWKS fetch, clock skew,
                        // first-bind token mismatch) is only visible here.
                        services.logger.warn({ err }, "terminal authorize failed");
                        ws.close(1008, "unauthorized");
                        return;
                    }
                }
                // The browser vanished during the (possibly slow JWKS) auth await — don't spawn an orphan.
                if (closed) {
                    return;
                }
                // The tmux session this tab attaches. Validated because it reaches a `tmux -s <name>` argv (a name
                // like `-C` would be read as a flag even in node-pty's argv array).
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
                const shell = spawnShell(services.workspace.root, session, url.searchParams.get("cwd") ?? undefined, cols, rows);
                pty = shell;
                // node-server hands the real `ws` socket on .raw; WebSocketLike just types a subset (main.ts
                // makes the mirror assertion for the server). Needed for bufferedAmount/ping/terminate.
                const raw = ws.raw as unknown as WebSocket;
                shell.onData((data) => {
                    ws.send(serverFrame({ type: "data", data }));
                    if (drain === undefined && raw.bufferedAmount > BUFFER_HIGH) {
                        shell.pause();
                        drain = setInterval(() => {
                            if (raw.bufferedAmount < BUFFER_LOW) {
                                clearInterval(drain);
                                drain = undefined;
                                shell.resume();
                            }
                        }, DRAIN_POLL_MS);
                    }
                });
                shell.onExit(({ exitCode }) => {
                    ws.send(serverFrame({ type: "exit", code: exitCode }));
                    ws.close();
                });
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
                if (pty === undefined) {
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
