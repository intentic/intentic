import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { connect, type Socket } from "node:net";
import os from "node:os";
// Aliased: `resolve` is the promise-executor name throughout this file, and path's would shadow confusingly.
import { dirname, join, resolve as resolvePath } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import type { DiagReport, Request, Response } from "./protocol.js";
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

// The nearest ancestor containing `marker`, or undefined at the filesystem root.
const findUp = (fromDir: string, marker: string): string | undefined => {
    for (let dir = resolvePath(fromDir); ;) {
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

/* WHERE THE SERVICE HAS TO STAND, when that is not where the caller stands.
 *
 * A turn's dependencies exist only inside the turn's mount namespace: the worktree's own node_modules are empty
 * mount points on disk, and the installed tree is bound in over them for the turn's lifetime. A checker started
 * outside therefore resolves nothing — not `vue`, not `node:path` — and either refuses or reports a whole file
 * as broken. The answer is not to translate paths harder; it is to put the service where the files mean what
 * the agent means, and ask about the agent's own paths so the report comes back in the agent's own names.
 *
 * The caller supplies both halves because only it knows the boundary: `reachableCwd` is the same directory as
 * `cwd` named from HERE — the workspace root is found from each name the same way, and the pair's dev:ino is one
 * number on both sides, so it yields the very socket a daemon over there will bind — and `enter` wraps the spawn
 * so the daemon starts on the far side. */
export interface ServiceLocation {
    readonly reachableCwd: string;
    readonly enter: (command: string, args: readonly string[]) => { readonly command: string; readonly args: readonly string[] };
}

// Start a detached daemon for this root. Detached and fully un-piped on purpose: it must outlive the hook that
// started it, and an inherited stdio pipe nobody drains would wedge it the first time it logged anything.
const spawnDaemon = (root: string, location: ServiceLocation | undefined): void => {
    const cli = fileURLToPath(new URL("cli.js", import.meta.url));
    const argv = [cli, "daemon", root];
    const { command, args } = location === undefined ? { command: process.execPath, args: argv } : location.enter(process.execPath, argv);
    const child = spawn(command, args, { detached: true, stdio: "ignore" });
    // Demoted: the daemon's project load is a whole-monorepo parse (hundreds of MB, minutes of CPU) that runs
    // once per agent worktree — background tooling that must lose to the sandbox's control plane under
    // contention. Best-effort: an unsupported platform keeps the default priority, never loses the daemon.
    if (child.pid !== undefined) {
        try {
            os.setPriority(child.pid, 10);
        } catch {
            // EPERM/ESRCH — the daemon just runs undemoted.
        }
    }
    child.unref();
};

// `socketRoot` is the root as THIS process can stat it and `root` the name the daemon is started with — the same
// directory, one number, two names, and only the first can be stat'ed from here (protocol.ts).
const connectOrSpawn = async (root: string, socketRoot: string, location: ServiceLocation | undefined): Promise<Socket | undefined> => {
    const path = socketPathFor(socketRoot);
    const existing = await tryConnect(path);
    if (existing !== undefined) {
        return existing;
    }
    spawnDaemon(root, location);
    for (let attempt = 0; attempt < SPAWN_ATTEMPTS; attempt += 1) {
        await sleep(SPAWN_RETRY_MS);
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
    // Present when `cwd` and `files` are named for a view of the tree this process is not standing in — the
    // service is placed there instead of here, and answers in those same names.
    readonly service?: ServiceLocation;
}

// The daemon's report for these files. Returns undefined — never throws — when there is no answer to be had at
// all: no TypeScript project, or no daemon we could reach. A report distinguishes three states per file, and the
// caller must keep them apart: diagnostics (a verdict), absence from both lists ("checked, and clean" — also a
// verdict), and an `unavailable` entry (the daemon itself refusing: it could not load the file's project well
// enough to vouch for anything, so nothing was checked and nothing should be relayed as if it had been).
export const diagnoseVia = async (cwd: string, options: DiagnoseOptions): Promise<DiagReport | undefined> => {
    const [first] = options.files;
    // Asked with the far-side names when there is a service location, and answerable with them: the two views
    // are checkouts of one repository, so "is there a tsconfig above this file" and "where is the workspace
    // root" have the same answer under either naming. What differs between the views is what is INSTALLED, and
    // that is exactly the question being handed to the service rather than answered here.
    if (first === undefined || !hasTsconfig(first)) {
        return undefined;
    }
    const service = options.service;
    const socket = await connectOrSpawn(daemonRootFor(cwd), daemonRootFor(service === undefined ? cwd : service.reachableCwd), service);
    if (socket === undefined) {
        return undefined;
    }
    try {
        const response = await ask(socket, {
            verb: "diag",
            files: options.files,
            ...(options.touched !== undefined ? { touched: options.touched } : {}),
        });
        return response.ok && "diagnostics" in response ? { diagnostics: response.diagnostics, unavailable: response.unavailable } : undefined;
    } catch {
        return undefined;
    } finally {
        socket.end();
    }
};
