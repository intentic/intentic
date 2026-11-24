import { type ChildProcess, spawn } from "node:child_process";
import { copyFile, mkdir, readdir, rename, rm } from "node:fs/promises";
import { Socket } from "node:net";
import { createInterface } from "node:readline";
import { errorMessage } from "@intentic/base/errors";
import { parseJsonWith } from "@intentic/base/json";
import { stopProcessTree } from "@intentic/base/process";
import { homeDir } from "@intentic/local-agent";
import { z } from "zod";
import { icFile } from "../ic-binary.js";

/* ONE RESIDENT `ic` FOR THE READS THIS AGENT REPEATS (2026-11-24). Every minute the agent asks ic what swaps are going
   on and how full the engine's disk is, and every few minutes what runs here; on Windows a process is dear to start (a
   CPU audit measured 182 ms of CPU for one `ic sandbox list --json`). So the resident agent keeps one `ic serve --stdio`
   (_hosts/ic/src/serve.rs) and sends it the argv it would have spawned; each answer is what that verb prints, byte for
   byte, with its exit code. Nothing about what is asked or how it is read changes: the callers (sandboxes.ts fleet,
   ic-swaps.ts, engine-disk.ts) ask here first and spawn as before whenever this has no answer for them.

   - Started lazily, on the first ask, and only in the resident agent (enableIcServe): a one-shot command would be held
     open by it.
   - One request at a time. An ask that arrives while one is out has no answer here, and spawns its own ic as it always
     did, so a slow listing never makes the minute's swaps question wait.
   - Bounded by the caller's own deadline: past it the server is stopped, with whatever it started, the answer is a
     timeout, and the next ask starts a fresh one.
   - Restarted when it dies, on the next ask; one that keeps dying (three in a row with no answer between) is given up
     for that ic file.
   - Restarted when the ic file is replaced (the same path, size and modification time check ensureCurrentIc keeps):
     the old one's stdin is closed, which ends it once its answer is out.
   - COMPAT(ic-serve): an ic from before `serve` refuses it as a usage error and never says hello; that file is then
     asked per call for as long as it is the one installed. Remove the fallback once every supported ic serves.
   - On Windows it runs from a private copy of ic.exe (as ic's own engine relay does, relay.rs `private_copy`): a running
     executable cannot be replaced there, and a resident one would make every update of ic.exe fail. */

// What an ic that serves says first; anything else, or nothing within the window, is an ic that does not.
const HELLO_TIMEOUT_MS = 10_000;
// The protocol this agent speaks (serve.rs PROTOCOL).
const PROTOCOL = 1;
// Deaths in a row, with no answer between, before the server is given up for that ic file.
const MAX_CRASHES = 3;
// How long a stopped server has after SIGTERM before it is killed (sandboxes.ts STOP_GRACE_MS).
const STOP_GRACE_MS = 10_000;

/** One answer: the exit code and what the verb printed, each stream and both as one (runIc's `output`). */
export interface ServedAnswer {
    readonly code: number;
    readonly stdout: string;
    readonly stderr: string;
    readonly output: string;
}

/** Why an ask has no answer: "timeout" is the caller's deadline passing, the same failure a spawned ic's would be. */
export type ServedResult = ServedAnswer | "timeout" | undefined;

/** A running server as the client drives it: lines in and out, its end, and stopping it. */
export interface ServeChild {
    readonly write: (line: string) => void;
    readonly onLine: (listener: (line: string) => void) => void;
    readonly onExit: (listener: () => void) => void;
    // Closes its stdin: it ends once the answer it is writing is out.
    readonly end: () => void;
    readonly stop: () => void;
}

export interface IcServeSeams {
    // The ic file this agent runs and its signature (ic-binary.ts icFile); undefined when only a PATH lookup finds one.
    readonly file: () => Promise<{ readonly path: string; readonly signature: string } | undefined>;
    readonly start: (path: string, signature: string) => Promise<ServeChild>;
    readonly log: (line: string) => void;
}

// The hello serve.rs says first, and its two kinds of answer line; anything else on its stdout is passed over.
const HelloSchema = z.object({ serve: z.literal(PROTOCOL), verbs: z.array(z.array(z.string())) });
const AnswerSchema = z.object({ id: z.number(), code: z.number().int(), stdout: z.string(), stderr: z.string(), output: z.string() });
const RefusalSchema = z.object({ id: z.number(), error: z.string() });

interface Pending {
    readonly id: number;
    readonly resolve: (result: ServedResult) => void;
}

interface Server {
    readonly signature: string;
    readonly child: ServeChild;
    // The verbs its hello names, each as its argv joined by spaces; undefined until it has said hello.
    verbs: ReadonlySet<string> | undefined;
    pending: Pending | undefined;
    alive: boolean;
}

export interface IcServe {
    // ic's answer to `args` from the resident server, within `timeoutMs` of asking; undefined when it has none for them.
    readonly ask: (args: readonly string[], timeoutMs: number) => Promise<ServedResult>;
    readonly stop: () => void;
}

// Everything one client holds between asks.
interface ClientState {
    readonly seams: IcServeSeams;
    server: Server | undefined;
    starting: Promise<Server | undefined> | undefined;
    nextId: number;
    // The ic files that do not serve, by signature: asked per call until the file changes.
    readonly refused: Set<string>;
    // Deaths mid-answer in a row, by signature.
    readonly crashes: Map<string, number>;
}

const forget = (state: ClientState, server: Server): void => {
    server.alive = false;
    if (state.server === server) {
        state.server = undefined;
    }
};

const retire = (state: ClientState, server: Server): void => {
    forget(state, server);
    server.child.end();
};

// One line after the hello: the answer awaited, a refusal of it (no answer: the caller spawns), or nothing of ours.
const takeAnswer = (state: ClientState, server: Server, line: string): void => {
    const waiting = server.pending;
    const answer = parseJsonWith(line, AnswerSchema);
    const refusal = answer === undefined ? parseJsonWith(line, RefusalSchema) : undefined;
    const id = answer?.id ?? refusal?.id;
    if (waiting === undefined || id !== waiting.id) {
        return;
    }
    server.pending = undefined;
    state.crashes.delete(server.signature);
    waiting.resolve(answer === undefined ? undefined : { code: answer.code, stdout: answer.stdout, stderr: answer.stderr, output: answer.output });
};

// The server ended: by being stopped or retired (said nothing), by itself between asks (said), or under a request,
// which then has no answer and counts towards giving the file up.
const ended = (state: ClientState, server: Server): void => {
    const wasAlive = server.alive;
    forget(state, server);
    const waiting = server.pending;
    server.pending = undefined;
    if (waiting === undefined) {
        if (wasAlive && server.verbs !== undefined) {
            state.seams.log("ic serve: ended by itself; the next read starts it again.");
        }
        return;
    }
    const count = (state.crashes.get(server.signature) ?? 0) + 1;
    state.crashes.set(server.signature, count);
    if (count >= MAX_CRASHES) {
        state.refused.add(server.signature);
        state.seams.log(`ic serve: ended ${count} times in a row mid-answer; ic is asked per call until it is replaced.`);
    }
    waiting.resolve(undefined);
};

// A started server once it has said hello, or undefined (and its file refused) when it does not within the window.
const launch = async (state: ClientState, path: string, signature: string): Promise<Server | undefined> => {
    let child: ServeChild;
    try {
        child = await state.seams.start(path, signature);
    } catch (error) {
        state.seams.log(`ic serve: could not start (${errorMessage(error)}); ic is asked per call.`);
        state.refused.add(signature);
        return undefined;
    }
    const server: Server = { signature, child, verbs: undefined, pending: undefined, alive: true };
    const hello = new Promise<boolean>((resolve) => {
        const timer = setTimeout(() => resolve(false), HELLO_TIMEOUT_MS);
        child.onLine((line) => {
            if (server.verbs !== undefined) {
                takeAnswer(state, server, line);
                return;
            }
            const said = parseJsonWith(line, HelloSchema);
            if (said !== undefined) {
                server.verbs = new Set(said.verbs.map((verb) => verb.join(" ")));
                clearTimeout(timer);
                resolve(true);
            }
        });
        child.onExit(() => {
            clearTimeout(timer);
            resolve(false);
            ended(state, server);
        });
    });
    if (await hello) {
        return server;
    }
    forget(state, server);
    child.stop();
    state.refused.add(signature);
    state.seams.log("ic serve: this ic does not serve (it is older than `ic serve`); ic is asked per call until it is updated.");
    return undefined;
};

// The server for the ic file as it is now: the running one, a fresh one for a replaced file, or none.
const current = async (state: ClientState): Promise<Server | undefined> => {
    const file = await state.seams.file();
    const running = state.server;
    if (running !== undefined && running.signature !== file?.signature) {
        if (file !== undefined) {
            state.seams.log("ic serve: the ic file was replaced; starting the new one.");
        }
        retire(state, running);
    }
    if (file === undefined || state.refused.has(file.signature)) {
        return undefined;
    }
    if (state.server?.alive === true) {
        return state.server;
    }
    state.starting ??= launch(state, file.path, file.signature).then((started) => {
        state.server = started;
        return started;
    });
    try {
        return await state.starting;
    } finally {
        state.starting = undefined;
    }
};

const ask = async (state: ClientState, args: readonly string[], timeoutMs: number): Promise<ServedResult> => {
    const server = await current(state);
    if (server === undefined || server.pending !== undefined || server.verbs?.has(args.join(" ")) !== true) {
        return undefined;
    }
    const id = state.nextId++;
    return await new Promise<ServedResult>((resolve) => {
        const timer = setTimeout(() => {
            if (server.pending?.id === id) {
                server.pending = undefined;
                forget(state, server);
                server.child.stop();
                resolve("timeout");
            }
        }, timeoutMs);
        server.pending = {
            id,
            resolve: (result) => {
                clearTimeout(timer);
                resolve(result);
            },
        };
        server.child.write(`${JSON.stringify({ id, args })}\n`);
    });
};

export const createIcServe = (seams: IcServeSeams): IcServe => {
    const state: ClientState = { seams, server: undefined, starting: undefined, nextId: 1, refused: new Set(), crashes: new Map() };
    return {
        ask: async (args, timeoutMs) => await ask(state, args, timeoutMs),
        stop: () => {
            if (state.server !== undefined) {
                retire(state, state.server);
            }
        },
    };
};

/* The real server: `<ic> serve --stdio`, from a private copy on Windows. */

const serveDir = (home: string): string => `${home}\\.intentic\\ic\\serve`;

// ic.exe copied to the serve folder under its signature, unless that copy is there; earlier copies are let go (one
// still running cannot be removed, and is tried again next time).
const privateCopy = async (path: string, signature: string): Promise<string> => {
    const home = homeDir();
    if (home === undefined) {
        return path;
    }
    const dir = serveDir(home);
    const name = `ic-${signature.replaceAll(/[^A-Za-z0-9]+/g, "-").slice(-48)}.exe`;
    const copy = `${dir}\\${name}`;
    await mkdir(dir, { recursive: true });
    const present = await readdir(dir);
    if (!present.includes(name)) {
        await copyFile(path, `${copy}.new`);
        await rename(`${copy}.new`, copy);
    }
    for (const other of present.filter((file) => file !== name)) {
        // allow(silent-catch): a copy still running cannot go, and is let go on a later start
        await rm(`${dir}\\${other}`, { force: true }).catch(() => undefined);
    }
    return copy;
};

export const startIcServe = async (path: string, signature: string): Promise<ServeChild> => {
    const binary = process.platform === "win32" ? await privateCopy(path, signature) : path;
    // A group of its own on POSIX, as every ic run here has (sandboxes.ts runStreamed): a signal meant for the agent's
    // group does not end it mid-answer; stdin closing does, which the agent's own end brings.
    const child: ChildProcess = spawn(binary, ["serve", "--stdio"], {
        windowsHide: true,
        stdio: ["pipe", "pipe", "ignore"],
        detached: process.platform !== "win32",
    });
    // The agent's exit is never held by its server: the server ends on its stdin closing.
    child.unref();
    for (const stream of [child.stdin, child.stdout] as const) {
        if (stream instanceof Socket) {
            stream.unref();
        }
    }
    child.stdin?.on("error", () => undefined);
    const exits: (() => void)[] = [];
    let exited = false;
    const onExit = (): void => {
        if (!exited) {
            exited = true;
            for (const listener of exits) {
                listener();
            }
        }
    };
    child.once("exit", onExit);
    child.once("error", onExit);
    const lines = child.stdout === null ? undefined : createInterface({ input: child.stdout });
    return {
        write: (line) => {
            child.stdin?.write(line);
        },
        onLine: (listener) => {
            lines?.on("line", listener);
        },
        // One that has already ended is told at once: it may end before its client listens (an ic refusing `serve`).
        onExit: (listener) => {
            if (exited) {
                listener();
            } else {
                exits.push(listener);
            }
        },
        end: () => {
            child.stdin?.end();
        },
        stop: () => {
            void stopProcessTree(child, STOP_GRACE_MS);
        },
    };
};

let resident: IcServe | undefined;

/** Turns the resident server on for this process: the resident agent's start (resident.ts) alone calls it. */
export const enableIcServe = (log: (line: string) => void): void => {
    resident ??= createIcServe({ file: icFile, start: startIcServe, log });
};

/** ic's answer to `args` from the resident server, or undefined when there is none and the caller spawns ic itself. */
export const askIcServe = async (args: readonly string[], timeoutMs: number): Promise<ServedResult> =>
    resident === undefined ? undefined : await resident.ask(args, timeoutMs);
