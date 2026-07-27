import { createServer, type Server, type Socket } from "node:net";
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

    async listen(): Promise<string> {
        // A socket file left behind by a killed daemon would make bind fail; nothing else owns this path.
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
        const diagnostics = this.workspace.diagnose(request.files);
        // The caller has what it asked for; keep the rest of the open set current for whoever asks next.
        this.scheduleRefresh();
        return { ok: true, diagnostics };
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
// Daemon without a process lifecycle attached to it.
export const runDaemon = async (root: string): Promise<void> => {
    const daemon = new Daemon({ root });
    await daemon.listen();
    for (const signal of ["SIGINT", "SIGTERM"] as const) {
        process.once(signal, () => void daemon.close().then(() => process.exit(0)));
    }
};
