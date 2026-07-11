import { existsSync } from "node:fs";
import { upgradeWebSocket } from "@hono/node-server";
import { type IPty, spawn } from "node-pty";
import type { Services } from "../composition.js";
import { PANEL_SESSION_PREFIX } from "../panels/panel-processes.js";
import { resolveWithin } from "../workspace/workspace-files.js";
import { AGENT_SESSION_PREFIX, isValidSessionName, JOB_SESSION_PREFIX } from "./terminal-session.js";

// One interactive PTY the browser drives over a WebSocket — the sandbox's "open a terminal in here" surface, so
// the owner can watch processes, re-run a failed dev command and see WHY it failed, and generally poke around.
// The container runs as root and IS the isolation boundary (the agent already has an autonomous root shell), so
// a shell for the authenticated owner adds no new trust surface. The PTY is a `tmux attach` client, not the shell
// itself: the tmux server outlives this socket, so a reload/drop kills only the client (onClose below) while the
// session + its running processes survive — reconnecting re-attaches with a full screen redraw.

// The wire protocol, JSON both ways (xterm speaks strings). Kept tiny and defined on each side (the web app
// doesn't import this contract package — it re-declares the agent event shapes too). `ping` is the client's
// 30s keepalive against tunnel idle-reaping — deliberately no branch in onMessage, arriving is its whole job.
type ClientMessage =
    | { readonly type: "input"; readonly data: string }
    | { readonly type: "resize"; readonly cols: number; readonly rows: number }
    | { readonly type: "ping" };

// Attach (or create) the tab's tmux session. `-A` makes new-session attach if `session` already exists, so the
// same call serves a brand-new tab and a reconnect/reload of an existing one. `-c <dir>` sets the session's
// working dir on CREATION only (a re-attach keeps the session's own cwd — a reattached tab shouldn't jump). `cwd`
// is a workspace-relative path from the ?cwd= query; it must resolve inside /work (resolveWithin returns undefined
// on escape) and exist, else we fall back to the root. The session name is validated by the caller (onOpen).
// Panel sessions (`panel-<key>`, owned by panels/panel-processes.ts), agent sessions (`agent-<id>`, owned
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

// The /system/terminal route. node-server's upgradeWebSocket runs after the Hono auth middleware, which the
// browser's header-less WebSocket can't satisfy — so app.ts exempts this path and we authorize the token +
// connect token from the query string here instead (short-lived Google JWT over wss/TLS via the tunnel).
export const createTerminalRoute = (services: Services) =>
    upgradeWebSocket((c) => {
        let pty: IPty | undefined;
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
                // The tmux session this tab attaches. Validated because it reaches a `tmux -s <name>` argv (a name
                // like `-C` would be read as a flag even in node-pty's argv array).
                const session = url.searchParams.get("session") ?? "";
                if (!isValidSessionName(session)) {
                    ws.close(1008, "invalid session");
                    return;
                }
                const cols = dimension(url.searchParams.get("cols") ?? undefined, 80);
                const rows = dimension(url.searchParams.get("rows") ?? undefined, 24);
                pty = spawnShell(services.workspace.root, session, url.searchParams.get("cwd") ?? undefined, cols, rows);
                pty.onData((data) => ws.send(JSON.stringify({ type: "data", data })));
                pty.onExit(({ exitCode }) => {
                    ws.send(JSON.stringify({ type: "exit", code: exitCode }));
                    ws.close();
                });
            },
            onMessage: (event) => {
                if (pty === undefined) {
                    return;
                }
                let message: ClientMessage;
                try {
                    message = JSON.parse(String(event.data)) as ClientMessage;
                } catch {
                    return;
                }
                if (message.type === "input") {
                    pty.write(message.data);
                } else if (message.type === "resize") {
                    pty.resize(dimension(String(message.cols), 80), dimension(String(message.rows), 24));
                }
            },
            onClose: () => pty?.kill(),
            onError: () => pty?.kill(),
        };
    });
