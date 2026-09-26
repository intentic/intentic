import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
// Naming `jest` takes the module's globals off the table, so `test` and `expect` come from it too.
import { expect, jest, test } from "bun:test";
import { advanceTimersByTimeAsync, realSleep, SETTLES, waitFor } from "@intentic/testing/bun";
import type { Logger } from "pino";
import type { ManagedProcesses } from "../../processes/managed-processes.js";
import { createDependencyCoordinator, type DependencyCoordinator } from "./reconcile-deps.js";

const workspace = async (): Promise<string> => mkdtemp(join(tmpdir(), "reconcile-"));
const write = async (root: string, path: string, content = "{}"): Promise<void> => {
    const full = join(root, path);
    await mkdir(join(full, ".."), { recursive: true });
    await writeFile(full, content);
};
const drifted = async (root: string, dir = "app", name = "left-pad"): Promise<void> => {
    await write(root, `${dir}/package.json`, JSON.stringify({ name: dir, dependencies: { [name]: "^1.0.0" } }));
    await write(root, `${dir}/pnpm-lock.yaml`, "");
    await mkdir(join(root, dir, "node_modules"), { recursive: true });
};
const silent = { info: () => undefined, warn: () => undefined } as unknown as Logger;

// Records the panels started, and none of them ever READS as running: a project whose install panel is up reports
// `installing` rather than `stale`, so a fake that held a key for a few milliseconds let a maintenance pass in flight
// rewrite the state under the next assertion about drift. The one test about an install's own lifetime brings its own
// fake (below), which is where that state belongs.
const processes = (started: string[]): ManagedProcesses =>
    ({
        start: async (key: string) => void started.push(key),
        stop: () => undefined,
        running: () => false,
    }) as unknown as ManagedProcesses;

const coordinator = (root: string, started: string[]): DependencyCoordinator =>
    createDependencyCoordinator({
        workspace: { root },
        processes: processes(started),
        logger: silent,
        requestsPath: join(root, "requests.json"),
        settleMs: 20,
        pollMs: 1,
        installMaxMs: 200,
    });

const settle = async (condition: () => boolean): Promise<void> => {
    for (let waited = 0; waited < 2_000 && !condition(); waited += 5) {
        await new Promise((resolve) => setTimeout(resolve, 5));
    }
};

const watch = (): { subscribe: (listener: (paths: string[]) => void) => () => void; emit: (paths: string[]) => void } => {
    const listeners = new Set<(paths: string[]) => void>();
    return {
        subscribe: (listener) => {
            listeners.add(listener);
            return () => listeners.delete(listener);
        },
        emit: (paths) => listeners.forEach((listener) => listener(paths)),
    };
};

test("a requested first-time setup wakes the coordinator without needing a land", async () => {
    const root = await workspace();
    await write(root, "app/package.json", `{"dependencies":{"left-pad":"^1.0.0"}}`);
    await write(root, "app/pnpm-lock.yaml", "");
    const started: string[] = [];
    const deps = coordinator(root, started);

    const result = await deps.requestInstall(["app"], { kind: "request", conversationId: "conversation-1" });
    expect(result.queued).toEqual(["app"]);
    await settle(() => started.length > 0);
    expect(started).toEqual(["app--install"]);
});

test("a queued first-time setup survives until a later coordinator starts it", async () => {
    const root = await workspace();
    await write(root, "app/package.json", `{"dependencies":{"left-pad":"^1.0.0"}}`);
    await write(root, "app/pnpm-lock.yaml", "");
    // The first daemon can't open a panel; the request outlives it on disk, what a mid-setup restart leaves.
    const failing = {
        start: async () => {
            throw new Error("tmux unavailable");
        },
        running: () => false,
    } as unknown as ManagedProcesses;
    const stranded = createDependencyCoordinator({
        workspace: { root },
        processes: failing,
        logger: silent,
        requestsPath: join(root, "requests.json"),
        pollMs: 1,
    });
    const failed: string[] = [];
    stranded.subscribeFailures(({ dir }) => failed.push(dir));
    await stranded.requestInstall(["app"], { kind: "request", conversationId: "conversation-1" });
    await settle(() => failed.length > 0);

    const started: string[] = [];
    const restarted = coordinator(root, started);
    const stop = restarted.watch(watch().subscribe);
    await settle(() => started.length > 0);
    expect(started).toEqual(["app--install"]);
    stop();
});

test("a durable request can be retried by a later status read if its panel did not start", async () => {
    const root = await workspace();
    await write(root, "app/package.json", `{"dependencies":{"left-pad":"^1.0.0"}}`);
    await write(root, "app/pnpm-lock.yaml", "");
    let attempts = 0;
    const managed = {
        start: async () => {
            attempts += 1;
            if (attempts === 1) {
                throw new Error("tmux unavailable");
            }
        },
        running: () => false,
    } as unknown as ManagedProcesses;
    const deps = createDependencyCoordinator({
        workspace: { root },
        processes: managed,
        logger: silent,
        requestsPath: join(root, "requests.json"),
        pollMs: 1,
    });
    const failed: string[] = [];
    deps.subscribeFailures(({ dir }) => failed.push(dir));

    await deps.requestInstall(["app"], { kind: "request", conversationId: "conversation-1" });
    await settle(() => attempts === 1);
    expect(failed).toEqual(["app"]);
    await deps.status();
    await settle(() => attempts === 2);
    expect(attempts).toBe(2);
});

test("a manifest burst installs only once the writes around it have gone quiet", async () => {
    const root = await workspace();
    // The checkout's manifest is already on disk before the coordinator exists. Written after it instead, the drift
    // lands in a race with the coordinator's own startup scan — which order the two reach the filesystem is the
    // threadpool's to decide, and a scan that sees the drift installs on sight, with no window to hold it back.
    await drifted(root);
    const started: string[] = [];
    const changes = watch();
    const deps = coordinator(root, started);
    jest.useFakeTimers();
    try {
        // The watcher's first batch arrives as the coordinator subscribes, which `watch` does before it schedules its
        // startup pass: the window is armed first, so every pass waits for quiet, the startup one included.
        const stop = deps.watch((listener) => {
            const unsubscribe = changes.subscribe(listener);
            listener(["app/package.json"]);
            return unsubscribe;
        });
        await advanceTimersByTimeAsync(15);
        // A checkout writes the manifest early and ordinary source much longer after; once the manifest arms the
        // window, later source traffic must keep extending it.
        changes.emit(["app/src/main.ts"]);
        // 30ms in: past the 20ms the manifest armed on its own, so nothing but the extension holds the install back.
        // The deadline is exact on the fake clock, but a pass that DID wake still needs a millisecond or two of real
        // filesystem work to reach `startInstall`; the wall-clock wait is what gives it that, at a hundred times what
        // the work costs on a temp tree. Too short and this reads green for want of time rather than for the window.
        await advanceTimersByTimeAsync(15);
        await realSleep(200);
        expect(started).toEqual([]);
        // Quiet at last. The pass wakes on the clock; the walk to the install is bounded by the suite's hang
        // detector rather than by a wait of its own.
        await advanceTimersByTimeAsync(10);
        await waitFor(() => expect(started).toEqual(["app--install"]), SETTLES);
        stop();
    } finally {
        jest.useRealTimers();
    }
});

test("an install that outruns its watch window is stopped rather than left going", async () => {
    const root = await workspace();
    await drifted(root);
    let running = false;
    let stopped = false;
    const managed = {
        start: async () => {
            running = true;
        },
        running: () => running,
        stop: async () => {
            await new Promise((resolve) => setTimeout(resolve, 30));
            running = false;
            stopped = true;
        },
    } as unknown as ManagedProcesses;
    const deps = createDependencyCoordinator({
        workspace: { root },
        processes: managed,
        logger: silent,
        requestsPath: join(root, "requests.json"),
        pollMs: 1,
        installMaxMs: 5,
    });

    await deps.status();
    await settle(() => stopped);
    expect(stopped).toBe(true);
    expect(running).toBe(false);
});

// A panel that fails once, then actually writes the dependency so the project reads `ready` afterwards; a fake that
// only reported success would leave every later pass re-discovering the same drift and racing the same assertion.
const startsOnSecondTry = (root: string, dir = "app", name = "left-pad"): ManagedProcesses => {
    let attempts = 0;
    return {
        start: async () => {
            attempts += 1;
            if (attempts === 1) {
                throw new Error("tmux unavailable");
            }
            await mkdir(join(root, dir, "node_modules", name), { recursive: true });
        },
        running: () => false,
    } as unknown as ManagedProcesses;
};

test("the watcher cannot erase the land that caused a deferred install", async () => {
    const root = await workspace();
    await drifted(root);
    const changes = watch();
    const deps = createDependencyCoordinator({
        workspace: { root },
        processes: startsOnSecondTry(root),
        logger: silent,
        requestsPath: join(root, "requests.json"),
        settleMs: 5,
        pollMs: 1,
    });
    const origins: string[] = [];
    const failed: string[] = [];
    deps.subscribe(({ origin }) => origins.push(origin.kind));
    deps.subscribeFailures(({ dir }) => failed.push(dir));

    await deps.reconcileLand({
        kind: "land",
        agentId: "agent-1",
        branch: "agent/agent-1",
        repos: [{ repo: "app", from: "abc", dir: "app" }],
    });
    await settle(() => failed.length > 0);
    // The watcher later sees the same manifest: routine background traffic for a project the land still owns.
    const stop = deps.watch(changes.subscribe);
    changes.emit(["app/package.json"]);
    await settle(() => origins.length > 0);
    expect(origins).toEqual(["land"]);
    stop();
});

test("a newer land in the same project replaces the older cause", async () => {
    const root = await workspace();
    await drifted(root);
    const deps = createDependencyCoordinator({
        workspace: { root },
        processes: startsOnSecondTry(root),
        logger: silent,
        requestsPath: join(root, "requests.json"),
        pollMs: 1,
    });
    const agents: Array<string | undefined> = [];
    const failed: string[] = [];
    deps.subscribe(({ origin }) => agents.push(origin.kind === "land" ? origin.agentId : undefined));
    deps.subscribeFailures(({ dir }) => failed.push(dir));
    const land = (agentId: string) =>
        deps.reconcileLand({
            kind: "land",
            agentId,
            branch: `agent/${agentId}`,
            repos: [{ repo: "app", from: "abc", dir: "app" }],
        });

    await land("agent-1");
    await settle(() => failed.length > 0);
    await land("agent-2");
    await settle(() => agents.length > 0);
    expect(agents).toEqual(["agent-2"]);
});

test("a land is not blamed for stale projects outside the repos it changed", async () => {
    const root = await workspace();
    await drifted(root, "one", "vue");
    await drifted(root, "two", "left-pad");
    const deps = coordinator(root, []);
    const origins: Array<{ dir: string; kind: string }> = [];
    deps.subscribe(({ dir, origin }) => origins.push({ dir, kind: origin.kind }));

    const outcome = await deps.reconcileLand({
        kind: "land",
        agentId: "agent-1",
        branch: "agent/agent-1",
        repos: [{ repo: "one", from: "abc", dir: "one" }],
    });
    await settle(() => origins.length === 2);

    expect(outcome?.missing).toBe(1);
    expect(origins).toEqual([
        { dir: "one", kind: "land" },
        { dir: "two", kind: "external" },
    ]);
});

test("a status read that discovers unannounced drift also schedules its repair", async () => {
    const root = await workspace();
    await drifted(root);
    const started: string[] = [];
    const deps = coordinator(root, started);
    expect((await deps.status()).find((project) => project.dir === "app")?.state).toBe("stale");
    await settle(() => started.length > 0);
    expect(started).toEqual(["app--install"]);
});

test("command failure evidence is scoped to the project the turn started in", async () => {
    const root = await workspace();
    await drifted(root, "one", "vue");
    await drifted(root, "two", "left-pad");
    await write(root, "two/node_modules/left-pad/package.json");
    const deps = coordinator(root, []);
    expect(await deps.issueAt("two")).toBeUndefined();
    expect(await deps.issueAt("one/src")).toMatchObject({ dir: "one", state: "stale", names: ["vue"] });
});
