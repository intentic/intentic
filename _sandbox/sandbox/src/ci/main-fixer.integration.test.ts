import { mkdtempSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { STATE_DIR } from "@intentic/constants";
import { defaultGit } from "@intentic/scaffold";
import { type AgentSummary, NATIVE_PROVIDERS, type PipelineRun, SandboxSettingsSchema } from "@intentic/sandbox-contract";
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
    mainFailures,
    resetMainFixer,
    runFinished,
    streakFixerFor,
    TURNS_PER_STREAK,
} from "./main-fixer.js";
import { ciProjects } from "./projects.js";
import type { FetchFn } from "./providers.js";
import { createRunsCache } from "./runs-cache.js";

/* Main's CI has one fix agent: started at the first failed job, told every later one, and handing main's failure to the
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
    // What the activity feed says, word for word, and what the log was given besides its message.
    const sentences: string[] = [];
    const logged: string[] = [];
    const logFields: unknown[] = [];
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
        // Claude is the one provider this sandbox can serve: a fix with nothing pinned opens on it (ci-fix.ts).
        // SAFETY: one entry per native provider, which is the whole of the record's keys.
        providerReadiness: async () =>
            Object.fromEntries(NATIVE_PROVIDERS.map((provider) => [provider, provider === "claude"])) as Awaited<ReturnType<Services["providerReadiness"]>>,
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
                return { id: `run-${started.length}`, async *frames() {} };
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
                sentences.push(event.content ?? "");
            },
        }),
        logger: unstubbed<Services["logger"]>("logger", {
            info: (...args: unknown[]) => {
                logFields.push(args[0]);
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
    const failure = async () => (await services.ciStore.failures())["web\nmain"];
    return {
        services,
        fetchFn,
        project,
        agents,
        running,
        started,
        said,
        steered,
        told,
        sentences,
        logged,
        logFields,
        reruns,
        forge,
        settings,
        settle,
        failure,
    };
};

beforeEach(resetMainFixer);

test("the first failed job starts one fix agent, named for its run, with that job's log, while the run goes on", async () => {
    const { services, fetchFn, project, started, told, failure } = await harness();

    expect(await jobFailed(services, project, job(41, 7), fetchFn)).toBe("code");

    expect(started.map(({ conversationId }) => conversationId)).toEqual([FIXER]);
    expect(started[0]!.prompt).toContain(`the job "verify-core" in run 41`);
    expect(started[0]!.prompt).toContain("the run may still be going");
    expect(started[0]!.prompt).toContain("FAIL src/a.test.ts > adds");
    expect(started[0]!.errand).toBe("ci-fix");
    expect(told).toEqual(["ci.repair_started"]);
    expect(await failure()).toMatchObject({ firstRunId: 41, runId: 41, count: 1, turns: 1, workflows: { CI: 41 }, heard: ["41/7"] });
    expect(await mainFailures(services)).toEqual([
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
    const { services, fetchFn, project, running, started, said, failure } = await harness();
    await jobFailed(services, project, job(41, 7), fetchFn);

    await jobFailed(services, project, job(41, 8, "lint"), fetchFn);
    expect(said.map((words) => [words.turn.conversationId, words.turn.errand, words.voice])).toEqual([[FIXER, "ci-fix-nudge", "sandbox"]]);
    expect(said[0]!.turn.prompt).toContain(`"lint" in run 41`);
    expect(said[0]!.turn.prompt).toContain("It is in the run this failure began in.");
    expect((await failure())?.turns).toBe(1);

    running.delete(FIXER);
    await jobFailed(services, project, job(42, 9), fetchFn);
    expect(said[1]!.turn.prompt).toContain("It is from a later run, at commit sha42.");
    expect(started).toHaveLength(1);
    expect(await failure()).toMatchObject({ runId: 42, count: 2, turns: 2, workflows: { CI: 42 } });
    expect((await failure())?.findings.map(({ text }) => text)).toEqual(["verify-core", "lint"]);
});

test("a job heard twice, by its own webhook and by its finished run, is handled once", async () => {
    const { services, fetchFn, project, forge, started, said } = await harness();
    forge.jobs[41] = [{ id: 7, name: "verify-core", conclusion: "failure", steps: [{ name: "Run pnpm turbo run test", conclusion: "failure" }] }];

    await jobFailed(services, project, job(41, 7), fetchFn);
    await runFinished(services, run(41, "failed"), fetchFn);

    expect(started).toHaveLength(1);
    expect(said).toEqual([]);
});

test("a job of another branch is no failure of main's", async () => {
    const { services, fetchFn, project, started, failure } = await harness();
    expect(await jobFailed(services, project, job(41, 7, "verify-core", { branch: "agent/x" }), fetchFn)).toBe("skipped");
    expect(started).toEqual([]);
    expect(await failure()).toBeUndefined();
});

test("the fleet's failure is never the agent's: a run only the fleet failed is re-run once, then said", async () => {
    const { services, fetchFn, project, forge, started, told, reruns, failure } = await harness();
    forge.jobs[41] = [{ id: 8, name: "verify-core", conclusion: "failure", steps: [{ name: "Set up job", conclusion: "failure" }] }];

    expect(await jobFailed(services, project, job(41, 8, "verify-core", { step: "Set up job" }), fetchFn)).toBe("fleet");
    await runFinished(services, run(41, "failed"), fetchFn);
    await runFinished(services, run(41, "failed"), fetchFn);

    expect(started).toEqual([]);
    expect(await failure()).toBeUndefined();
    expect(reruns).toEqual(["https://api.github.com/repos/acme/web/actions/runs/41/rerun"]);
    expect(told).toEqual(["ci.fleet_rerun", "ci.fleet_failed"]);
});

test("a later pass of every workflow that failed ends the streak, and another workflow's pass does not", async () => {
    const { services, fetchFn, project, running, steered, told, logged, failure } = await harness();
    await jobFailed(services, project, job(41, 7), fetchFn);
    await jobFailed(services, project, job(43, 11, "analyze", { workflow: "CodeQL" }), fetchFn);

    await runFinished(services, run(44, "success", { workflow: "Scorecard" }), fetchFn);
    expect(Object.keys((await failure())?.workflows ?? {})).toEqual(["CI", "CodeQL"]);
    await runFinished(services, run(45, "success"), fetchFn);
    expect(await failure()).toMatchObject({ workflows: { CodeQL: 43 } });
    expect((await failure())?.findings.map(({ text }) => text)).toEqual(["analyze"]);

    await runFinished(services, run(46, "success", { workflow: "CodeQL" }), fetchFn);
    expect(await failure()).toBeUndefined();
    expect(told).toContain("ci.repair_retired");
    expect(logged).toContain("ci repair: streak ended");
    // Still working when main passed: it is told it may stop.
    expect(running.has(FIXER)).toBe(true);
    expect(steered.map(({ conversationId }) => conversationId)).toEqual([FIXER]);
});

test("a failure older than main's newest pass of its workflow is not main's word", async () => {
    const { services, fetchFn, project, started, failure } = await harness();
    await runFinished(services, run(42, "success"), fetchFn);
    expect(await jobFailed(services, project, job(41, 7), fetchFn)).toBe("skipped");
    expect(started).toEqual([]);
    expect(await failure()).toBeUndefined();
});

test(`past its ${TURNS_PER_STREAK} turns the failure waits for the owner, and nothing more is sent`, async () => {
    const { services, fetchFn, project, running, said, told, sentences, failure } = await harness();
    await jobFailed(services, project, job(41, 7), fetchFn);
    for (let runId = 42; runId <= 42 + TURNS_PER_STREAK; runId += 1) {
        running.delete(FIXER);
        await jobFailed(services, project, job(runId, runId * 10), fetchFn);
    }
    expect(said).toHaveLength(TURNS_PER_STREAK - 1);
    expect((await failure())?.decisions.at(-1)).toMatchObject({
        kind: "spent",
        reason: "turns",
        conversationId: FIXER,
        detail: `Its fix agent had its ${TURNS_PER_STREAK} turns and main still fails.`,
    });
    expect(told).toEqual(["ci.repair_started", "ci.repair_needs_you"]);
    expect(sentences).toEqual([
        "main of web started failing at verify-core: a fix agent is on it, and every later failure goes to it.",
        `main of web still fails and waits for you: its fix agent had its ${TURNS_PER_STREAK} turns and main still fails.`,
    ]);

    running.delete(FIXER);
    await jobFailed(services, project, job(50, 500), fetchFn);
    expect(said).toHaveLength(TURNS_PER_STREAK - 1);
});

test("an agent that finished without changing anything hands the failure over; one that changed something already does not", async () => {
    const { services, fetchFn, project, running, said, told, settle, failure } = await harness();
    await jobFailed(services, project, job(41, 7), fetchFn);
    await settle(FIXER, { status: "idle" });
    expect((await failure())?.decisions.at(-1)).toMatchObject({
        kind: "spent",
        reason: "no-change",
        conversationId: FIXER,
        detail: "Its fix agent finished without changing anything.",
    });
    expect(told).toEqual(["ci.repair_started", "ci.repair_needs_you"]);
    await jobFailed(services, project, job(42, 9), fetchFn);
    expect(said).toEqual([]);

    // A person's press gives it the streak back, with its turns.
    await fixPressed(services, run(42, "failed"), FIXER);
    expect(await failure()).toMatchObject({ turns: 0 });
    running.add(FIXER);
    await settle(FIXER, { status: "landed" });
    expect((await failure())?.changed).toBe(true);
    running.delete(FIXER);
    await jobFailed(services, project, job(43, 10), fetchFn);
    expect(said).toHaveLength(1);
    await settle(FIXER, { status: "idle" });
    expect((await failure())?.decisions.at(-1)?.kind).toBe("fix-up");
});

test("an agent whose turn failed hands the failure over, and a turn the sandbox runs again by itself is not over yet", async () => {
    const { services, fetchFn, project, agents, failure } = await harness();
    await jobFailed(services, project, job(41, 7), fetchFn);
    agents.set(FIXER, summary(FIXER, { status: "error", failure: "the harness crashed" }));
    await fixerSettled(services, { conversationId: FIXER, rerun: {} });
    expect((await failure())?.decisions.at(-1)?.kind).toBe("fix-up");
    await fixerSettled(services, { conversationId: FIXER });
    expect((await failure())?.decisions.at(-1)).toMatchObject({ kind: "spent", reason: "turn-failed", detail: "Its fix agent's turn failed." });
});

// The turn's own error is the log's: the owner reads one short sentence, and the reason is a word a screen phrases itself.
test("a failed turn hands the failure over with its reason, and the agent's own error reaches only the log", async () => {
    const { services, fetchFn, project, settle, sentences, logFields, failure } = await harness();
    await jobFailed(services, project, job(41, 7), fetchFn);
    const error = "Sandbox memory is low: 11.1 GiB resident + 5.0 GiB swapped, against 18.0 GiB";

    await settle(FIXER, { status: "error", failure: error });

    expect((await failure())?.decisions.at(-1)).toEqual({
        kind: "spent",
        reason: "turn-failed",
        conversationId: FIXER,
        at: expect.any(Number),
        detail: "Its fix agent's turn failed.",
    });
    expect(sentences.at(-1)).toBe("main of web still fails and waits for you: its fix agent's turn failed.");
    expect(JSON.stringify(await mainFailures(services))).not.toContain("Sandbox memory");
    expect(sentences.join("\n")).not.toContain("Sandbox memory");
    expect(logFields).toContainEqual(expect.objectContaining({ reason: "turn-failed", fixer: FIXER, cause: error }));
});

test("an archived fix agent hands the failure over as gone, in its own words", async () => {
    const { services, fetchFn, project, agents, failure } = await harness();
    await jobFailed(services, project, job(41, 7), fetchFn);
    agents.set(FIXER, summary(FIXER, { status: "idle", archivedAt: 2_000 }));

    await fixerSettled(services, { conversationId: FIXER });

    expect((await failure())?.decisions.at(-1)).toMatchObject({
        kind: "spent",
        reason: "gone",
        conversationId: FIXER,
        detail: "Its fix agent was archived.",
    });
});

test("with repairs switched off, a failing main is only reported", async () => {
    const { services, fetchFn, project, started, failure } = await harness(false);
    await jobFailed(services, project, job(41, 7), fetchFn);
    await jobFailed(services, project, job(41, 8, "lint"), fetchFn);
    expect(started).toEqual([]);
    expect((await failure())?.decisions.map(({ kind }) => kind)).toEqual(["reported"]);
    expect((await mainFailures(services))[0]).toMatchObject({
        jobs: ["verify-core", "lint"],
        decision: { kind: "reported", detail: "Repairs are off, so nobody was sent." },
    });
    expect((await mainFailures(services))[0]?.fixer).toBeUndefined();
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

test("a press on a run of a failing main-line branch continues the streak's agent; any other run is its own", async () => {
    const { services, fetchFn, project } = await harness();
    expect(await streakFixerFor(services, run(41, "failed"))).toBeUndefined();
    await jobFailed(services, project, job(41, 7), fetchFn);
    expect(await streakFixerFor(services, run(42, "failed"))).toBe(FIXER);
    expect(await streakFixerFor(services, run(42, "failed", { branch: "agent/x" }))).toBeUndefined();
});

// Which branch is main is the repository's own word, not a name: a repo whose default is `develop` is fixed there.
test("a repository whose default branch is not main or master has its fix agent there, and a press continues it", async () => {
    const { services, fetchFn, project, started } = await harness();
    // What a clone of such a repository records: origin/HEAD names its default.
    await defaultGit(join(services.workspace.root, "web"), ["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/develop"]);

    expect(await jobFailed(services, project, job(41, 7, "verify-core", { branch: "develop" }), fetchFn)).toBe("code");
    expect(started.map(({ conversationId }) => conversationId)).toEqual([FIXER]);
    expect(Object.keys(await services.ciStore.failures())).toEqual(["web\ndevelop"]);
    expect(await streakFixerFor(services, run(42, "failed", { branch: "develop" }))).toBe(FIXER);
    // `main` is no main-line branch of this repository: somebody's work in progress.
    expect(await jobFailed(services, project, job(43, 9, "verify-core", { branch: "main" }), fetchFn)).toBe("skipped");
});

// A restart forgets what only the process holds; a fleet run re-run before it is not re-run a second time after.
test("a run only the fleet failed is re-run once, across a restart too", async () => {
    const { services, fetchFn, forge, told, reruns } = await harness();
    forge.jobs[41] = [{ id: 8, name: "verify-core", conclusion: "failure", steps: [{ name: "Set up job", conclusion: "failure" }] }];

    await runFinished(services, run(41, "failed"), fetchFn);
    resetMainFixer();
    await runFinished(services, run(41, "failed"), fetchFn);

    expect(reruns).toEqual(["https://api.github.com/repos/acme/web/actions/runs/41/rerun"]);
    expect(told).toEqual(["ci.fleet_rerun", "ci.fleet_failed"]);
});

// The forge's word (the reconcile's repository read, every delivery) comes before what the clone recorded, and only for
// the repository the remote still names.
test("the default branch the forge said is main's line; one said of a repository the remote no longer names is not", async () => {
    const { services, fetchFn, project, started } = await harness();
    await services.ciStore.learnForge("web", "acme/elsewhere", { id: 5, path: "acme/elsewhere", defaultBranch: "trunk" });
    expect(await jobFailed(services, project, job(40, 6, "verify-core", { branch: "trunk" }), fetchFn)).toBe("skipped");

    await services.ciStore.learnForge("web", "acme/web", { id: 99, path: "acme/web", defaultBranch: "trunk" });
    expect(await jobFailed(services, project, job(41, 7, "verify-core", { branch: "trunk" }), fetchFn)).toBe("code");
    expect(started.map(({ conversationId }) => conversationId)).toEqual([FIXER]);
    expect(await jobFailed(services, project, job(42, 8, "verify-core", { branch: "main" }), fetchFn)).toBe("skipped");
});
