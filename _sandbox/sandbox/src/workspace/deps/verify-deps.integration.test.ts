import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { STATE_DIR } from "@intentic/constants";
import type { MainlineRouting, WorkspaceEvent } from "@intentic/sandbox-contract";
import type { Logger } from "pino";
import { SETTLES, waitFor } from "@intentic/testing/bun";
import type { ManagedProcesses, ProcessSpec } from "../../processes/managed-processes.js";
import type { DependencyLandOrigin, DependencyOrigin } from "./dependency-origin.js";
import { checkRunningIn } from "./checks-in-flight.js";
import { checkCommandFor, createLandCheck, type LandBreakage, type LandCheck, type LandCheckDeps } from "./verify-deps.js";
import { fileVerifyStore, type QueuedLand } from "./verify-store.js";

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

const deps = (
    root: string,
    processes: ManagedProcesses,
    events: WorkspaceEvent[],
    feed: string[],
    announced: { count: number } = { count: 0 },
): LandCheckDeps => ({
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
    heavyPrefix: async () => "",
    offload: async () => undefined,
    route: async () => undefined,
    settled: async () => undefined,
    recheckPushes: async () => undefined,
    declaredCheck: async () => undefined,
    pollMs: 5,
    watchMaxMs: 200,
    startWaitMs: 100,
});

// A land check on its own queue, asked once for `dirs`; the same check is asked again by calling `enqueue` on it.
const checked = (landCheckDeps: LandCheckDeps, origin: DependencyOrigin, dirs: readonly string[]): LandCheck => {
    const check = createLandCheck(landCheckDeps);
    check.enqueue(origin, dirs);
    return check;
};

// A land as the check files it while it waits: the origin, and when it asked.
const queued = (land: DependencyLandOrigin): QueuedLand => ({ ...land, at: expect.any(Number) as number });

const settle = async (done: () => boolean): Promise<void> => {
    for (let waited = 0; waited < 2_000 && !done(); waited += 10) {
        await new Promise((resolve) => setTimeout(resolve, 10));
    }
};

test("a red check announces deps.broken with the project, command, exit code and log tail", async () => {
    const root = await workspace();
    await ready(root, { test: "vitest run" });
    const events: WorkspaceEvent[] = [];
    const feed: string[] = [];
    const started: string[] = [];
    checked(deps(root, fakeProcesses(root, 1, started), events, feed), context, ["app"]);
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
    const root = await workspace();
    await ready(root, { verify: "pnpm typecheck && pnpm test" });
    const events: WorkspaceEvent[] = [];
    const feed: string[] = [];
    const store = fileVerifyStore(join(root, `${STATE_DIR}/records/verify.json`));
    await store.record("app", "red", 1);
    checked(deps(root, fakeProcesses(root, 0, []), events, feed), context, ["app"]);
    await settle(() => events.length > 0);
    expect(events.map((event) => event.event)).toEqual(["deps.fixed"]);
    expect(events[0]?.deps?.attempt).toBe(0);
    const laterEvents: WorkspaceEvent[] = [];
    const laterFeed: string[] = [];
    checked(deps(root, fakeProcesses(root, 0, []), laterEvents, laterFeed), context, ["app"]);
    await settle(() => laterFeed.length > 0);
    expect(laterEvents).toEqual([]);
    expect(laterFeed).toEqual(["deps.verify_green"]);
});

test("a still-red check advances the attempt the guard caps on", async () => {
    const root = await workspace();
    await ready(root, { test: "vitest run" });
    const store = fileVerifyStore(join(root, `${STATE_DIR}/records/verify.json`));
    await store.record("app", "red", 1);
    const events: WorkspaceEvent[] = [];
    checked(deps(root, fakeProcesses(root, 1, []), events, []), context, ["app"]);
    await settle(() => events.length > 0);
    expect(events[0]?.event).toBe("deps.broken");
    expect(events[0]?.deps?.attempt).toBe(2);
});

test("a project with no verify or test script is reported, not guessed at", async () => {
    const root = await workspace();
    await ready(root, {});
    const events: WorkspaceEvent[] = [];
    const feed: string[] = [];
    const started: string[] = [];
    checked(deps(root, fakeProcesses(root, 0, started), events, feed), context, ["app"]);
    await settle(() => feed.length > 0);
    expect(started).toEqual([]);
    expect(events).toEqual([]);
    expect(feed).toEqual(["deps.verify_skipped"]);
});

test("an install that left the project unready stops at telling the owner: no check, no wake", async () => {
    const root = await workspace();
    // Installed marker present, but the declared dependency is still missing: the install failed.
    await write(root, "app/package.json", JSON.stringify({ name: "app", dependencies: { "left-pad": "^1.3.0" }, scripts: { test: "vitest run" } }));
    await write(root, "app/pnpm-lock.yaml", "");
    await mkdir(join(root, "app/node_modules"), { recursive: true });
    const events: WorkspaceEvent[] = [];
    const feed: string[] = [];
    const started: string[] = [];
    checked(deps(root, fakeProcesses(root, 0, started), events, feed), context, ["app"]);
    await settle(() => feed.length > 0);
    expect(started).toEqual([]);
    expect(events).toEqual([]);
    expect(feed).toEqual(["deps.install_failed"]);
});

test("a pane that dies before reporting reads as red, never green", async () => {
    const root = await workspace();
    await ready(root, { test: "vitest run" });
    const events: WorkspaceEvent[] = [];
    // No status file: the pane died before writing one.
    checked(deps(root, fakeProcesses(root, undefined, []), events, []), context, ["app"]);
    await settle(() => events.length > 0);
    expect(events[0]?.event).toBe("deps.broken");
    expect(events[0]?.deps?.exitCode).toBe(-1);
});

test("an install nobody caused records its verdict and wakes nobody", async () => {
    const root = await workspace();
    await ready(root, { test: "vitest run" });
    const events: WorkspaceEvent[] = [];
    const feed: string[] = [];
    const started: string[] = [];
    checked(deps(root, fakeProcesses(root, 1, started), events, feed), { kind: "external" }, ["app"]);
    await settle(() => feed.length > 0);
    expect(started).toEqual(["app--verify"]);
    expect(feed).toEqual(["deps.verify_red"]);
    expect(events).toEqual([]);
});

// A build empties and rewrites its output dir, which the watcher prunes: nothing else can tell a browser that files a
// repo tracks under `dist/` came back, so a review read mid-build would keep reporting them deleted.
test("a finished check says it wrote the tree where nothing was watching", async () => {
    const root = await workspace();
    await ready(root, { verify: "pnpm run build" });
    const feed: string[] = [];
    const announced = { count: 0 };
    checked(deps(root, fakeProcesses(root, 0, []), [], feed, announced), context, ["app"]);
    await settle(() => feed.length > 0);
    expect(feed).toEqual(["deps.verify_green"]);
    expect(announced.count).toBe(1);
});

test("a check that outran the watch window says so too: it wrote before it was stopped", async () => {
    const root = await workspace();
    await ready(root, { test: "vitest run" });
    const feed: string[] = [];
    const announced = { count: 0 };
    checked(deps(root, hangingProcesses(), [], feed, announced), context, ["app"]);
    await settle(() => feed.length > 0);
    expect(feed).toEqual(["deps.verify_lost"]);
    expect(announced.count).toBe(1);
    // A stopped check is still a check that ended: leaving its window open would hide the repo's build outputs for good.
    expect(checkRunningIn("app")).toBe(false);
});

// The main-line strip and the breakage router both read what runs now: a check whose panel never started must not read
// as running until the next one, or a red held on a conversation would be left waiting on a check that is not coming.
test("a check whose panel could not start leaves nothing reading as running", async () => {
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
    const check = checked({ ...deps(root, processes, [], []), logger }, context, ["app"]);
    await settle(() => warned.length > 0);
    expect(warned).toEqual(["dependency verify: chain failed"]);
    expect(check.current()).toBeUndefined();
    expect(await check.ahead("app")).toBe(false);
    expect(checkRunningIn("app")).toBe(false);
});

// The window the review reads (git.routes.ts ownWork): open while the build is rewriting the project's output dirs,
// and already closed when the announcement lands, so the rescan it triggers reports the tree the build settled on.
test("the check window is open while the build runs and closed before the announcement that rescans", async () => {
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
    checked({ ...deps(root, processes, [], feed), announce: () => void whenAnnounced.push(checkRunningIn("app")) }, context, ["app"]);
    await settle(() => feed.length > 0);
    expect(feed).toEqual(["deps.verify_green"]);
    expect(whileStarting).toEqual([true]);
    expect(whenAnnounced).toEqual([false]);
    expect(checkRunningIn("app")).toBe(false);
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
    const root = await workspace();
    await ready(root, { verify: "pnpm run verify" });
    await fileVerifyStore(join(root, `${STATE_DIR}/records/verify.json`)).record("app", "red", 1);
    const events: WorkspaceEvent[] = [];
    const feed: string[] = [];
    checked(deps(root, fakeProcesses(root, 75, []), events, feed), context, ["app"]);
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
    const root = await workspace();
    await ready(root, { test: "vitest run" });
    const feed: string[] = [];
    const commands: string[] = [];
    checked(deps(root, fakeProcesses(root, 0, [], undefined, commands), [], feed), context, ["app"]);
    await settle(() => feed.length > 0);
    expect(commands[0]).toContain(`export INTENTIC_VERIFY_REPORT=${join(root, `${STATE_DIR}/local/verify/app--verify.report.json`)}`);
    expect(commands[0]).toContain("export INTENTIC_LAND_FROM=abc");
});

test("a check the owner sends to a runner is handed to offload-run, keeping the queued form for running it here", async () => {
    const root = await workspace();
    await ready(root, { test: "vitest run" });
    const feed: string[] = [];
    const commands: string[] = [];
    const verifier: LandCheckDeps = {
        ...deps(root, fakeProcesses(root, 0, [], undefined, commands), [], feed),
        offload: async () => "runner-omen",
        heavyPrefix: async () => "queue-run --pool heavy -- ",
    };
    checked(verifier, context, ["app"]);
    await settle(() => feed.length > 0);
    // The land's base travels, and the report and the tree verdict come back beside where a local run leaves them.
    expect(commands[0]).toContain(
        "/usr/local/bin/offload-run --to runner-omen --label land-check --here 'queue-run --pool heavy -- ' --env INTENTIC_LAND_FROM --export INTENTIC_VERIFY_REPORT --export INTENTIC_VERDICT_OUT -- bash -c 'pnpm run test'",
    );
    expect(commands[0]).toContain(`export INTENTIC_VERDICT_OUT=${join(root, `${STATE_DIR}/local/verify/app--verify.verdict.json`)}`);
    // The verdict it brings back joins this repository's own record, after the status is written.
    expect(commands[0]).toMatch(/> \S+app--verify\.status; \[ -f \S+app--verify\.verdict\.json \] && \[ -f _tools\/scripts\/lib\/tree-verdict\.mjs \]/u);
});

test("a check nobody sends anywhere runs here, with no verdict to bring back", async () => {
    const root = await workspace();
    await ready(root, { test: "vitest run" });
    const feed: string[] = [];
    const commands: string[] = [];
    checked({ ...deps(root, fakeProcesses(root, 0, [], undefined, commands), [], feed), offload: async () => undefined }, context, ["app"]);
    await settle(() => feed.length > 0);
    expect(commands[0]).not.toContain("offload-run");
    expect(commands[0]).not.toContain("INTENTIC_VERDICT_OUT");
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
    const root = await workspace();
    await ready(root, { test: "vitest run" });
    const events: WorkspaceEvent[] = [];
    const feed: string[] = [];
    const routed: LandBreakage[] = [];
    // The `rerun` an older check still writes is read past: nothing re-runs failures to tell suspect lands apart.
    const verifier = deps(root, fakeProcesses(root, 1, [], { failures: ["app#test a.test.ts › x"], rerun: "pnpm rerun" }), events, feed);
    checked({ ...verifier, route: taking(SENT_BACK, routed) }, context, ["app"]);
    await settle(() => feed.length > 0 && routed.length > 0);
    expect(routed).toEqual([
        {
            project: "app",
            command: "pnpm run test",
            lands: [queued(context)],
            fresh: ["app#test a.test.ts › x"],
            failures: ["app#test a.test.ts › x"],
            logTail: "1 test failed\n",
            runAt: expect.any(Number),
            redSince: expect.any(Number),
            queuedBehind: false,
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
    const root = await workspace();
    await ready(root, { test: "vitest run" });
    const store = fileVerifyStore(join(root, `${STATE_DIR}/records/verify.json`));
    await store.record("app", "red", 1, ["app#test a.test.ts › x"]);
    const events: WorkspaceEvent[] = [];
    const routed: LandBreakage[] = [];
    checked(
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
    const root = await workspace();
    await ready(root, { test: "vitest run" });
    const routed: LandBreakage[] = [];
    const verifier = deps(root, fakeProcesses(root, 1, []), [], []);
    checked({ ...verifier, route: taking(undefined, routed) }, context, ["app"]);
    await settle(() => routed.length > 0);
    checked({ ...verifier, route: taking(undefined, routed) }, context, ["app"]);
    await settle(() => routed.length > 1);

    expect(routed.map(({ fresh, failures, measured }) => ({ fresh, failures, measured }))).toEqual([
        { fresh: ["pnpm run test exited 1 without naming its failures"], failures: [], measured: false },
        { fresh: [], failures: [], measured: false },
    ]);
});

test("a red the router only reports still wakes the chore, and the report is filed on the run", async () => {
    const root = await workspace();
    await ready(root, { test: "vitest run" });
    const events: WorkspaceEvent[] = [];
    const routed: LandBreakage[] = [];
    const reported: MainlineRouting = { kind: "reported", at: 6, detail: "Repairs after landing are switched off." };
    const verifier = deps(root, fakeProcesses(root, 1, [], { failures: ["app#test a.test.ts › x"] }), events, []);
    checked({ ...verifier, route: taking(reported, routed) }, context, ["app"]);
    await settle(() => events.length > 0);
    expect(events.map(({ event }) => event)).toEqual(["deps.broken"]);
    expect((await verifier.verifyStore.read()).runs[0]?.routing).toEqual(reported);
});

test("a router that throws is logged and treated as taking nothing, so the chore still wakes", async () => {
    const root = await workspace();
    await ready(root, { test: "vitest run" });
    const events: WorkspaceEvent[] = [];
    const route = async (): Promise<MainlineRouting | undefined> => {
        throw new Error("the fleet is gone");
    };
    checked({ ...deps(root, fakeProcesses(root, 1, [], { failures: ["app#test a.test.ts › x"] }), events, []), route }, context, ["app"]);
    await settle(() => events.length > 0);
    expect(events.map(({ event }) => event)).toEqual(["deps.broken"]);
});

// The history the editor's strip and every card read (mainline-status.ts): one entry per settled run, newest first.
test("every settled run is filed in the history with the lands it answered for, red or green", async () => {
    const root = await workspace();
    await ready(root, { test: "vitest run" });
    const feed: string[] = [];
    const titled: DependencyLandOrigin = { ...context, title: "Fix the parser" };
    const verifier = deps(root, fakeProcesses(root, 1, [], { failures: ["app#test a.test.ts › x", "app#test b.test.ts › y"] }), [], feed);
    checked(verifier, titled, ["app"]);
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
    // Answered: nothing waits in the project any more.
    expect(await verifier.verifyStore.lands()).toEqual({});
    expect(red.startedAt).toBeLessThanOrEqual(red.at);

    const greenFeed: string[] = [];
    checked(deps(root, fakeProcesses(root, 0, []), [], greenFeed), { kind: "external" }, ["app"]);
    await settle(() => greenFeed.length > 0);
    const runs = (await fileVerifyStore(join(root, `${STATE_DIR}/records/verify.json`)).read()).runs;
    expect(runs.map(({ status, lands, failureCount, attempt }) => ({ status, lands, failureCount, attempt }))).toEqual([
        { status: "green", lands: [], failureCount: 0, attempt: 0 },
        { status: "red", lands: red.lands, failureCount: 2, attempt: 1 },
    ]);
});

test("a green run tells the router the project is settled, and is not routed", async () => {
    const root = await workspace();
    await ready(root, { test: "vitest run" });
    const feed: string[] = [];
    const settled: string[] = [];
    const routed: LandBreakage[] = [];
    checked(
        { ...deps(root, fakeProcesses(root, 0, []), [], feed), route: taking(SENT_BACK, routed), settled: async (project) => void settled.push(project) },
        context,
        ["app"],
    );
    await settle(() => feed.length > 0);
    expect(feed).toEqual(["deps.verify_green"]);
    expect(settled).toEqual(["app"]);
    expect(routed).toEqual([]);
});

// A landed fix for what a push let through clears it minutes later: every settled run measures the project's push
// findings again (push-checks.ts decides whether any are open), and never waits on it or fails for it.
test("every settled run, red or green, has the project's push findings measured again without waiting on them", async () => {
    const root = await workspace();
    await ready(root, { test: "vitest run" });
    const feed: string[] = [];
    const rechecked: string[] = [];
    const recheckPushes = async (project: string): Promise<never> => {
        rechecked.push(project);
        throw new Error("no report");
    };
    checked({ ...deps(root, fakeProcesses(root, 1, []), [], feed), recheckPushes }, { kind: "startup" }, ["app"]);
    await settle(() => feed.length > 0);
    checked({ ...deps(root, fakeProcesses(root, 0, []), [], feed), recheckPushes }, { kind: "startup" }, ["app"]);
    await settle(() => feed.length > 1);

    expect(feed).toEqual(["deps.verify_red", "deps.verify_green"]);
    expect(rechecked).toEqual(["app", "app"]);
});

// A land that arrives while the check runs waits, and is measured by the next run with every land queued beside it; the
// red found meanwhile is told that more is coming, so the router can wait for that check before sending anybody.
test("lands queued behind a running check wait for the next run, which the running one's red is told about", async () => {
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
    const check = checked(verifier, context, ["app"]);
    await settle(() => check.current() !== undefined);
    check.enqueue(later, ["app"]);

    // Both wait in the store until a verdict answers them: the running check answers for the first.
    await waitFor(async () => expect(await verifier.verifyStore.lands()).toEqual({ app: [queued(context), queued(later)] }), SETTLES);
    // Read field by field: the lands are the store's own objects, which a matcher must not be handed to rewrite.
    const running = check.current();
    expect([running?.dir, running?.command, running?.session, running?.lands.map(({ agentId }) => agentId)]).toEqual(["app", "pnpm run test", "app--verify", ["agent-1"]]);
    expect(await check.ahead("app")).toBe(true);
    expect(await check.ahead("lib")).toBe(false);

    release();
    await settle(() => routed.length === 2);
    expect(routed.map(({ lands, queuedBehind }) => ({ lands, queuedBehind }))).toEqual([
        { lands: [queued(context)], queuedBehind: true },
        { lands: [queued(later)], queuedBehind: false },
    ]);
    await settle(() => check.current() === undefined);
    expect(check.current()).toBeUndefined();
    expect(await verifier.verifyStore.lands()).toEqual({});
    expect(await check.ahead("app")).toBe(false);
});

// A run that ends without a verdict answers for nobody: its lands wait on, and the next run measures them with its own,
// so the router lays the failures at every land they may have come with, not the newest alone.
test("the lands a run left without a verdict are carried into the next run", async () => {
    const root = await workspace();
    await ready(root, { test: "vitest run" });
    const routed: LandBreakage[] = [];
    const feed: string[] = [];
    let exitCode = 75;
    const panels = (): ManagedProcesses => fakeProcesses(root, exitCode, [], { failures: ["app#test a.test.ts › x"] });
    const processes = { start: async (key: string, spec: ProcessSpec) => panels().start(key, spec), running: () => false } as unknown as ManagedProcesses;
    const later: DependencyLandOrigin = { kind: "land", agentId: "agent-2", branch: "agent/agent-2", repos: [{ repo: "app", from: "def", dir: "app" }] };
    const verifier = { ...deps(root, processes, [], feed), route: taking(undefined, routed) };
    const check = checked(verifier, context, ["app"]);
    await settle(() => feed.length > 0);
    expect(feed).toEqual(["deps.verify_deferred"]);
    expect(await verifier.verifyStore.lands()).toEqual({ app: [queued(context)] });

    exitCode = 1;
    check.enqueue(later, ["app"]);
    await settle(() => routed.length > 0);

    expect(routed.map(({ lands }) => lands)).toEqual([[queued(context), queued(later)]]);
    const [run] = (await verifier.verifyStore.read()).runs;
    expect(run?.lands.map(({ conversationId }) => conversationId)).toEqual(["agent-1", "agent-2"]);
    expect(await verifier.verifyStore.lands()).toEqual({});
});

// The lands waiting live in the verify store, so a daemon that stopped before their check still answers for them.
test("a restarted daemon checks the lands no run answered before it stopped", async () => {
    const root = await workspace();
    await ready(root, { test: "vitest run" });
    const routed: LandBreakage[] = [];
    const verifier = { ...deps(root, fakeProcesses(root, 1, [], { failures: ["app#test a.test.ts › x"] }), [], []), route: taking(undefined, routed) };
    await verifier.verifyStore.owe(["app"], { ...context, at: 42 });

    await createLandCheck(verifier).resume();
    await settle(() => routed.length > 0);

    expect(routed.map(({ lands }) => lands)).toEqual([[{ ...context, at: 42 }]]);
    expect(await verifier.verifyStore.lands()).toEqual({});
});

// The heavy-command queue may hold a check for up to its wait before it starts; that wait is never charged to the
// check's own ceiling, which starts when the check marks its start inside the queue.
test("the watch window starts when the check starts, not while it waits in the queue", async () => {
    const root = await workspace();
    await ready(root, { test: "vitest run" });
    const feed: string[] = [];
    const commands: string[] = [];
    const live = new Set<string>();
    const artifacts = join(root, `${STATE_DIR}/local/verify`);
    const processes = {
        start: async (key: string, spec: ProcessSpec) => {
            commands.push(spec.command);
            live.add(key);
            await mkdir(artifacts, { recursive: true });
            // Queued for 300ms, then the check runs for 150ms: past a 200ms ceiling counted from launch, inside one
            // counted from its start.
            setTimeout(() => void writeFile(join(artifacts, `${key}.started`), ""), 300);
            setTimeout(() => {
                void (async () => {
                    await writeFile(join(artifacts, `${key}.log`), "ok\n");
                    await writeFile(join(artifacts, `${key}.status`), "0\n");
                    live.delete(key);
                })();
            }, 450);
        },
        running: (key: string) => live.has(key),
        stop: async (key: string) => void live.delete(key),
    } as unknown as ManagedProcesses;
    checked({ ...deps(root, processes, [], feed), heavyPrefix: async () => "queue-run -- ", startWaitMs: 1_000 }, context, ["app"]);
    await settle(() => feed.length > 0);

    expect(feed).toEqual(["deps.verify_green"]);
    // The start mark is written inside the queued command, where only a started check reaches it.
    expect(commands[0]).toContain(`queue-run -- bash -c ': > ${join(artifacts, "app--verify.started")}; pnpm run test'`);
});
