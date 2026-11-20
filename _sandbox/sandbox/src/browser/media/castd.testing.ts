import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { unstubbed } from "@intentic/testing";
import type { CastAnswer, CastGeometry } from "./castd-control.js";
import type { CastdDeps, LogFields } from "./castd-process.js";

// The one fake of castd's seam (castd-process.ts CastdDeps): a spawner whose children are event emitters with pids, a
// control socket answering from a table the test edits, pid files in memory, and kills recorded instead of sent.

export interface FakeChild {
    readonly pid: number;
    readonly args: readonly string[];
    readonly env: NodeJS.ProcessEnv;
    readonly signals: NodeJS.Signals[];
    // Ends it as the OS would: the exit event, and /proc no longer naming it.
    readonly exit: (code: number | null, signal?: NodeJS.Signals) => void;
}

export interface FakeCastd {
    readonly deps: CastdDeps;
    readonly children: FakeChild[];
    // Pids alive as castds, by the session they serve: what /proc says.
    readonly live: Map<number, string>;
    readonly pidFiles: Map<string, number>;
    // Signals sent with deps.kill, in order.
    readonly kills: { readonly pid: number; readonly signal: NodeJS.Signals }[];
    readonly asked: { readonly method: string; readonly path: string }[];
    readonly logs: string[];
    // What the control socket answers: by "METHOD /path" without the query; absent answers nothing.
    readonly answers: Map<string, CastAnswer>;
}

// castd's own test key (_sandbox/castd/src/token.rs).
export const FAKE_KEY = Buffer.from("castd-test-key", "ascii");

export const GEOMETRY_SCREEN: CastGeometry = {
    width: 1280,
    height: 880,
    scale: 1,
    screen: { width: 1280, height: 880 },
    crop: null,
    resizable: true,
    fitsWindows: true,
    pinned: null,
};

export const fakeCastd = (overrides: Partial<CastdDeps> = {}): FakeCastd => {
    const children: FakeChild[] = [];
    const live = new Map<number, string>();
    const pidFiles = new Map<string, number>();
    const kills: { pid: number; signal: NodeJS.Signals }[] = [];
    const asked: { method: string; path: string }[] = [];
    const logs: string[] = [];
    const answers = new Map<string, CastAnswer>();
    let nextPid = 4_000;
    const deps: CastdDeps = {
        dir: "/fake/cast",
        binary: () => "/fake/castd",
        spawn: (_workload, _command, args, env) => {
            const emitter = new EventEmitter();
            const pid = nextPid++;
            const session = args[args.indexOf("--session") + 1] ?? "";
            live.set(pid, session);
            const signals: NodeJS.Signals[] = [];
            const exit = (code: number | null, signal?: NodeJS.Signals): void => {
                live.delete(pid);
                emitter.emit("exit", code, signal ?? null);
            };
            children.push({ pid, args, env, signals, exit });
            const child: ChildProcess = unstubbed<ChildProcess>("child", {
                pid,
                // SAFETY: the fake emits only "exit", with the (code, signal) a ChildProcess emits it with, so a listener
                // given for any of once's overloads is called as that overload says.
                once: ((event: string, listener: (...values: unknown[]) => void) => {
                    emitter.once(event, listener);
                    return child;
                }) as ChildProcess["once"],
                // castd-process.ts only ever kills its child by a signal's name.
                kill: (signal?: NodeJS.Signals) => {
                    const sent = signal ?? "SIGTERM";
                    signals.push(sent);
                    exit(null, sent);
                    return true;
                },
            });
            return child;
        },
        ask: async (_socket, method, path) => {
            asked.push({ method, path });
            return answers.get(`${method} ${path.split("?")[0]}`);
        },
        displayUp: async () => true,
        isCastd: (pid, session) => live.get(pid) === session,
        kill: (pid, signal) => {
            kills.push({ pid, signal });
            const child = children.find((candidate) => candidate.pid === pid);
            if (child !== undefined) {
                child.exit(null, signal);
            } else {
                live.delete(pid);
            }
        },
        pids: {
            read: (path) => pidFiles.get(path),
            write: (path, pid) => pidFiles.set(path, pid),
            remove: (path) => pidFiles.delete(path),
        },
        mediaKey: () => ({ key: FAKE_KEY, path: "/fake/cast/key" }),
        recordDir: "/fake/recordings",
        droppedAt: () => 0,
        log: (_fields: LogFields, message) => logs.push(message),
        startMs: 300,
        ...overrides,
    };
    return { deps, children, live, pidFiles, kills, asked, logs, answers };
};

// An answer as castd's socket gives it: a status and a body, its headers as given.
export const castAnswer = (status: number, body: string | Buffer, headers: Record<string, string> = {}): CastAnswer => {
    const bytes = Buffer.isBuffer(body) ? body : Buffer.from(body, "utf8");
    return { status, body: bytes.toString("utf8"), bytes, headers };
};

// castd answering: healthy, framed as `geometry` says.
export const answering = (fake: FakeCastd, geometry: CastGeometry = GEOMETRY_SCREEN): void => {
    fake.answers.set("GET /health", castAnswer(200, `{"ok":true}`));
    fake.answers.set("GET /geometry", castAnswer(200, JSON.stringify(geometry)));
    fake.answers.set("POST /pin", castAnswer(200, `{"ok":true}`));
    fake.answers.set("POST /unpin", castAnswer(200, `{"ok":true}`));
};
