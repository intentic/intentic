import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import type { Logger } from "pino";
import type { ManagedProcesses } from "../processes/managed-processes.js";
import { createWorkspaceMaintenanceGate, type WorkspaceMaintenanceGate } from "./maintenance-gate.js";
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

const processes = (started: string[], runMs = 10): ManagedProcesses => {
    const running = new Set<string>();
    return {
        start: async (key: string) => {
            started.push(key);
            running.add(key);
            setTimeout(() => running.delete(key), runMs);
        },
        stop: (key: string) => running.delete(key),
        running: (key: string) => running.has(key),
    } as unknown as ManagedProcesses;
};

const coordinator = (
    root: string,
    started: string[],
    gate: WorkspaceMaintenanceGate = createWorkspaceMaintenanceGate(),
    runMs = 10,
): DependencyCoordinator =>
    createDependencyCoordinator({
        workspace: { root },
        processes: processes(started, runMs),
        maintenance: gate,
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
    const gate = createWorkspaceMaintenanceGate();
    const turnLease = await gate.enterTurn();
    const deps = coordinator(root, started, gate);

    const result = await deps.requestInstall(["app"], { kind: "request", conversationId: "conversation-1" });
    expect(result.queued).toEqual(["app"]);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(started).toEqual([]);
    turnLease.release();
    await settle(() => started.length > 0);
    expect(started).toEqual(["app--install"]);
});

test("a queued first-time setup survives until a later coordinator starts it", async () => {
    const root = await workspace();
    await write(root, "app/package.json", `{"dependencies":{"left-pad":"^1.0.0"}}`);
    await write(root, "app/pnpm-lock.yaml", "");
    const blockedGate = createWorkspaceMaintenanceGate();
    const turnLease = await blockedGate.enterTurn();
    await coordinator(root, [], blockedGate).requestInstall(["app"], { kind: "request", conversationId: "conversation-1" });

    const started: string[] = [];
    const restarted = coordinator(root, started);
    const stop = restarted.watch(watch().subscribe);
    await settle(() => started.length > 0);
    expect(started).toEqual(["app--install"]);
    stop();
    turnLease.release();
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
        maintenance: createWorkspaceMaintenanceGate(),
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

test("manifest bursts reserve maintenance immediately but install only after the burst is quiet", async () => {
    const root = await workspace();
    const started: string[] = [];
    const changes = watch();
    const deps = coordinator(root, started);
    const stop = deps.watch(changes.subscribe);
    await new Promise((resolve) => setTimeout(resolve, 10));
    await drifted(root);
    changes.emit(["app/package.json"]);
    await new Promise((resolve) => setTimeout(resolve, 15));
    // A checkout commonly writes the manifest early and ordinary source for much longer. Once the manifest
    // reserves maintenance, that later source traffic must keep extending the trailing quiet window.
    changes.emit(["app/src/main.ts"]);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(started).toEqual([]);
    await settle(() => started.length > 0);
    expect(started).toEqual(["app--install"]);
    stop();
});

test("a turn arriving after maintenance is reserved waits until the install has finished", async () => {
    const root = await workspace();
    await drifted(root);
    const started: string[] = [];
    const gate = createWorkspaceMaintenanceGate();
    const deps = coordinator(root, started, gate, 60);
    const stop = deps.watch(watch().subscribe);
    await settle(() => started.length > 0);
    let entered = false;
    const turn = gate.enterTurn().then((lease) => {
        entered = true;
        lease.release();
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(entered).toBe(false);
    await turn;
    expect(entered).toBe(true);
    stop();
});

test("a timed-out install is fully stopped before the maintenance lease admits a turn", async () => {
    const root = await workspace();
    await drifted(root);
    const gate = createWorkspaceMaintenanceGate();
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
        maintenance: gate,
        logger: silent,
        requestsPath: join(root, "requests.json"),
        pollMs: 1,
        installMaxMs: 5,
    });

    await deps.status();
    await settle(() => running);
    let entered = false;
    const turn = gate.enterTurn().then((lease) => {
        entered = true;
        lease.release();
    });
    await new Promise((resolve) => setTimeout(resolve, 15));
    expect(entered).toBe(false);
    await turn;
    expect(stopped).toBe(true);
});

test("the watcher cannot erase the land that caused a deferred install", async () => {
    const root = await workspace();
    await drifted(root);
    const started: string[] = [];
    const gate = createWorkspaceMaintenanceGate();
    const turnLease = await gate.enterTurn();
    const changes = watch();
    const deps = coordinator(root, started, gate);
    const origins: string[] = [];
    deps.subscribe(({ origin }) => origins.push(origin.kind));
    const stop = deps.watch(changes.subscribe);
    await deps.reconcileLand({
        kind: "land",
        agentId: "agent-1",
        branch: "agent/agent-1",
        repos: [{ repo: "app", from: "abc", dir: "app" }],
    });
    changes.emit(["app/package.json"]);
    turnLease.release();
    await settle(() => origins.length > 0);
    expect(origins).toEqual(["land"]);
    stop();
});

test("a newer land in the same project replaces the older cause", async () => {
    const root = await workspace();
    await drifted(root);
    const gate = createWorkspaceMaintenanceGate();
    const turnLease = await gate.enterTurn();
    const deps = coordinator(root, [], gate);
    const agents: Array<string | undefined> = [];
    deps.subscribe(({ origin }) => agents.push(origin.kind === "land" ? origin.agentId : undefined));
    const land = (agentId: string) =>
        deps.reconcileLand({
            kind: "land",
            agentId,
            branch: `agent/${agentId}`,
            repos: [{ repo: "app", from: "abc", dir: "app" }],
        });

    await land("agent-1");
    await land("agent-2");
    turnLease.release();
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
