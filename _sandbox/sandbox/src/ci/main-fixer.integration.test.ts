import { mkdtempSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { STATE_DIR } from "@intentic/constants";
import { defaultGit } from "@intentic/scaffold";
import { type AgentSummary, type PipelineRun, SandboxSettingsSchema } from "@intentic/sandbox-contract";
import { unstubbed } from "@intentic/testing";
import { fileCapabilitiesStore } from "../capabilities/capabilities-store.js";
import type { Services } from "../composition.js";
import type { PersistedAgent } from "../conversations/registry/agents-store.js";
import type { Said, Steer, TurnInput } from "../seams/turn-starter.js";
import { fileCiStore } from "./ci-store.js";
import {
    type FailedJob,
    fixerSettled,
    fixPressed,
    jobFailed,
    mainReds,
    resetMainFixer,
    runFinished,
    streakFixerFor,
    TURNS_PER_STREAK,
} from "./main-fixer.js";
import { ciProjects } from "./projects.js";
import type { FetchFn } from "./providers.js";
import { createRunsCache } from "./runs-cache.js";

/* Main's CI has one fix agent: started at the first failed job, told every later one, and handing main's red to the
   owner when it can do no more. */

// Dropped rather than fed to a live /events feed, whose subscription would start the runtime sampler.
jest.mock("../seams/runtime-feed.js", () => ({ publishRuntimeChange: () => {} }));

const NO_ATTENTION = { plan: false, question: false, permission: false, capability: false, credential: false, conflict: false };
const FIXER = "ci-fix-web-41";

const job = (runId: number, jobId: number, name = "verify-core", over: Partial<FailedJob> = {}): FailedJob => ({
    runId,
    jobId,
    name,
    branch: "main",
    workflow: "CI",
    sha: `sha${runId}`,
    url: `https://github.com/acme/web/actions/runs/${runId}/job/${jobId}`,
    step: "Run pnpm turbo run test",
    ...over,
});

const run = (runId: number, status: PipelineRun["status"], over: Partial<PipelineRun> = {}): PipelineRun => ({
    repo: "web",
    host: "github",
    project: "acme/web",
    runId,
    workflow: "CI",
    branch: "main",
    sha: `sha${runId}`,
    status,
    url: `https://github.com/acme/web/actions/runs/${runId}`,
    createdAt: runId,
    ...over,
});

const summary = (id: string, over: Partial<AgentSummary> = {}): AgentSummary => ({
    id,
    status: "running",
    provider: "claude",
    harness: "native",
    attention: { ...NO_ATTENTION },
    updatedAt: 1_000,
    ...over,
});

interface Forge {
    // A run's failed jobs as the jobs list answers them.
    jobs: Record<number, { id: number; name: string; conclusion: string; steps?: { name: string; conclusion: string }[] }[]>;
    log: string;
}

const harness = async (autoRepair = true) => {
    const root = mkdtempSync(join(tmpdir(), "ci-main-fixer-"));
    const dir = join(root, "web");
    await mkdir(dir, { recursive: true });
    await defaultGit(dir, ["init", "--quiet"]);
    await defaultGit(dir, ["remote", "add", "origin", "https://github.com/acme/web.git"]);
    const capabilities = fileCapabilitiesStore(join(root, STATE_DIR, "config", "capabilities.json"));
    await capabilities.upsert({ id: "github", kind: "cli", config: { provider: "github", token: "T" } });
    // The fleet as the fixer sees it: who exists, who runs a turn now, and every word it was sent.
    const agents = new Map<string, AgentSummary>();
    const running = new Set<string>();
    const started: (TurnInput & { conversationId: string })[] = [];
    const said: Said[] = [];
    const steered: { conversationId: string; steer: Steer }[] = [];
    const told: string[] = [];
    const logged: string[] = [];
    const reruns: string[] = [];
    const forge: Forge = { jobs: {}, log: "FAIL src/a.test.ts > adds" };
    const settings = { autoRepair };
    const services = unstubbed<Services>("services", {
        workspace: unstubbed<Services["workspace"]>("workspace", { root }),
        capabilities,
        ciRuns: createRunsCache(60_000),
        // Where the streak lives, so a restart (resetMainFixer) keeps it.
        ciStore: fileCiStore(join(root, STATE_DIR, "secrets", "ci.json")),
        sandboxSettings: unstubbed<Services["sandboxSettings"]>("sandboxSettings", { get: async () => SandboxSettingsSchema.parse(settings) }),
        agents: unstubbed<Services["agents"]>("agents", {
            list: () => [...agents.values()],
            listArchived: () => [],
            get: (id) => agents.get(id),
            entry: (id) =>
                agents.has(id) ? unstubbed<PersistedAgent>("entry", { profile: { provider: "claude", harness: "native" }, identity: {} }) : undefined,
        }),
        conversations: unstubbed<Services["conversations"]>("conversations", {
            running: (id) => running.has(id),
            sessionIdOf: () => undefined,
            state: () => undefined,
        }),
        turns: unstubbed<Services["turns"]>("turns", {
            start: async (turn) => {
                started.push(turn);
                agents.set(turn.conversationId, summary(turn.conversationId));
                running.add(turn.conversationId);
                return { id: `run-${started.length}`, frames: async function* () {} };
            },
            say: async (words) => {
                said.push(words);
                if (running.has(words.turn.conversationId)) {
                    return { delivered: "steered", run: "run-live" };
                }
                running.add(words.turn.conversationId);
                return { delivered: "started", run: "run-new" };
            },
            steer: async (conversationId, steer) => {
                steered.push({ conversationId, steer });
                return running.has(conversationId);
            },
        }),
        activity: unstubbed<Services["activity"]>("activity", {
            append: async (event) => {
                told.push(event.type);
            },
        }),
        logger: unstubbed<Services["logger"]>("logger", {
            info: (...args: unknown[]) => {
                logged.push(String(args[1]));
            },
            warn: (...args: unknown[]) => {
                logged.push(String(args[1]));
            },
        }),
    });
    const fetchFn: FetchFn = (async (url: string, init?: RequestInit) => {
        const path = String(url);
        if (init?.method === "POST") {
            reruns.push(path);
            return new Response(null, { status: 201 });
        }
        if (path.includes("/logs")) {
            return new Response(forge.log);
        }
        const runJobs = /\/actions\/runs\/(\d+)\/jobs/.exec(path);
        if (runJobs !== null) {
            return new Response(JSON.stringify({ jobs: forge.jobs[Number(runJobs[1])] ?? [] }));
        }
        return new Response(JSON.stringify({ workflow_runs: [] }));
    }) as unknown as FetchFn;
    // The fix agent's turn ends, the way its summary would read it.
    const settle = async (conversationId: string, over: Partial<AgentSummary>): Promise<void> => {
        running.delete(conversationId);
        agents.set(conversationId, summary(conversationId, over));
        await fixerSettled(services, { conversationId });
    };
    // The workspace's own mapping of the repo to its forge, as every door into the fixer resolves it.
    const [project] = await ciProjects(services);
    if (project === undefined) {
        throw new Error("the web repo should map to its GitHub project");
    }
    const red = async () => (await services.ciStore.reds())["web\nmain"];
    return { services, fetchFn, project, agents, running, started, said, steered, told, logged, reruns, forge, settings, settle, red };
};

beforeEach(resetMainFixer);

test("the first failed job starts one fix agent, named for its run, with that job's log, while the run goes on", async () => {
    const { services, fetchFn, project, started, told, red } = await harness();

    expect(await jobFailed(services, project, job(41, 7), fetchFn)).toBe("code");

    expect(started.map(({ conversationId }) => conversationId)).toEqual([FIXER]);
    expect(started[0]!.prompt).toContain(`the job "verify-core" in run 41`);
    expect(started[0]!.prompt).toContain("the run may still be going");
    expect(started[0]!.prompt).toContain("FAIL src/a.test.ts > adds");
    expect(started[0]!.errand).toBe("ci-fix");
    expect(told).toEqual(["ci.repair_started"]);
    expect(await red()).toMatchObject({ firstRunId: 41, runId: 41, count: 1, turns: 1, workflows: { CI: 41 }, heard: ["41/7"] });
    expect(await mainReds(services)).toEqual([
        {
            repo: "web",
            branch: "main",
            since: expect.any(Number),
            runId: 41,
            jobs: ["verify-core"],
            fixer: FIXER,
            decision: expect.objectContaining({ kind: "fix-up", conversationId: FIXER }),
        },
    ]);
});

test("every later failure goes to the same agent: said into its live turn for free, a turn of its own when idle", async () => {
    const { services, fetchFn, project, running, started, said, red } = await harness();
    await jobFailed(services, project, job(41, 7), fetchFn);

    await jobFailed(services, project, job(41, 8, "lint"), fetchFn);
    expect(said.map((words) => [words.turn.conversationId, words.turn.errand, words.voice])).toEqual([[FIXER, "ci-fix-nudge", "sandbox"]]);
    expect(said[0]!.turn.prompt).toContain(`"lint" in run 41`);
    expect(said[0]!.turn.prompt).toContain("It is in the run this red began in.");
    expect((await red())?.turns).toBe(1);

    running.delete(FIXER);
    await jobFailed(services, project, job(42, 9), fetchFn);
    expect(said[1]!.turn.prompt).toContain("It is from a later run, at commit sha42.");
    expect(started).toHaveLength(1);
    expect(await red()).toMatchObject({ runId: 42, count: 2, turns: 2, workflows: { CI: 42 } });
    expect((await red())?.findings.map(({ text }) => text)).toEqual(["verify-core", "lint"]);
});

test("a job heard twice, by its own webhook and by its finished run, is handled once", async () => {
    const { services, fetchFn, project, forge, started, said } = await harness();
    forge.jobs[41] = [{ id: 7, name: "verify-core", conclusion: "failure", steps: [{ name: "Run pnpm turbo run test", conclusion: "failure" }] }];

    await jobFailed(services, project, job(41, 7), fetchFn);
    await runFinished(services, run(41, "failed"), fetchFn);

    expect(started).toHaveLength(1);
    expect(said).toEqual([]);
});

test("a job of another branch is nobody's red", async () => {
    const { services, fetchFn, project, started, red } = await harness();
    expect(await jobFailed(services, project, job(41, 7, "verify-core", { branch: "agent/x" }), fetchFn)).toBe("skipped");
    expect(started).toEqual([]);
    expect(await red()).toBeUndefined();
});

test("the fleet's failure is never the agent's: a run only the fleet failed is re-run once, then said", async () => {
    const { services, fetchFn, project, forge, started, told, reruns, red } = await harness();
    forge.jobs[41] = [{ id: 8, name: "verify-core", conclusion: "failure", steps: [{ name: "Set up job", conclusion: "failure" }] }];

    expect(await jobFailed(services, project, job(41, 8, "verify-core", { step: "Set up job" }), fetchFn)).toBe("fleet");
    await runFinished(services, run(41, "failed"), fetchFn);
    await runFinished(services, run(41, "failed"), fetchFn);

    expect(started).toEqual([]);
    expect(await red()).toBeUndefined();
    expect(reruns).toEqual(["https://api.github.com/repos/acme/web/actions/runs/41/rerun"]);
    expect(told).toEqual(["ci.fleet_rerun", "ci.fleet_failed"]);
});

test("a later pass of every workflow that failed ends the streak, and another workflow's pass does not", async () => {
    const { services, fetchFn, project, running, steered, told, logged, red } = await harness();
    await jobFailed(services, project, job(41, 7), fetchFn);
    await jobFailed(services, project, job(43, 11, "analyze", { workflow: "CodeQL" }), fetchFn);

    await runFinished(services, run(44, "success", { workflow: "Scorecard" }), fetchFn);
    expect(Object.keys((await red())?.workflows ?? {})).toEqual(["CI", "CodeQL"]);
    await runFinished(services, run(45, "success"), fetchFn);
    expect(await red()).toMatchObject({ workflows: { CodeQL: 43 } });
    expect((await red())?.findings.map(({ text }) => text)).toEqual(["analyze"]);

    await runFinished(services, run(46, "success", { workflow: "CodeQL" }), fetchFn);
    expect(await red()).toBeUndefined();
    expect(told).toContain("ci.repair_retired");
    expect(logged).toContain("ci repair: streak ended");
    // Still working when main passed: it is told it may stop.
    expect(running.has(FIXER)).toBe(true);
    expect(steered.map(({ conversationId }) => conversationId)).toEqual([FIXER]);
});

test("a failure older than main's newest pass of its workflow is not main's word", async () => {
    const { services, fetchFn, project, started, red } = await harness();
    await runFinished(services, run(42, "success"), fetchFn);
    expect(await jobFailed(services, project, job(41, 7), fetchFn)).toBe("skipped");
    expect(started).toEqual([]);
    expect(await red()).toBeUndefined();
});

test(`past its ${TURNS_PER_STREAK} turns the red waits for the owner, and nothing more is sent`, async () => {
    const { services, fetchFn, project, running, said, told, red } = await harness();
    await jobFailed(services, project, job(41, 7), fetchFn);
    for (let runId = 42; runId <= 42 + TURNS_PER_STREAK; runId += 1) {
        running.delete(FIXER);
        await jobFailed(services, project, job(runId, runId * 10), fetchFn);
    }
    expect(said).toHaveLength(TURNS_PER_STREAK - 1);
    expect((await red())?.decisions.at(-1)).toMatchObject({ kind: "spent", conversationId: FIXER });
    expect(told).toEqual(["ci.repair_started", "ci.repair_needs_you"]);

    running.delete(FIXER);
    await jobFailed(services, project, job(50, 500), fetchFn);
    expect(said).toHaveLength(TURNS_PER_STREAK - 1);
});

test("an agent that finished without changing anything hands the red over; one that changed something already does not", async () => {
    const { services, fetchFn, project, running, said, told, settle, red } = await harness();
    await jobFailed(services, project, job(41, 7), fetchFn);
    await settle(FIXER, { status: "idle" });
    expect((await red())?.decisions.at(-1)).toMatchObject({ kind: "spent", conversationId: FIXER });
    expect((await red())?.decisions.at(-1)?.detail).toContain("finished without changing anything");
    expect(told).toEqual(["ci.repair_started", "ci.repair_needs_you"]);
    await jobFailed(services, project, job(42, 9), fetchFn);
    expect(said).toEqual([]);

    // A person's press gives it the streak back, with its turns.
    await fixPressed(services, run(42, "failed"), FIXER);
    expect(await red()).toMatchObject({ turns: 0 });
    running.add(FIXER);
    await settle(FIXER, { status: "landed" });
    expect((await red())?.changed).toBe(true);
    running.delete(FIXER);
    await jobFailed(services, project, job(43, 10), fetchFn);
    expect(said).toHaveLength(1);
    await settle(FIXER, { status: "idle" });
    expect((await red())?.decisions.at(-1)?.kind).toBe("fix-up");
});

test("an agent whose turn failed hands the red over, and a turn the sandbox runs again by itself is not over yet", async () => {
    const { services, fetchFn, project, agents, red } = await harness();
    await jobFailed(services, project, job(41, 7), fetchFn);
    agents.set(FIXER, summary(FIXER, { status: "error", failure: "the harness crashed" }));
    await fixerSettled(services, { conversationId: FIXER, rerun: {} });
    expect((await red())?.decisions.at(-1)?.kind).toBe("fix-up");
    await fixerSettled(services, { conversationId: FIXER });
    expect((await red())?.decisions.at(-1)).toMatchObject({ kind: "spent", detail: expect.stringContaining("the harness crashed") });
});

test("with repairs switched off, main's red is only reported", async () => {
    const { services, fetchFn, project, started, red } = await harness(false);
    await jobFailed(services, project, job(41, 7), fetchFn);
    await jobFailed(services, project, job(41, 8, "lint"), fetchFn);
    expect(started).toEqual([]);
    expect((await red())?.decisions.map(({ kind }) => kind)).toEqual(["reported"]);
    expect((await mainReds(services))[0]).toMatchObject({ jobs: ["verify-core", "lint"], decision: { kind: "reported" } });
    expect((await mainReds(services))[0]?.fixer).toBeUndefined();
});

// The streak is kept with the CI store, not in memory: a restart keeps it, and the agent on it stays its only one.
test("a restart keeps the streak: the next failure goes to the agent already on it, never a second", async () => {
    const { services, fetchFn, project, running, started, said } = await harness();
    await jobFailed(services, project, job(41, 7), fetchFn);

    resetMainFixer();
    running.delete(FIXER);
    await jobFailed(services, project, job(42, 9), fetchFn);
    expect(started).toHaveLength(1);
    expect(said.map((words) => words.turn.conversationId)).toEqual([FIXER]);
});

test("a press on a run of a red main-line branch continues the streak's agent; any other run is its own", async () => {
    const { services, fetchFn, project } = await harness();
    expect(await streakFixerFor(services, run(41, "failed"))).toBeUndefined();
    await jobFailed(services, project, job(41, 7), fetchFn);
    expect(await streakFixerFor(services, run(42, "failed"))).toBe(FIXER);
    expect(await streakFixerFor(services, run(42, "failed", { branch: "agent/x" }))).toBeUndefined();
});
