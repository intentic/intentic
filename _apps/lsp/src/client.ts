import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { connect, type Socket } from "node:net";
// Aliased: `resolve` is the promise-executor name throughout this file, and path's would shadow confusingly.
import { dirname, join, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";
import type { Diagnostic } from "./diag.js";
import type { Request, Response } from "./protocol.js";
import { socketPathFor } from "./protocol.js";

/* Talking to the resident daemon, starting one if there isn't one.
 *
 * The daemon is never started speculatively. `diagnoseVia` returns undefined when the files belong to no
 * TypeScript project — a Rust or Python workspace asks once, gets nothing, and no language service is ever
 * built. That is also the honest answer: without a tsconfig there is no program to have an opinion.
 *
 * This module is imported by the sandbox daemon, so it deliberately pulls in nothing but node builtins — the
 * TypeScript compiler belongs in the spawned process that actually holds a program, not in the heap of every
 * process that wants to ask it a question. Hence the hand-rolled tsconfig walk below instead of ts.findConfigFile. */

const CONNECT_TIMEOUT_MS = 2_000;
const REQUEST_TIMEOUT_MS = 30_000;
// A cold daemon has to build the program before it can answer the first request; later ones are ~instant.
const SPAWN_RETRY_MS = 150;
const SPAWN_ATTEMPTS = 40;

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

// The nearest ancestor containing `marker`, or undefined at the filesystem root.
const findUp = (fromDir: string, marker: string): string | undefined => {
    for (let dir = resolvePath(fromDir); ; ) {
        if (existsSync(join(dir, marker))) {
            return dir;
        }
        const parent = dirname(dir);
        if (parent === dir) {
            return undefined;
        }
        dir = parent;
    }
};

// The nearest tsconfig.json above a file — the same question ts.findConfigFile answers, asked without loading
// the compiler. Its absence is what tells us this workspace has no TypeScript to serve.
const hasTsconfig = (fromPath: string): boolean => findUp(dirname(resolvePath(fromPath)), "tsconfig.json") !== undefined;

// One daemon per REPOSITORY, not per caller's working directory. The two callers arrive with different cwds —
// the hook passes the conversation's, the CLI passes wherever the agent happened to have cd'd to — and keying
// the socket on those would build the same program twice and warm neither. The daemon serves any number of
// tsconfig projects beneath this root, so converging on it is free.
const daemonRootFor = (cwd: string): string => findUp(cwd, ".git") ?? resolvePath(cwd);

const tryConnect = (path: string): Promise<Socket | undefined> =>
    new Promise((resolve) => {
        const socket = connect(path);
        const settle = (value: Socket | undefined): void => {
            socket.removeAllListeners("connect");
            socket.removeAllListeners("error");
            clearTimeout(timer);
            if (value === undefined) {
                socket.destroy();
            }
            resolve(value);
        };
        const timer = setTimeout(() => settle(undefined), CONNECT_TIMEOUT_MS);
        socket.once("connect", () => settle(socket));
        socket.once("error", () => settle(undefined));
    });

const ask = (socket: Socket, request: Request): Promise<Response> =>
    new Promise((resolve, reject) => {
        let buffer = "";
        const timer = setTimeout(() => reject(new Error("lsp daemon did not answer in time")), REQUEST_TIMEOUT_MS);
        socket.setEncoding("utf8");
        socket.on("data", (chunk: string) => {
            buffer += chunk;
            const newline = buffer.indexOf("\n");
            if (newline === -1) {
                return;
            }
            clearTimeout(timer);
            resolve(JSON.parse(buffer.slice(0, newline)) as Response);
        });
        socket.once("error", (error) => {
            clearTimeout(timer);
            reject(error);
        });
        socket.write(`${JSON.stringify(request)}\n`);
    });

// Start a detached daemon for this root. Detached and fully un-piped on purpose: it must outlive the hook that
// started it, and an inherited stdio pipe nobody drains would wedge it the first time it logged anything.
const spawnDaemon = (root: string): void => {
    const cli = fileURLToPath(new URL("cli.js", import.meta.url));
    spawn(process.execPath, [cli, "daemon", root], { detached: true, stdio: "ignore" }).unref();
};

const connectOrSpawn = async (root: string): Promise<Socket | undefined> => {
    const path = socketPathFor(root);
    const existing = await tryConnect(path);
    if (existing !== undefined) {
        return existing;
    }
    spawnDaemon(root);
    for (let attempt = 0; attempt < SPAWN_ATTEMPTS; attempt += 1) {
        await delay(SPAWN_RETRY_MS);
        const socket = await tryConnect(path);
        if (socket !== undefined) {
            return socket;
        }
    }
    return undefined;
};

export interface DiagnoseOptions {
    readonly files: readonly string[];
    // Files the caller knows just changed, so the daemon re-reads them before answering.
    readonly touched?: readonly string[];
}

// Diagnostics for these files from the resident daemon. Returns undefined — never throws, never an empty array —
// when there is no answer to be had: no TypeScript project, or no daemon we could reach. The caller must be able
// to tell "checked, and it is clean" from "not checked", because only the first is worth telling the model.
export const diagnoseVia = async (cwd: string, options: DiagnoseOptions): Promise<Diagnostic[] | undefined> => {
    const [first] = options.files;
    if (first === undefined || !hasTsconfig(first)) {
        return undefined;
    }
    const socket = await connectOrSpawn(daemonRootFor(cwd));
    if (socket === undefined) {
        return undefined;
    }
    try {
        const response = await ask(socket, { verb: "diag", files: options.files, ...(options.touched !== undefined ? { touched: options.touched } : {}) });
        return response.ok && "diagnostics" in response ? [...response.diagnostics] : undefined;
    } catch {
        return undefined;
    } finally {
        socket.end();
    }
};
