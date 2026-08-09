import { connect, createServer, type Server, type Socket } from "node:net";
import { rm } from "node:fs/promises";
import type { Request, Response } from "./protocol.js";
import { socketPathFor } from "./protocol.js";
import { Workspace } from "./workspace.js";

/* The resident language service, wrapped in a unix-socket server.
 *
 * Two behaviours here are lifted straight from how VS Code drives tsserver, because they are what make
 * per-edit diagnostics affordable rather than merely possible:
 *
 *   - Debounced recompute. VS Code's bufferSyncSupport does not check on every keystroke; it coalesces into one
 *     `geterr` after a 200-800ms pause scaled to file size. The agent's equivalent of a keystroke is an Edit, and
 *     it edits in bursts (a rename touching six files lands as six PostToolUse hooks in a second). Recomputing
 *     per edit would re-check the same program six times; waiting for the burst to settle checks it once.
 *   - Answer from what is already computed. Because the refresh has usually already run by the time the next
 *     tool call comes round, a `diag` is normally a map lookup rather than a type-check.
 *
 * Lifecycle is the other half. The daemon is spawned lazily by the first caller that has a TypeScript project to
 * ask about, and it exits on its own after a quiet period — a workspace with no TS in it never starts one, and a
 * workspace that has stopped being edited stops paying for one. */

const REFRESH_DEBOUNCE_MS = 300;
const IDLE_EXIT_MS = 15 * 60 * 1000;

// How long to wait for a socket already at the path to prove it is alive. Generous: the answer only gates
// whether THIS process is redundant, and a daemon mid-refresh is slow to accept, not dead.
const PROBE_TIMEOUT_MS = 2_000;

/* Raised by `listen` when another daemon is already serving this root. Not an error anyone has to handle
 * specially — `runDaemon` treats it as "nothing left to do here" — but a distinct type, because a bind failure
 * that is NOT this is a real fault and must not be swallowed with it. */
export class RedundantDaemon extends Error {
    constructor() {
        super("another daemon is already serving this root");
        this.name = "RedundantDaemon";
    }
}

// Whether anything accepts a connection at `path`. A socket file with nobody behind it (the daemon was killed)
// refuses with ECONNREFUSED, which is the case this distinguishes from a live neighbour.
const answers = (path: string): Promise<boolean> =>
    new Promise((resolve) => {
        const socket = connect(path);
        const settle = (alive: boolean): void => {
            clearTimeout(timer);
            socket.removeAllListeners();
            socket.destroy();
            resolve(alive);
        };
        const timer = setTimeout(() => settle(false), PROBE_TIMEOUT_MS);
        socket.once("connect", () => settle(true));
        socket.once("error", () => settle(false));
    });

export interface DaemonOptions {
    readonly root: string;
    readonly refreshDebounceMs?: number;
    readonly idleExitMs?: number;
}

export class Daemon {
    private readonly workspace = new Workspace();
    private readonly socketPath: string;
    private readonly refreshDebounceMs: number;
    private readonly idleExitMs: number;
    private server: Server | undefined;
    private refreshTimer: NodeJS.Timeout | undefined;
    private idleTimer: NodeJS.Timeout | undefined;

    constructor(private readonly options: DaemonOptions) {
        this.socketPath = socketPathFor(options.root);
        this.refreshDebounceMs = options.refreshDebounceMs ?? REFRESH_DEBOUNCE_MS;
        this.idleExitMs = options.idleExitMs ?? IDLE_EXIT_MS;
    }

    /* Binding is a CLAIM, and it has to be checked before it is made. This used to unlink whatever was at the
     * path and bind over it, on the reasoning that only a killed daemon could have left one — but two daemons
     * racing a cold start are the common case, not the rare one, and the second one's unlink cut the first one
     * off from every future request. What it had built (a whole monorepo's program, ~1 GB) then sat unreachable
     * until its idle timer ran out. So: if something is already answering here, this daemon is the redundant one
     * and says so; the caller exits rather than squatting. Only a socket nobody answers on is stale, and only
     * that one is removed. */
    async listen(): Promise<string> {
        if (await answers(this.socketPath)) {
            throw new RedundantDaemon();
        }
        await rm(this.socketPath, { force: true });
        const server = createServer((socket) => this.serve(socket));
        this.server = server;
        await new Promise<void>((resolve, reject) => {
            server.once("error", reject);
            server.listen(this.socketPath, () => {
                server.removeListener("error", reject);
                resolve();
            });
        });
        this.armIdleExit();
        return this.socketPath;
    }

    async close(): Promise<void> {
        clearTimeout(this.refreshTimer);
        clearTimeout(this.idleTimer);
        const server = this.server;
        this.server = undefined;
        if (server !== undefined) {
            await new Promise<void>((resolve) => server.close(() => resolve()));
        }
        await rm(this.socketPath, { force: true });
    }

    // Every request resets the clock; a daemon nobody has asked anything in idleExitMs is holding a whole
    // TypeScript program open for no one.
    private armIdleExit(): void {
        clearTimeout(this.idleTimer);
        this.idleTimer = setTimeout(() => void this.close(), this.idleExitMs);
        this.idleTimer.unref();
    }

    private scheduleRefresh(): void {
        clearTimeout(this.refreshTimer);
        this.refreshTimer = setTimeout(() => this.workspace.refresh(), this.refreshDebounceMs);
        this.refreshTimer.unref();
    }

    handle(request: Request): Response {
        this.armIdleExit();
        if (request.verb === "ping") {
            return { ok: true };
        }
        if (request.verb === "shutdown") {
            void this.close();
            return { ok: true };
        }
        this.workspace.touched(request.touched ?? []);
        const report = this.workspace.diagnose(request.files);
        // The caller has what it asked for; keep the rest of the open set current for whoever asks next.
        this.scheduleRefresh();
        return { ok: true, ...report };
    }

    private serve(socket: Socket): void {
        let buffer = "";
        socket.setEncoding("utf8");
        socket.on("data", (chunk: string) => {
            buffer += chunk;
            for (let newline = buffer.indexOf("\n"); newline !== -1; newline = buffer.indexOf("\n")) {
                const line = buffer.slice(0, newline);
                buffer = buffer.slice(newline + 1);
                socket.write(`${JSON.stringify(this.answer(line))}\n`);
            }
        });
        // A client that hangs up mid-request is routine (a killed hook); it must not fault the daemon.
        socket.on("error", () => socket.destroy());
    }

    private answer(line: string): Response {
        try {
            return this.handle(JSON.parse(line) as Request);
        } catch (error) {
            return { ok: false, error: error instanceof Error ? error.message : String(error) };
        }
    }
}

// Entry point for `lsp daemon <root>`: serve until idle, then exit. Kept out of the class so tests can drive a
// Daemon without a process lifecycle attached to it. Losing the race to bind is a normal outcome, not a failure:
// a neighbour is already serving this root, so this process has nothing to hold open and returning ends it.
export const runDaemon = async (root: string): Promise<void> => {
    const daemon = new Daemon({ root });
    try {
        await daemon.listen();
    } catch (error) {
        if (error instanceof RedundantDaemon) {
            return;
        }
        throw error;
    }
    for (const signal of ["SIGINT", "SIGTERM"] as const) {
        process.once(signal, () => void daemon.close().then(() => process.exit(0)));
    }
};
