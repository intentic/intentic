import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { STATE_DIR } from "@intentic/constants";
import type { MainlineRouting, WorkspaceEvent } from "@intentic/sandbox-contract";
import type { Logger } from "pino";
import { freshImport, SETTLES, waitFor } from "@intentic/testing/bun";
import type { ManagedProcesses, ProcessSpec } from "../../processes/managed-processes.js";
import type { DependencyLandOrigin } from "./dependency-origin.js";
import { checkRunningIn } from "./checks-in-flight.js";
import { checkCommandFor, type LandBreakage, type VerifyDeps } from "./verify-deps.js";
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

// Simulates a panel by writing the status/log files the daemon reads back, with the exit code the test picks, and the
// failure report a check that writes one leaves beside them; the last run's status and report go first, as the real
// wrapper's `rm -f` sees to.
const fakeProcesses = (
    root: string,
    exitCode: number | undefined,
    started: string[],
    report?: { readonly failures: readonly string[]; readonly rerun?: string },
    commands: string[] = [],
): ManagedProcesses => {
    const live = new Set<string>();
    return {
        start: async (key: string, spec: ProcessSpec) => {
            started.push(key);
            commands.push(spec.command);
            live.add(key);
            const artifacts = join(root, `${STATE_DIR}/local/verify`);
            await mkdir(artifacts, { recursive: true });
            await rm(join(artifacts, `${key}.status`), { force: true });
            await rm(join(artifacts, `${key}.report.json`), { force: true });
            await writeFile(join(artifacts, `${key}.log`), "1 test failed\n");
            if (report !== undefined) {
                await writeFile(join(artifacts, `${key}.report.json`), JSON.stringify(report));
            }
            if (exitCode !== undefined) {
                await writeFile(join(artifacts, `${key}.status`), `${exitCode}\n`);
            }
            live.delete(key);
        },
        running: (key: string) => live.has(key),
    } as unknown as ManagedProcesses;
};

// A pane that never reports: what the daemon's watch window is for, and the one path where a check is stopped mid-write.
const hangingProcesses = (): ManagedProcesses => {
    const live = new Set<string>();
    return {
        start: async (key: string) => void live.add(key),
        running: (key: string) => live.has(key),
        stop: async (key: string) => void live.delete(key),
    } as unknown as ManagedProcesses;
};

// Fresh module per case, since the module's queue is process-wide and mustn't leak between tests. Only this module is
// re-evaluated, so the check window it opens is the one the statically imported registry reports.
const freshQueue = async (): Promise<typeof import("./verify-deps.js")> =>
    freshImport<typeof import("./verify-deps.js")>("./verify-deps.js", import.meta.url);

const deps = (
    root: string,
    processes: ManagedProcesses,
    events: WorkspaceEvent[],
    feed: string[],
    announced: { count: number } = { count: 0 },
): VerifyDeps => ({
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
    announce: () => (announced.count += 1),
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

// A build empties and rewrites its output dir, which the watcher prunes: nothing else can tell a browser that files a
// repo tracks under `dist/` came back, so a review read mid-build would keep reporting them deleted.
test("a finished check says it wrote the tree where nothing was watching", async () => {
    const { queueVerify } = await freshQueue();
    const root = await workspace();
    await ready(root, { verify: "pnpm run build" });
    const feed: string[] = [];
    const announced = { count: 0 };
    queueVerify(deps(root, fakeProcesses(root, 0, []), [], feed, announced), context, ["app"]);
    await settle(() => feed.length > 0);
    expect(feed).toEqual(["deps.verify_green"]);
    expect(announced.count).toBe(1);
});

test("a check that outran the watch window says so too: it wrote before it was stopped", async () => {
    const { queueVerify } = await freshQueue();
    const root = await workspace();
    await ready(root, { test: "vitest run" });
    const feed: string[] = [];
    const announced = { count: 0 };
    queueVerify(deps(root, hangingProcesses(), [], feed, announced), context, ["app"]);
    await settle(() => feed.length > 0);
    expect(feed).toEqual(["deps.verify_lost"]);
    expect(announced.count).toBe(1);
    // A stopped check is still a check that ended: leaving its window open would hide the repo's build outputs for good.
    expect(checkRunningIn("app")).toBe(false);
});

// The main-line strip and the breakage router both read what runs now: a check whose panel never started must not read
// as running until the next one, or a red held on a conversation would be left waiting on a check that is not coming.
test("a check whose panel could not start leaves nothing reading as running", async () => {
    const { queueVerify, verifyQueueSnapshot, landCheckAhead } = await freshQueue();
    const root = await workspace();
    await ready(root, { test: "vitest run" });
    const warned: string[] = [];
    const logger = { info: () => undefined, warn: (_fields: unknown, message: string) => void warned.push(message) } as unknown as Logger;
    const processes = {
        start: async () => {
            throw new Error("tmux: no server running");
        },
        running: () => false,
    } as unknown as ManagedProcesses;
    queueVerify({ ...deps(root, processes, [], []), logger }, context, ["app"]);
    await settle(() => warned.length > 0);
    expect(warned).toEqual(["dependency verify: chain failed"]);
    expect(verifyQueueSnapshot()).toEqual({ current: undefined, pending: [] });
    expect(landCheckAhead("app")).toBe(false);
    expect(checkRunningIn("app")).toBe(false);
});

// The window the review reads (git.routes.ts ownWork): open while the build is rewriting the project's output dirs,
// and already closed when the announcement lands, so the rescan it triggers reports the tree the build settled on.
test("the check window is open while the build runs and closed before the announcement that rescans", async () => {
    const { queueVerify } = await freshQueue();
    const root = await workspace();
    await ready(root, { verify: "pnpm run build" });
    const feed: string[] = [];
    const whileStarting: boolean[] = [];
    const whenAnnounced: boolean[] = [];
    const panels = fakeProcesses(root, 0, []);
    const processes = {
        ...panels,
        start: async (key: string, spec: ProcessSpec) => {
            whileStarting.push(checkRunningIn("app"));
            await panels.start(key, spec);
        },
    } as unknown as ManagedProcesses;
    queueVerify({ ...deps(root, processes, [], feed), announce: () => void whenAnnounced.push(checkRunningIn("app")) }, context, ["app"]);
    await settle(() => feed.length > 0);
    expect(feed).toEqual(["deps.verify_green"]);
    expect(whileStarting).toEqual([true]);
    expect(whenAnnounced).toEqual([false]);
    expect(checkRunningIn("app")).toBe(false);
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

// queue-run's own exit for a command it never started: the repo-verify rule skips rather than overlap a slot holder.
test("a check the queue skipped is reported as not run, and changes no verdict", async () => {
    const { queueVerify } = await freshQueue();
    const root = await workspace();
    await ready(root, { verify: "pnpm run verify" });
    await fileVerifyStore(join(root, `${STATE_DIR}/records/verify.json`)).record("app", "red", 1);
    const events: WorkspaceEvent[] = [];
    const feed: string[] = [];
    queueVerify(deps(root, fakeProcesses(root, 75, []), events, feed), context, ["app"]);
    await settle(() => feed.length > 0);
    expect(feed).toEqual(["deps.verify_deferred"]);
    expect(events).toEqual([]);
    // Still red, still attempt 1: a check that did not run measured nothing.
    expect(await fileVerifyStore(join(root, `${STATE_DIR}/records/verify.json`)).red()).toEqual(["app"]);
    const status = JSON.parse(await readFile(join(root, `${STATE_DIR}/records/verify.json`), "utf8")) as {
        projects: Record<string, { attempt: number }>;
    };
    expect(status.projects["app"]?.attempt).toBe(1);
});

test("the check is told where to leave its failures and which commit the land departed from", async () => {
    const { queueVerify } = await freshQueue();
    const root = await workspace();
    await ready(root, { test: "vitest run" });
    const feed: string[] = [];
    const commands: string[] = [];
    queueVerify(deps(root, fakeProcesses(root, 0, [], undefined, commands), [], feed), context, ["app"]);
    await settle(() => feed.length > 0);
    expect(commands[0]).toContain(`export INTENTIC_VERIFY_REPORT=${join(root, `${STATE_DIR}/local/verify/app--verify.report.json`)}`);
    expect(commands[0]).toContain("export INTENTIC_LAND_FROM=abc");
});

// A router that took the breakage, answering what it decided; the verdict files that answer on the run.
const taking =
    (routing: MainlineRouting | undefined, routed: LandBreakage[]) =>
    async (breakage: LandBreakage): Promise<MainlineRouting | undefined> => {
        routed.push(breakage);
        return routing;
    };

const SENT_BACK: MainlineRouting = { kind: "original", conversationId: "agent-1", at: 5, detail: "Sent back to the conversation that landed it." };

test("failures a red names for the first time go to the router, its answer is filed on the run, and no chore wakes as well", async () => {
    const { queueVerify } = await freshQueue();
    const root = await workspace();
    await ready(root, { test: "vitest run" });
    const events: WorkspaceEvent[] = [];
    const feed: string[] = [];
    const routed: LandBreakage[] = [];
    const verifier = deps(root, fakeProcesses(root, 1, [], { failures: ["app#test a.test.ts › x"], rerun: "pnpm rerun" }), events, feed);
    queueVerify({ ...verifier, route: taking(SENT_BACK, routed) }, context, ["app"]);
    await settle(() => feed.length > 0 && routed.length > 0);
    expect(routed).toEqual([
        {
            project: "app",
            command: "pnpm run test",
            lands: [context],
            fresh: ["app#test a.test.ts › x"],
            failures: ["app#test a.test.ts › x"],
            logTail: "1 test failed\n",
            runAt: expect.any(Number),
            redSince: expect.any(Number),
            queuedBehind: false,
            // What the check's report named to re-run only these, for telling suspect lands apart.
            rerun: "pnpm rerun",
            measured: true,
        },
    ]);
    // Filed on the run once the router has answered.
    await waitFor(async () => expect((await verifier.verifyStore.read()).runs[0]?.routing).toEqual(SENT_BACK), SETTLES);
    // The run as the history files it, and the red streak it starts.
    const { runs, projects } = await verifier.verifyStore.read();
    expect(routed[0]?.runAt).toBe(runs[0]?.at);
    expect(routed[0]?.redSince).toBe(runs[0]?.at);
    expect(projects["app"]?.since).toBe(runs[0]?.at);
    expect(events).toEqual([]);
});

// Every red is the router's to answer, since what an earlier red carried forward may be owed at this one; a router with
// nothing to decide answers nothing, and then the chore hears of it as before.
test("a red that names nothing new since the last one is still handed to the router, and the chore wakes when it takes nothing", async () => {
    const { queueVerify } = await freshQueue();
    const root = await workspace();
    await ready(root, { test: "vitest run" });
    const store = fileVerifyStore(join(root, `${STATE_DIR}/records/verify.json`));
    await store.record("app", "red", 1, ["app#test a.test.ts › x"]);
    const events: WorkspaceEvent[] = [];
    const routed: LandBreakage[] = [];
    queueVerify(
        { ...deps(root, fakeProcesses(root, 1, [], { failures: ["app#test a.test.ts › x"] }), events, []), route: taking(undefined, routed) },
        context,
        ["app"],
    );
    await settle(() => events.length > 0);
    expect(routed).toHaveLength(1);
    expect(routed[0]).toMatchObject({ fresh: [], failures: ["app#test a.test.ts › x"], redSince: 1, queuedBehind: false });
    expect(events[0]?.event).toBe("deps.broken");
    expect(events[0]?.deps?.attempt).toBe(2);
    expect((await store.read()).runs[0]?.routing).toBeUndefined();
});

// Most repositories' checks write no report: a red is then one failure, the check itself, where it turns the project
// red, and nothing new where it only stays red, since nobody can tell from outside what a second red added.
test("a red whose check names no failures is one failure where it turns the project red, and none while it stays red", async () => {
    const { queueVerify } = await freshQueue();
    const root = await workspace();
    await ready(root, { test: "vitest run" });
    const routed: LandBreakage[] = [];
    const verifier = deps(root, fakeProcesses(root, 1, []), [], []);
    queueVerify({ ...verifier, route: taking(undefined, routed) }, context, ["app"]);
    await settle(() => routed.length > 0);
    queueVerify({ ...verifier, route: taking(undefined, routed) }, context, ["app"]);
    await settle(() => routed.length > 1);

    expect(routed.map(({ fresh, failures, measured }) => ({ fresh, failures, measured }))).toEqual([
        { fresh: ["pnpm run test exited 1 without naming its failures"], failures: [], measured: false },
        { fresh: [], failures: [], measured: false },
    ]);
});

test("a red the router only reports still wakes the chore, and the report is filed on the run", async () => {
    const { queueVerify } = await freshQueue();
    const root = await workspace();
    await ready(root, { test: "vitest run" });
    const events: WorkspaceEvent[] = [];
    const routed: LandBreakage[] = [];
    const reported: MainlineRouting = { kind: "reported", at: 6, detail: "Repairs after landing are switched off." };
    const verifier = deps(root, fakeProcesses(root, 1, [], { failures: ["app#test a.test.ts › x"] }), events, []);
    queueVerify({ ...verifier, route: taking(reported, routed) }, context, ["app"]);
    await settle(() => events.length > 0);
    expect(events.map(({ event }) => event)).toEqual(["deps.broken"]);
    expect((await verifier.verifyStore.read()).runs[0]?.routing).toEqual(reported);
});

test("a router that throws is logged and treated as taking nothing, so the chore still wakes", async () => {
    const { queueVerify } = await freshQueue();
    const root = await workspace();
    await ready(root, { test: "vitest run" });
    const events: WorkspaceEvent[] = [];
    const route = async (): Promise<MainlineRouting | undefined> => {
        throw new Error("the fleet is gone");
    };
    queueVerify({ ...deps(root, fakeProcesses(root, 1, [], { failures: ["app#test a.test.ts › x"] }), events, []), route }, context, ["app"]);
    await settle(() => events.length > 0);
    expect(events.map(({ event }) => event)).toEqual(["deps.broken"]);
});

// The history the editor's strip and every card read (mainline-status.ts): one entry per settled run, newest first.
test("every settled run is filed in the history with the lands it answered for, red or green", async () => {
    const { queueVerify, mainlineLandOf } = await freshQueue();
    const root = await workspace();
    await ready(root, { test: "vitest run" });
    const feed: string[] = [];
    const titled: DependencyLandOrigin = { ...context, title: "Fix the parser" };
    const verifier = deps(root, fakeProcesses(root, 1, [], { failures: ["app#test a.test.ts › x", "app#test b.test.ts › y"] }), [], feed);
    queueVerify(verifier, titled, ["app"]);
    await settle(() => feed.length > 0);
    const [red] = (await verifier.verifyStore.read()).runs;
    if (red === undefined) {
        throw new Error("the red run was not filed");
    }
    expect(red).toEqual({
        project: "app",
        command: "pnpm run test",
        status: "red",
        startedAt: expect.any(Number),
        at: expect.any(Number),
        lands: [{ conversationId: "agent-1", title: "Fix the parser", at: expect.any(Number) }],
        failures: ["app#test a.test.ts › x", "app#test b.test.ts › y"],
        failureCount: 2,
        attempt: 1,
    });
    expect(red.lands).toEqual([mainlineLandOf(titled)]);
    expect(red.startedAt).toBeLessThanOrEqual(red.at);

    const { queueVerify: again } = await freshQueue();
    const greenFeed: string[] = [];
    again(deps(root, fakeProcesses(root, 0, []), [], greenFeed), { kind: "external" }, ["app"]);
    await settle(() => greenFeed.length > 0);
    const runs = (await fileVerifyStore(join(root, `${STATE_DIR}/records/verify.json`)).read()).runs;
    expect(runs.map(({ status, lands, failureCount, attempt }) => ({ status, lands, failureCount, attempt }))).toEqual([
        { status: "green", lands: [], failureCount: 0, attempt: 0 },
        { status: "red", lands: red.lands, failureCount: 2, attempt: 1 },
    ]);
});

test("a green run tells the router the project is settled, and is not routed", async () => {
    const { queueVerify } = await freshQueue();
    const root = await workspace();
    await ready(root, { test: "vitest run" });
    const feed: string[] = [];
    const settled: string[] = [];
    const routed: LandBreakage[] = [];
    queueVerify(
        { ...deps(root, fakeProcesses(root, 0, []), [], feed), route: taking(SENT_BACK, routed), settled: (project) => void settled.push(project) },
        context,
        ["app"],
    );
    await settle(() => feed.length > 0);
    expect(feed).toEqual(["deps.verify_green"]);
    expect(settled).toEqual(["app"]);
    expect(routed).toEqual([]);
});

// A land that arrives while the check runs waits, and is measured by the next run with every land queued beside it; the
// red found meanwhile is told that more is coming, so the router can wait for that check before sending anybody.
test("lands queued behind a running check wait for the next run, which the running one's red is told about", async () => {
    const { queueVerify, verifyQueueSnapshot, landCheckAhead } = await freshQueue();
    const root = await workspace();
    await ready(root, { test: "vitest run" });
    const routed: LandBreakage[] = [];
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
        release = resolve;
    });
    const panels = fakeProcesses(root, 1, [], { failures: ["app#test a.test.ts › x"] });
    let starts = 0;
    const processes = {
        ...panels,
        start: async (key: string, spec: ProcessSpec) => {
            starts += 1;
            // The first run is held open until the second land has queued behind it.
            if (starts === 1) {
                await gate;
            }
            await panels.start(key, spec);
        },
    } as unknown as ManagedProcesses;
    const later: DependencyLandOrigin = {
        kind: "land",
        agentId: "agent-2",
        branch: "agent/agent-2",
        repos: [{ repo: "app", from: "def", dir: "app" }],
    };
    const verifier = { ...deps(root, processes, [], []), route: taking(undefined, routed) };
    queueVerify(verifier, context, ["app"]);
    await settle(() => verifyQueueSnapshot().current !== undefined);
    queueVerify(verifier, later, ["app"]);

    const snapshot = verifyQueueSnapshot();
    expect(snapshot.current).toMatchObject({ dir: "app", command: "pnpm run test", lands: [context] });
    expect(snapshot.pending).toEqual([{ dirs: ["app"], lands: [later] }]);
    expect(landCheckAhead("app")).toBe(true);
    expect(landCheckAhead("lib")).toBe(false);

    release();
    await settle(() => routed.length === 2);
    expect(routed.map(({ lands, queuedBehind }) => ({ lands, queuedBehind }))).toEqual([
        { lands: [context], queuedBehind: true },
        { lands: [later], queuedBehind: false },
    ]);
    await settle(() => verifyQueueSnapshot().current === undefined);
    expect(verifyQueueSnapshot()).toEqual({ current: undefined, pending: [] });
    expect(landCheckAhead("app")).toBe(false);
});
