import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { STATE_DIR } from "@intentic/constants";
import type { WorkspaceEvent } from "@intentic/sandbox-contract";
import type { Logger } from "pino";
import { expect, test, vi } from "vitest";
import type { ManagedProcesses, ProcessSpec } from "../../processes/managed-processes.js";
import type { DependencyLandOrigin } from "./dependency-origin.js";
import { checkCommandFor, type VerifyDeps } from "./verify-deps.js";
import { fileVerifyStore } from "./verify-store.js";

const workspace = async (): Promise<string> => mkdtemp(join(tmpdir(), "verify-"));

const write = async (root: string, path: string, content = "{}"): Promise<void> => {
    const full = join(root, path);
    await mkdir(join(full, ".."), { recursive: true });
    await writeFile(full, content);
};

const silent = { info: () => undefined, warn: () => undefined } as unknown as Logger;

const context: DependencyLandOrigin = {
    kind: "land",
    agentId: "agent-1",
    branch: "agent/agent-1",
    repos: [{ repo: "app", from: "abc", dir: "app" }],
};

// An installed project with the given scripts: the state a successful reconciler install leaves behind.
const ready = async (root: string, scripts: Record<string, string>): Promise<void> => {
    await write(root, "app/package.json", JSON.stringify({ name: "app", dependencies: { "left-pad": "^1.3.0" }, scripts }));
    await write(root, "app/pnpm-lock.yaml", "");
    await write(root, "app/node_modules/left-pad/package.json");
};

// Simulates a panel by writing the status/log files the daemon reads back, with the exit code the test picks.
const fakeProcesses = (root: string, exitCode: number | undefined, started: string[]): ManagedProcesses => {
    const live = new Set<string>();
    return {
        start: async (key: string, _spec: ProcessSpec) => {
            started.push(key);
            live.add(key);
            const artifacts = join(root, `${STATE_DIR}/local/verify`);
            await mkdir(artifacts, { recursive: true });
            await writeFile(join(artifacts, `${key}.log`), "1 test failed\n");
            if (exitCode !== undefined) {
                await writeFile(join(artifacts, `${key}.status`), `${exitCode}\n`);
            }
            live.delete(key);
        },
        running: (key: string) => live.has(key),
    } as unknown as ManagedProcesses;
};

// Fresh module per case, since the module's queue is process-wide and mustn't leak between tests.
const freshQueue = async (): Promise<typeof import("./verify-deps.js")> => {
    vi.resetModules();
    return import("./verify-deps.js");
};

const deps = (root: string, processes: ManagedProcesses, events: WorkspaceEvent[], feed: string[]): VerifyDeps => ({
    workspace: { root },
    processes,
    logger: silent,
    verifyStore: fileVerifyStore(join(root, `${STATE_DIR}/records/verify.json`)),
    activity: {
        append: async (event) => {
            feed.push(event.type);
        },
    },
    emit: (event) => void events.push(event),
    pollMs: 5,
    watchMaxMs: 200,
});

const settle = async (done: () => boolean): Promise<void> => {
    for (let waited = 0; waited < 2_000 && !done(); waited += 10) {
        await new Promise((resolve) => setTimeout(resolve, 10));
    }
};

test("a red check announces deps.broken with the project, command, exit code and log tail", async () => {
    const { queueVerify } = await freshQueue();
    const root = await workspace();
    await ready(root, { test: "vitest run" });
    const events: WorkspaceEvent[] = [];
    const feed: string[] = [];
    const started: string[] = [];
    queueVerify(deps(root, fakeProcesses(root, 1, started), events, feed), context, ["app"]);
    await settle(() => events.length > 0);
    expect(started).toEqual(["app--verify"]);
    expect(events).toEqual([
        {
            event: "deps.broken",
            agentId: "agent-1",
            branch: "agent/agent-1",
            outcome: "landed",
            repos: context.repos,
            deps: { project: "app", command: "pnpm run test", exitCode: 1, attempt: 1, logTail: "1 test failed\n" },
        },
    ]);
    expect(feed).toEqual(["deps.verify_red"]);
});

test("a green check after a red one announces deps.fixed; green after green announces nothing", async () => {
    const { queueVerify } = await freshQueue();
    const root = await workspace();
    await ready(root, { verify: "pnpm typecheck && pnpm test" });
    const events: WorkspaceEvent[] = [];
    const feed: string[] = [];
    const store = fileVerifyStore(join(root, `${STATE_DIR}/records/verify.json`));
    await store.record("app", "red", 1);
    queueVerify(deps(root, fakeProcesses(root, 0, []), events, feed), context, ["app"]);
    await settle(() => events.length > 0);
    expect(events.map((event) => event.event)).toEqual(["deps.fixed"]);
    expect(events[0]?.deps?.attempt).toBe(0);
    const { queueVerify: again } = await freshQueue();
    const laterEvents: WorkspaceEvent[] = [];
    const laterFeed: string[] = [];
    again(deps(root, fakeProcesses(root, 0, []), laterEvents, laterFeed), context, ["app"]);
    await settle(() => laterFeed.length > 0);
    expect(laterEvents).toEqual([]);
    expect(laterFeed).toEqual(["deps.verify_green"]);
});

test("a still-red check advances the attempt the guard caps on", async () => {
    const { queueVerify } = await freshQueue();
    const root = await workspace();
    await ready(root, { test: "vitest run" });
    const store = fileVerifyStore(join(root, `${STATE_DIR}/records/verify.json`));
    await store.record("app", "red", 1);
    const events: WorkspaceEvent[] = [];
    queueVerify(deps(root, fakeProcesses(root, 1, []), events, []), context, ["app"]);
    await settle(() => events.length > 0);
    expect(events[0]?.event).toBe("deps.broken");
    expect(events[0]?.deps?.attempt).toBe(2);
});

test("a project with no verify or test script is reported, not guessed at", async () => {
    const { queueVerify } = await freshQueue();
    const root = await workspace();
    await ready(root, {});
    const events: WorkspaceEvent[] = [];
    const feed: string[] = [];
    const started: string[] = [];
    queueVerify(deps(root, fakeProcesses(root, 0, started), events, feed), context, ["app"]);
    await settle(() => feed.length > 0);
    expect(started).toEqual([]);
    expect(events).toEqual([]);
    expect(feed).toEqual(["deps.verify_skipped"]);
});

test("an install that left the project unready stops at telling the owner: no check, no wake", async () => {
    const { queueVerify } = await freshQueue();
    const root = await workspace();
    // Installed marker present, but the declared dependency is still missing: the install failed.
    await write(root, "app/package.json", JSON.stringify({ name: "app", dependencies: { "left-pad": "^1.3.0" }, scripts: { test: "vitest run" } }));
    await write(root, "app/pnpm-lock.yaml", "");
    await mkdir(join(root, "app/node_modules"), { recursive: true });
    const events: WorkspaceEvent[] = [];
    const feed: string[] = [];
    const started: string[] = [];
    queueVerify(deps(root, fakeProcesses(root, 0, started), events, feed), context, ["app"]);
    await settle(() => feed.length > 0);
    expect(started).toEqual([]);
    expect(events).toEqual([]);
    expect(feed).toEqual(["deps.install_failed"]);
});

test("a pane that dies before reporting reads as red, never green", async () => {
    const { queueVerify } = await freshQueue();
    const root = await workspace();
    await ready(root, { test: "vitest run" });
    const events: WorkspaceEvent[] = [];
    // No status file: the pane died before writing one.
    queueVerify(deps(root, fakeProcesses(root, undefined, []), events, []), context, ["app"]);
    await settle(() => events.length > 0);
    expect(events[0]?.event).toBe("deps.broken");
    expect(events[0]?.deps?.exitCode).toBe(-1);
});

test("an install nobody caused records its verdict and wakes nobody", async () => {
    const { queueVerify } = await freshQueue();
    const root = await workspace();
    await ready(root, { test: "vitest run" });
    const events: WorkspaceEvent[] = [];
    const feed: string[] = [];
    const started: string[] = [];
    queueVerify(deps(root, fakeProcesses(root, 1, started), events, feed), { kind: "external" }, ["app"]);
    await settle(() => feed.length > 0);
    expect(started).toEqual(["app--verify"]);
    expect(feed).toEqual(["deps.verify_red"]);
    expect(events).toEqual([]);
});

test("a chain with no event sink at all still checks and still records", async () => {
    const { queueVerify } = await freshQueue();
    const root = await workspace();
    await ready(root, { test: "vitest run" });
    const feed: string[] = [];
    const { emit: _emit, ...sinkless } = deps(root, fakeProcesses(root, 0, []), [], feed);
    queueVerify(sinkless, { kind: "external" }, ["app"]);
    await settle(() => feed.length > 0);
    expect(feed).toEqual(["deps.verify_green"]);
});

test("the check command is the project's own word for it: verify first, then test, then nothing", async () => {
    const root = await workspace();
    await write(root, "both/package.json", JSON.stringify({ scripts: { verify: "a", test: "b" } }));
    await write(root, "tested/package.json", JSON.stringify({ scripts: { test: "b" } }));
    await write(root, "silent/package.json", JSON.stringify({ scripts: { build: "c" } }));
    expect(await checkCommandFor(root, "both", "pnpm")).toBe("pnpm run verify");
    expect(await checkCommandFor(root, "tested", "npm")).toBe("npm run test");
    expect(await checkCommandFor(root, "silent", "pnpm")).toBeUndefined();
    expect(await checkCommandFor(root, "absent", "pnpm")).toBeUndefined();
});

test("the verify store remembers red across restarts: its list is the closure re-check's worklist", async () => {
    const root = await workspace();
    const store = fileVerifyStore(join(root, `${STATE_DIR}/records/verify.json`));
    await store.record("app", "red", 1);
    await store.record("lib", "green", 2);
    // A fresh store over the same file simulates a daemon restart.
    expect(await fileVerifyStore(join(root, ".intentic/records/verify.json")).red()).toEqual(["app"]);
    const status = JSON.parse(await readFile(join(root, ".intentic/records/verify.json"), "utf8")) as {
        projects: Record<string, { attempt: number }>;
    };
    expect(status.projects["app"]?.attempt).toBe(1);
});
