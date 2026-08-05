import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, vi } from "vitest";
import type { Logger } from "pino";
import type { ManagedProcesses } from "../processes/managed-processes.js";
import { type ReconcileDeps, reconcileDependencies } from "./reconcile-deps.js";

const workspace = async (): Promise<string> => mkdtemp(join(tmpdir(), "reconcile-"));

const write = async (root: string, path: string, content = "{}"): Promise<void> => {
    const full = join(root, path);
    await mkdir(join(full, ".."), { recursive: true });
    await writeFile(full, content);
};

const silent = { info: () => undefined, warn: () => undefined } as unknown as Logger;

const deps = (root: string, live: string[], started: string[]): ReconcileDeps => ({
    workspace: { root },
    processes: {
        running: () => false,
        start: async (key: string) => {
            started.push(key);
        },
    } as unknown as ManagedProcesses,
    agents: { liveSessionIds: () => live },
    logger: silent,
});

// A project that has been installed once and has since outgrown its tree — the state a land leaves behind when
// the delta it applied added a dependency.
const drifted = async (root: string): Promise<void> => {
    await write(root, "app/package.json", `{"name":"app","dependencies":{"left-pad":"^1.3.0"}}`);
    await write(root, "app/pnpm-lock.yaml", "");
    await mkdir(join(root, "app/node_modules"), { recursive: true });
};

test("a drifted workspace with nothing running installs itself, and cues the verifier with what it started", async () => {
    const root = await workspace();
    await drifted(root);
    const started: string[] = [];
    const cued: string[][] = [];
    const reconcile = { ...deps(root, [], started), onInstalled: (dirs: string[]) => void cued.push(dirs) };
    expect(await reconcileDependencies(reconcile)).toEqual({ missing: 1, started: ["app"], deferred: false });
    expect(started).toEqual(["app--install"]);
    expect(cued).toEqual([["app"]]);
});

test("an already-satisfied workspace decides nothing, and says so by answering undefined", async () => {
    const root = await workspace();
    await drifted(root);
    await write(root, "app/node_modules/left-pad/package.json");
    const started: string[] = [];
    expect(await reconcileDependencies(deps(root, [], started))).toBeUndefined();
    expect(started).toEqual([]);
});

/* The correctness gate, not a courtesy one. Every live isolated turn has the main checkout's node_modules
 * mounted as the lowerdir of its own overlay, and rewriting a lowerdir under a mounted overlay is undefined
 * behaviour — the turn would see a mixture of both trees. */
test("a live turn defers the install rather than rewriting a tree that turn has mounted", async () => {
    const root = await workspace();
    await drifted(root);
    const started: string[] = [];
    expect(await reconcileDependencies(deps(root, ["turn-1"], started))).toEqual({ missing: 1, started: [], deferred: true });
    expect(started).toEqual([]);
});

/* The armed retry is module state — one per daemon, deliberately (see the module header) — so this case takes a
 * FRESH copy of the module rather than inheriting whatever the deferral above left armed. Nothing about that is
 * a test-only concern: it is the same reason a second land into a busy workspace reuses the first's timer. */
test("the deferred reconcile retries once the workspace goes quiet", async () => {
    vi.resetModules();
    const { reconcileDependencies: fresh } = await import("./reconcile-deps.js");
    const root = await workspace();
    await drifted(root);
    const started: string[] = [];
    const live = ["turn-1"];
    // Real timers on a short interval rather than faked ones: the retry does filesystem work, and a clock the
    // I/O it waits on does not share is a clock that never lets it finish.
    const busy: ReconcileDeps = { ...deps(root, [], started), agents: { liveSessionIds: () => live }, retryMs: 5 };
    expect(await fresh(busy)).toEqual({ missing: 1, started: [], deferred: true });
    live.length = 0;
    for (let waited = 0; waited < 2_000 && started.length === 0; waited += 10) {
        await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(started).toEqual(["app--install"]);
});

/* A never-installed project is a decision the user has not made — the import flow offers them the install and
 * they may have declined, or dropped a repo they only mean to read. Restoring what a land broke is this
 * surface's business; making a first-run choice on someone's behalf is not. */
test("a project that was never installed is left alone — that choice is the user's, not the daemon's", async () => {
    const root = await workspace();
    await write(root, "app/package.json", `{"name":"app","dependencies":{"left-pad":"^1.3.0"}}`);
    await write(root, "app/pnpm-lock.yaml", "");
    const started: string[] = [];
    expect(await reconcileDependencies(deps(root, [], started))).toBeUndefined();
    expect(started).toEqual([]);
});
