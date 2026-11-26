import { readFileSync } from "node:fs";
import type { ActivityRow, Disposable } from "@intentic/extension-api";
import { fakeExtensionApi } from "@intentic/extension-api/testing";
import type { AgentSummary } from "@intentic/sandbox-contract/schemas/agents";
import { fixAttemptId } from "@intentic/sandbox-contract/ids/conversation-ids";
import { type CiFailedStep, type CiMainLine, MAIN_FAILURE_STALE_MS, type PipelineRun } from "@intentic/sandbox-contract/schemas/ci";
import { SETTLES, waitFor } from "@intentic/testing/bun";
import type { AgentRun, CiFleet, PipelinesDaemon } from "./daemon.js";
import { ciLogsRoot, jobLogPath } from "./job-logs.js";
import {
    fixerSettled,
    fixPressed,
    forgetFailure,
    jobFailed,
    mainFailures,
    resetMainFixer,
    resumeMainFixer,
    runFinished,
    streakFixerFor,
    TURNS_PER_STREAK,
} from "./main-fixer.js";
import { mainKnown } from "./main-known.js";
import type { FailedJob } from "./main-streak.js";
import type { Repair } from "./repair.js";
import { repairStore } from "./repair-store.js";

/* Main's CI has one fix agent: started with every job its first failed run failed, told each later run's failures as one
   message, and handing main's failure to the owner when it can do no more. (2026-11-26) The daemon's
   ci/main-fixer.integration.test.ts until main's fix agent moved into this extension: the daemon is stood in for by what
   the fixer asks of it (daemon.ts), and the record is the extension's own document. What the forge's API answers is the
   core's to read (its forge/ tests); here the forge's word arrives as the core hands it over, already read. */

const NO_ATTENTION = { plan: false, question: false, permission: false, capability: false, credential: false, conflict: false };
const FIXER = "fix-web-15";
// Said to a fix agent once main passes again: a word into its live turn, never a new turn's.
const MAY_STOP = "Finish what you are doing without starting anything new.";

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

// A refusal as the daemon answers one: with its HTTP status.
const refusal = (status: number, message: string): Error & { readonly status: number } => Object.assign(new Error(message), { status });

interface Forge {
    // Each run's failed jobs as the core reads them off the forge (POST /ci/runs/failed-steps), and the names of its jobs
    // that passed.
    steps: Record<number, CiFailedStep[]>;
    passed: Record<number, string[]>;
    log: string;
    // What a job's check run says of it, by job id.
    annotations: Record<number, string[]>;
    // Runs read one by one, by id.
    runs: Record<number, PipelineRun>;
    // The token may not re-run: every re-run is refused.
    refuseRerun: boolean;
}

const harness = async (autoRepair = true, line: Partial<CiMainLine> = {}) => {
    const fake = await fakeExtensionApi({ manifest: { publisher: "intentic", name: "pipelines" } });
    // The fleet as the fixer sees it: who exists, who runs a turn now, and every word it was sent.
    const agents = new Map<string, AgentSummary>();
    const running = new Set<string>();
    // Turns a fix attempt opened or continued (isolated, under the job), words said to the agent besides, and a word into
    // its live turn that it may stop.
    const started: AgentRun[] = [];
    const said: { readonly turn: AgentRun }[] = [];
    const steered: { readonly conversationId: string; readonly text: string }[] = [];
    const told: string[] = [];
    const sentences: string[] = [];
    const logged: string[] = [];
    const reruns: string[] = [];
    const forge: Forge = { steps: {}, passed: {}, log: "FAIL src/a.test.ts > adds", annotations: {}, runs: {}, refuseRerun: false };
    const devices = new Map<string, { readonly distro?: string; readonly fleet: CiFleet }>();
    const settings = { autoRepair };
    const project: CiMainLine = { repo: "web", host: "github", project: "acme/web", branches: ["main", "master"], named: false, concluded: [], ...line };
    const holds: string[] = [];
    const daemon: PipelinesDaemon = {
        mainLines: async () => [project],
        runs: async () => ({ repos: [], runs: [] }),
        listRuns: async () => Object.values(forge.runs).toSorted((a, b) => b.runId - a.runId),
        run: async (_repo, runId) => {
            const found = forge.runs[runId];
            if (found === undefined) {
                throw refusal(404, "Not Found");
            }
            return found;
        },
        failedSteps: async (_repo, runId) => forge.steps[runId] ?? [],
        passedJobs: async (_repo, runId) => forge.passed[runId] ?? [],
        allJobs: async () => [],
        workflow: async () => ({ called: {} }),
        jobLog: async () => forge.log,
        annotations: async (_repo, jobId) => forge.annotations[jobId] ?? [],
        rerunFailed: async (repo, runId) => {
            reruns.push(`${repo}/${runId}`);
            if (forge.refuseRerun) {
                throw refusal(502, "Resource not accessible by integration");
            }
        },
        localMain: async () => ({ local: [], text: "" }),
        claimMainLines: async () => {},
        handOverRepair: async () => ({ failures: {}, passes: {}, fleetReruns: {}, ownerSteps: {} }),
        // Its card as the daemon serves it: running while a turn is live; once that turn ended, with its work held on its
        // branch, unless a test settled it some other way.
        agent: async (id) => {
            const card = agents.get(id);
            if (card === undefined) {
                return undefined;
            }
            return running.has(id) ? { ...card, status: "running" } : card.status === "running" ? { ...card, status: "ready" } : card;
        },
        roster: async () => [...agents.values()],
        archivedIds: async () => [],
        say: async (turn) => {
            const id = turn.conversationId ?? "";
            if (turn.prompt?.includes(MAY_STOP) === true) {
                steered.push({ conversationId: id, text: turn.prompt });
                return { delivered: "steered" };
            }
            if (turn.isolated === true) {
                started.push(turn);
                agents.set(id, summary(id));
                running.add(id);
                return { delivered: "started", run: `run-${started.length}` };
            }
            said.push({ turn });
            if (running.has(id)) {
                return { delivered: "steered", run: "run-live" };
            }
            running.add(id);
            return { delivered: "started", run: "run-new" };
        },
        stop: async (id) => {
            running.delete(id);
        },
        archive: async () => undefined,
        devices: async () =>
            [...devices].map(([id, device]) => ({
                id,
                hostId: id,
                label: id,
                online: true,
                facts: device.distro === undefined ? { features: ["ci-runners"] } : { features: ["ci-runners"], wsl: { distro: device.distro } },
            })) as never,
        ciFleet: async (id) => {
            const found = devices.get(id)?.fleet;
            if (found === undefined) {
                throw refusal(404, "no such computer");
            }
            return found;
        },
    };
    const repair: Repair = {
        daemon,
        store: repairStore(fake.api),
        logger: {
            info: (_fields, message) => void logged.push(message),
            warn: (_fields, message) => void logged.push(message),
        },
        activity: async (row: ActivityRow) => {
            told.push(row.type);
            sentences.push(row.content);
        },
        autoRepair: async () => settings.autoRepair,
        knownRun: () => undefined,
        hold: (label): Disposable => {
            holds.push(label);
            return { dispose: () => void holds.splice(holds.indexOf(label), 1) };
        },
        logsRoot: ciLogsRoot(),
    };
    // The fix agent's turn ends, the way its card would read it.
    const settle = async (conversationId: string, over: Partial<AgentSummary>): Promise<void> => {
        running.delete(conversationId);
        agents.set(conversationId, summary(conversationId, over));
        await fixerSettled(repair, { conversationId });
    };
    const failure = async () => (await repair.store.failures())["web\nmain"];
    // A run finishing failed, as its frame says it: the forge lists the jobs it failed (one per name, ids from the run's
    // own), and the finished run hands them over.
    const failRun = async (runId: number, names: readonly string[] = ["verify-core"], over: Partial<PipelineRun> = {}): Promise<void> => {
        forge.steps[runId] = names.map((name, index) => ({ job: name, id: runId * 10 + index, step: "Run pnpm turbo run test", steps: ["Run pnpm turbo run test"] }));
        await runFinished(repair, run(runId, "failed", over));
    };
    return { fake, repair, project, agents, running, started, said, steered, told, sentences, logged, reruns, forge, devices, settings, settle, failure, failRun, holds };
};

// Until a condition holds; the bound is a hang guard, never a measure of how long the handover takes.
const until = (holds: () => boolean): Promise<void> => waitFor(() => expect(holds()).toBe(true), { timeout: 5_000, interval: 10 });

beforeEach(() => resetMainFixer());

test("a run's failed jobs are parked while it goes on, and its finish starts one fix agent with all of them", async () => {
    const { repair, project, started, told, failure, failRun } = await harness();

    expect(await jobFailed(repair, project, job(41, 410))).toBe("code");
    expect(await jobFailed(repair, project, job(41, 411, "lint"))).toBe("code");
    expect(started).toEqual([]);
    // The banner reads the failure as it grows; nobody is on it yet, and nothing is heard until it is handed over.
    expect(await failure()).toMatchObject({ firstRunId: 41, runId: 41, count: 1, turns: 0, workflows: { CI: 41 }, heard: [] });
    expect((await mainFailures(repair))[0]).toMatchObject({ jobs: ["verify-core", "lint"] });

    await failRun(41, ["verify-core", "lint"]);

    expect(started.map(({ conversationId }) => conversationId)).toEqual([FIXER]);
    expect(started[0]!.prompt).toContain(`run 41 failed 2 jobs: "verify-core", "lint", on main of "web"`);
    expect(started[0]!.prompt).toContain("so this is the whole list of what it found wrong");
    expect(started[0]!.prompt).toContain("- [verify-core, lint] FAIL src/a.test.ts > adds");
    // Each whole log is kept on this machine and named, so a cause the digest cut off costs the agent no download, and
    // the API is named by the gateway address the placeholder token works through.
    const kept = jobLogPath(ciLogsRoot(), "web", 41, 410, "verify-core");
    expect(started[0]!.prompt).toContain(`whole log: ${kept}`);
    expect(readFileSync(kept, "utf8")).toBe("FAIL src/a.test.ts > adds");
    expect(started[0]!.prompt).toContain("$GITHUB_API_URL_<CONNECTION>");
    expect(started[0]!.job).toBe("pipeline-fix");
    expect(told).toEqual(["ci.repair_started"]);
    expect(await failure()).toMatchObject({ count: 1, turns: 1, heard: ["41/410", "41/411"] });
    expect(await mainFailures(repair)).toEqual([
        {
            repo: "web",
            branch: "main",
            since: expect.any(Number),
            runId: 41,
            jobs: ["verify-core", "lint"],
            workflows: [{ name: "CI", runId: 41, jobs: ["verify-core", "lint"], since: expect.any(Number), failedAt: expect.any(Number) }],
            fixer: FIXER,
            decision: expect.objectContaining({ kind: "fix-up", conversationId: FIXER }),
            attempts: 1,
        },
    ]);
});

test("a failed job is handed over while its run goes on, and the rest of the run follows without another turn", async () => {
    resetMainFixer({ handoverDelayMs: 20 });
    const { repair, project, running, started, said, failure, failRun } = await harness();

    await jobFailed(repair, project, job(41, 410));
    await until(() => started.length === 1);
    expect(started[0]!.prompt).toContain(`run 41 failed 1 job: "verify-core"`);
    expect(started[0]!.prompt).toContain("these are the jobs that have failed in it so far; any that fails later in it is sent to you as it fails");

    // The rest is the finish's to hand over, so the clock goes back to its real length once the first hand-over is on
    // file (nothing is parked or in flight then): the lint job the finish parks arms a clock of its own, and on a loaded
    // runner a 20 ms one beat the finish to it and said the run was still going.
    await waitFor(async () => expect((await failure())?.heard).toEqual(["41/410"]), SETTLES);
    resetMainFixer();
    running.delete(FIXER);
    await failRun(41, ["verify-core", "lint"]);
    expect(said.map((words) => words.turn.conversationId)).toEqual([FIXER]);
    expect(said[0]!.turn.prompt).toContain(`run 41 failed 1 job: "lint"`);
    expect(said[0]!.turn.prompt).toContain("It is the run this failure began in.");
    expect(said[0]!.turn.prompt).toContain("so this is the whole list of what it found wrong");
    // One run is one turn of the streak's budget, however many messages it took.
    expect(await failure()).toMatchObject({ turns: 1, heard: ["41/410", "41/411"] });
});

test("each later run's failures go to the same agent as one message: into its live turn for free, a turn of its own when idle", async () => {
    const { agents, running, started, said, failure, failRun } = await harness();
    await failRun(41);

    await failRun(42, ["verify-core", "lint"]);
    expect(said.map((words) => [words.turn.conversationId, words.turn.job])).toEqual([[FIXER, "pipeline-fix"]]);
    expect(said[0]!.turn.prompt).toContain(`run 42 failed 2 jobs: "verify-core", "lint"`);
    expect(said[0]!.turn.prompt).toContain("It is a later run, at commit sha42.");
    expect(said[0]!.turn.prompt).toContain("--- what failed ---\n2 failed jobs:");
    expect((await failure())?.turns).toBe(1);

    running.delete(FIXER);
    await failRun(43);
    expect(said).toHaveLength(2);
    expect(started).toHaveLength(1);
    expect(await failure()).toMatchObject({ runId: 43, count: 3, turns: 2, workflows: { CI: 43 } });
    // The jobs failing now are the newest finished run's word: lint passed in run 43.
    expect((await failure())?.findings.map(({ text }) => text)).toEqual(["verify-core"]);
    expect([...agents.values()].map(({ id }) => id)).toEqual([FIXER]);
});

test("a job heard twice, by its own webhook and by its finished run, is handed over once", async () => {
    const { repair, project, started, said, failRun } = await harness();

    await jobFailed(repair, project, job(41, 410));
    await failRun(41);
    await failRun(41);

    expect(started).toHaveLength(1);
    expect(said).toEqual([]);
});

// What the process held of a run that had not finished is gone after a restart; the forge's own list of the run's
// failed jobs, read when it finishes, is enough to hand it over whole.
test("a restart between a job failing and its run finishing loses nothing", async () => {
    const { repair, project, started, failure, failRun } = await harness();
    await jobFailed(repair, project, job(41, 410));

    resetMainFixer();
    await failRun(41);

    expect(started.map(({ conversationId }) => conversationId)).toEqual([FIXER]);
    expect(started[0]!.prompt).toContain(`run 41 failed 1 job: "verify-core"`);
    expect((await failure())?.heard).toEqual(["41/410"]);
});

test("a job of another branch is no failure of main's", async () => {
    const { repair, project, started, failure } = await harness();
    expect(await jobFailed(repair, project, job(41, 7, "verify-core", { branch: "agent/x" }))).toBe("skipped");
    expect(started).toEqual([]);
    expect(await failure()).toBeUndefined();
});

test("the fleet's failure is never the agent's: a run only the fleet failed is re-run once, then said", async () => {
    const { repair, project, forge, started, told, reruns, failure } = await harness();
    forge.steps[41] = [{ job: "verify-core", id: 8, step: "Set up job", steps: ["Set up job"] }];

    expect(await jobFailed(repair, project, job(41, 8, "verify-core", { step: "Set up job" }))).toBe("fleet");
    await runFinished(repair, run(41, "failed"));
    await runFinished(repair, run(41, "failed"));

    expect(started).toEqual([]);
    expect(await failure()).toBeUndefined();
    expect(reruns).toEqual(["web/41"]);
    expect(told).toEqual(["ci.fleet_rerun", "ci.fleet_failed"]);
});

test("a later pass of every workflow that failed ends the streak, and another workflow's pass does not", async () => {
    const { repair, running, steered, told, logged, failure, failRun } = await harness();
    await failRun(41);
    await failRun(43, ["analyze"], { workflow: "CodeQL" });

    await runFinished(repair, run(44, "success", { workflow: "Scorecard" }));
    expect(Object.keys((await failure())?.workflows ?? {})).toEqual(["CI", "CodeQL"]);
    // The board is told which workflow each job fails in, so a pass of CI is not read as main passing.
    expect((await mainFailures(repair))[0]?.workflows).toMatchObject([
        { name: "CI", runId: 41, jobs: ["verify-core"] },
        { name: "CodeQL", runId: 43, jobs: ["analyze"] },
    ]);
    await runFinished(repair, run(45, "success"));
    expect(await failure()).toMatchObject({ workflows: { CodeQL: 43 } });
    expect((await failure())?.findings.map(({ text }) => text)).toEqual(["analyze"]);
    expect((await mainFailures(repair))[0]?.workflows).toMatchObject([{ name: "CodeQL", runId: 43, jobs: ["analyze"] }]);

    await runFinished(repair, run(46, "success", { workflow: "CodeQL" }));
    expect(await failure()).toBeUndefined();
    expect(told).toContain("ci.repair_retired");
    expect(logged).toContain("ci repair: streak ended");
    // Still working when main passed: it is told it may stop.
    expect(running.has(FIXER)).toBe(true);
    expect(steered.map(({ conversationId }) => conversationId)).toEqual([FIXER]);
});

test("a failure older than main's newest pass of its workflow is not main's word", async () => {
    const { repair, project, started, failure } = await harness();
    await runFinished(repair, run(42, "success"));
    expect(await jobFailed(repair, project, job(41, 7))).toBe("skipped");
    expect(started).toEqual([]);
    expect(await failure()).toBeUndefined();
});

test(`past its ${TURNS_PER_STREAK} turns the failure waits for the owner, and nothing more is sent`, async () => {
    const { running, said, told, sentences, failure, failRun } = await harness();
    await failRun(41);
    for (let runId = 42; runId <= 42 + TURNS_PER_STREAK; runId += 1) {
        running.delete(FIXER);
        await failRun(runId);
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
        "main of web started failing in run 41, at verify-core: a fix agent is on it with all of them, and every later failure goes to it.",
        `main of web still fails and waits for you: its fix agent had its ${TURNS_PER_STREAK} turns and main still fails.`,
    ]);

    running.delete(FIXER);
    await failRun(50);
    expect(said).toHaveLength(TURNS_PER_STREAK - 1);
});

test("an agent that finished without changing anything hands the failure over; one that changed something already does not", async () => {
    const { repair, running, said, told, settle, failure, failRun } = await harness();
    await failRun(41);
    await settle(FIXER, { status: "idle" });
    expect((await failure())?.decisions.at(-1)).toMatchObject({
        kind: "spent",
        reason: "no-change",
        conversationId: FIXER,
        detail: "Its fix agent finished without changing anything.",
    });
    expect(told).toEqual(["ci.repair_started", "ci.repair_needs_you"]);
    await failRun(42);
    expect(said).toEqual([]);

    // A person's press gives it the streak back, with its turns.
    await fixPressed(repair, run(42, "failed"), [{ runId: 42, jobId: 420 }], async () => ({ kind: "started", conversationId: FIXER, attempt: 1, continued: true }));
    expect(await failure()).toMatchObject({ turns: 0 });
    running.add(FIXER);
    await settle(FIXER, { status: "landed" });
    expect((await failure())?.changed).toBe(true);
    running.delete(FIXER);
    await failRun(43);
    expect(said).toHaveLength(1);
    await settle(FIXER, { status: "idle" });
    expect((await failure())?.decisions.at(-1)?.kind).toBe("fix-up");
});

test("Fix now acknowledges its evidence and hands over only jobs that fail later, including after a restart", async () => {
    const { repair, project, agents, running, said, failure, failRun } = await harness();
    await failRun(41);
    const next = fixAttemptId(FIXER, 2);
    await jobFailed(repair, project, job(42, 420));
    await fixPressed(repair, run(42, "running"), [{ runId: 42, jobId: 420 }], async () => {
        agents.set(next, summary(next));
        running.add(next);
        return { kind: "started", conversationId: next, attempt: 2, continued: false };
    });
    expect((await failure())?.heard).toEqual(["41/410", "42/420"]);
    await failRun(42);
    expect(said).toEqual([]);

    resetMainFixer();
    await failRun(42, ["verify-core", "verify-platform"]);
    expect(said).toHaveLength(1);
    expect(said[0]?.turn.conversationId).toBe(next);
    expect(said[0]?.turn.prompt).toContain('run 42 failed 1 job: "verify-platform"');
    expect((await failure())?.heard).toEqual(["41/410", "42/420", "42/421"]);
});

test("a failure outside the manual snapshot remains parked, and completion waits for the press", async () => {
    const { repair, project, said, failure, failRun } = await harness();
    await failRun(41);
    await jobFailed(repair, project, job(42, 420));
    await jobFailed(repair, project, job(42, 421, "verify-platform"));
    let finishing: Promise<void> | undefined;
    await fixPressed(repair, run(42, "running"), [{ runId: 42, jobId: 420 }], async () => {
        finishing = failRun(42, ["verify-core", "verify-platform"]);
        return { kind: "started", conversationId: FIXER, attempt: 1, continued: true };
    });
    await finishing;
    expect(said).toHaveLength(1);
    expect(said[0]?.turn.prompt).toContain('run 42 failed 1 job: "verify-platform"');
    expect((await failure())?.heard).toEqual(["41/410", "42/420", "42/421"]);
});

test("a busy or refused manual start leaves the parked failures for automatic handover", async () => {
    const { repair, project, said, failure, failRun } = await harness();
    await failRun(41);
    await jobFailed(repair, project, job(42, 420));
    await fixPressed(repair, run(42, "running"), [{ runId: 42, jobId: 420 }], async () => ({ kind: "busy", conversationId: FIXER, reason: "Already working" }));
    await expect(fixPressed(repair, run(42, "running"), [{ runId: 42, jobId: 420 }], async () => { throw new Error("Provider unavailable"); })).rejects.toThrow("Provider unavailable");
    expect((await failure())?.heard).toEqual(["41/410"]);
    await failRun(42);
    expect(said).toHaveLength(1);
    expect(said[0]?.turn.prompt).toContain('run 42 failed 1 job: "verify-core"');
});

test("an agent whose turn failed hands the failure over, and one waiting on a spent allowance is not over yet", async () => {
    const { repair, agents, running, failure, failRun } = await harness();
    await failRun(41);
    running.delete(FIXER);
    // A turn the sandbox runs again by itself reads as waiting on its card, which hands nothing back.
    agents.set(FIXER, summary(FIXER, { status: "error", failure: "usage limit", failureCode: "rate_limit", limitResetsAt: 9_999_999_999 }));
    await fixerSettled(repair, { conversationId: FIXER });
    expect((await failure())?.decisions.at(-1)?.kind).toBe("fix-up");
    agents.set(FIXER, summary(FIXER, { status: "error", failure: "the harness crashed" }));
    await fixerSettled(repair, { conversationId: FIXER });
    expect((await failure())?.decisions.at(-1)).toMatchObject({ kind: "spent", reason: "turn-failed", detail: "Its fix agent's turn failed." });
});

// The turn's own error is the log's: the owner reads one short sentence, and the reason is a word a screen phrases itself.
test("a failed turn hands the failure over with its reason, and the agent's own error reaches only the log", async () => {
    const { repair, settle, sentences, logged, failure, failRun } = await harness();
    await failRun(41);
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
    expect(JSON.stringify(await mainFailures(repair))).not.toContain("Sandbox memory");
    expect(sentences.join("\n")).not.toContain("Sandbox memory");
    expect(logged).toContain("ci repair: the failure was handed to the owner");
});

test("an archived fix agent hands the failure over as gone, in its own words", async () => {
    const { repair, agents, failure, failRun } = await harness();
    await failRun(41);
    agents.set(FIXER, summary(FIXER, { status: "idle", archivedAt: 2_000 }));

    await fixerSettled(repair, { conversationId: FIXER });

    expect((await failure())?.decisions.at(-1)).toMatchObject({
        kind: "spent",
        reason: "gone",
        conversationId: FIXER,
        detail: "Its fix agent was archived.",
    });
});

test("with repairs switched off, a failing main is only reported", async () => {
    const { repair, project, started, failure, failRun } = await harness(false);
    await jobFailed(repair, project, job(41, 410));
    await failRun(41, ["verify-core", "lint"]);
    expect(started).toEqual([]);
    expect((await failure())?.decisions.map(({ kind }) => kind)).toEqual(["reported"]);
    expect((await mainFailures(repair))[0]).toMatchObject({
        jobs: ["verify-core", "lint"],
        decision: { kind: "reported", detail: "Repairs are off, so nobody was sent." },
    });
    expect((await mainFailures(repair))[0]?.fixer).toBeUndefined();
});

// The streak is kept with the CI store, not in memory: a restart keeps it, and the agent on it stays its only one.
test("a restart keeps the streak: the next failure goes to the agent already on it, never a second", async () => {
    const { running, started, said, failRun } = await harness();
    await failRun(41);

    resetMainFixer();
    running.delete(FIXER);
    await failRun(42);
    expect(started).toHaveLength(1);
    expect(said.map((words) => words.turn.conversationId)).toEqual([FIXER]);
});

test("a press on a run of a failing main-line branch continues the streak's agent; any other run is its own", async () => {
    const { repair, project } = await harness();
    expect(await streakFixerFor(repair, run(41, "failed"))).toBeUndefined();
    await jobFailed(repair, project, job(41, 7));
    expect(await streakFixerFor(repair, run(42, "failed"))).toBe(FIXER);
    expect(await streakFixerFor(repair, run(42, "failed", { branch: "agent/x" }))).toBeUndefined();
});

// Which branch is main is the repository's own word, not a name: a repo whose default is `develop` is fixed there.
test("a repository whose default branch is not main or master has its fix agent there, and a press continues it", async () => {
    // What the core resolves of such a repository (GET /ci/main-lines): the clone's origin/HEAD names its default.
    const { repair, project, started, failRun } = await harness(true, { branches: ["develop"], named: true });

    expect(await jobFailed(repair, project, job(41, 410, "verify-core", { branch: "develop" }))).toBe("code");
    await failRun(41, ["verify-core"], { branch: "develop" });
    expect(started.map(({ conversationId }) => conversationId)).toEqual([FIXER]);
    expect(Object.keys(await repair.store.failures())).toEqual(["web\ndevelop"]);
    expect(await streakFixerFor(repair, run(42, "failed", { branch: "develop" }))).toBe(FIXER);
    // `main` is no main-line branch of this repository: somebody's work in progress.
    expect(await jobFailed(repair, project, job(43, 9, "verify-core", { branch: "main" }))).toBe("skipped");
});

// A restart forgets what only the process holds; a fleet run re-run before it is not re-run a second time after.
test("a run only the fleet failed is re-run once, across a restart too", async () => {
    const { repair, forge, told, reruns } = await harness();
    forge.steps[41] = [{ job: "verify-core", id: 8, step: "Set up job", steps: ["Set up job"] }];

    await runFinished(repair, run(41, "failed"));
    resetMainFixer();
    await runFinished(repair, run(41, "failed"));

    expect(reruns).toEqual(["web/41"]);
    expect(told).toEqual(["ci.fleet_rerun", "ci.fleet_failed"]);
});

// A runner's name alone says nothing of which computer it is on, and a PC's hostname is its WSL distros' too: the
// connected computer that has it is asked, and the notice names that computer, the runner's unit and its state.
test("a fleet failure names the connected computer that has the runner, with its unit and state", async () => {
    const { repair, forge, devices, sentences } = await harness();
    const runner = {
        name: "radarsu-worker-3",
        unit: "actions.runner.acme-web.radarsu-worker-3.service",
        dir: "/home/radarsu/actions-runner-3",
        user: "radarsu",
        url: "https://github.com/acme/web",
        light: false,
        state: "inactive" as const,
        busy: false,
        draining: false,
    };
    const fleet = (runners: CiFleet["runners"]): CiFleet => ({ service: { running: true, installed: true }, runners, cacheRoot: "/ci-cache", caches: [] });
    devices.set("z440", { fleet: fleet([{ ...runner, name: "z440-worker-1", unit: "actions.runner.acme-web.z440-worker-1.service" }]) });
    devices.set("omen", { distro: "archlinux", fleet: fleet([runner]) });
    forge.log = "Runner name: 'radarsu-worker-3'\nMachine name: 'omen'\nFAIL src/a.test.ts > adds";
    // The core reads a failed job's check run annotations with its failed steps (its forge/github-cancels.ts).
    forge.steps[56] = [{ job: "e2e", id: 560, runner: "radarsu-worker-3", annotations: ["The self-hosted runner: radarsu-worker-3 lost communication with the server."] }];

    await runFinished(repair, run(56, "failed"));

    expect(sentences[0]).toContain(
        `"e2e" (runner radarsu-worker-3 on omen (archlinux), actions.runner.acme-web.radarsu-worker-3.service, inactive): its runner lost its connection to the forge`,
    );
});

test("a workflow that has not failed for two weeks comes off, and a person can take one off, or the whole failure", async () => {
    const { repair, failure, failRun, sentences } = await harness();
    await failRun(91);
    await failRun(92, ["analyze"], { workflow: "CodeQL" });
    await failRun(93, ["smoke"], { workflow: "Nightly" });
    const longAgo = Date.now() - MAIN_FAILURE_STALE_MS - 1;
    await repair.store.failure("web", "main", (current) =>
        current === undefined ? current : { ...current, spans: { ...current.spans, CodeQL: { since: longAgo, failedAt: longAgo } } },
    );

    // Any pass on the branch sweeps them, whatever workflow passed.
    await runFinished(repair, run(94, "success", { workflow: "Scorecard" }));
    expect(Object.keys((await failure())?.workflows ?? {})).toEqual(["CI", "Nightly"]);

    expect(await forgetFailure(repair, { repo: "web", branch: "main", workflow: "Nightly" })).toBe(true);
    expect(Object.keys((await failure())?.workflows ?? {})).toEqual(["CI"]);
    expect((await failure())?.findings.map(({ text }) => text)).toEqual(["verify-core"]);
    expect(await forgetFailure(repair, { repo: "web", branch: "main", workflow: "Nightly" })).toBe(false);

    expect(await forgetFailure(repair, { repo: "web", branch: "main" })).toBe(true);
    expect(await failure()).toBeUndefined();
    expect(sentences.at(-1)).toContain("main of web was set aside by hand");
});

test("each workflow keeps its own times, and a failure kept before they were timed apart learns them at boot", async () => {
    const { repair, failure, failRun, forge } = await harness();
    await failRun(101);
    const since = (await failure())?.spans["CI"]?.since ?? 0;
    await failRun(102, ["analyze"], { workflow: "CodeQL" });
    await failRun(103);
    expect((await failure())?.spans["CI"]).toEqual({ since, failedAt: expect.any(Number) });
    expect((await failure())?.spans["CodeQL"]?.since).toBeGreaterThanOrEqual(since);

    // Kept before 2026-11-03: three workflows with no times, one of them a Dependabot update's.
    const recent = Date.now() - 60_000;
    const older = Date.now() - 3_600_000;
    forge.runs[110] = run(110, "failed", { trigger: "dynamic", createdAt: recent, workflow: "cargo in /app for glib - Update #1" });
    forge.runs[111] = run(111, "failed", { trigger: "schedule", createdAt: recent, workflow: "Nightly" });
    forge.runs[109] = run(109, "success", { trigger: "push", createdAt: older, workflow: "CI" });
    forge.runs[112] = run(112, "failed", { trigger: "push", createdAt: recent, workflow: "CI" });
    await repair.store.recordPass("web", "main", "CI", 109);
    await repair.store.failure("web", "main", () => ({
        since: 1,
        findings: [
            { id: "a", source: "cargo in /app for glib - Update #1", text: "Dependabot" },
            { id: "b", source: "Nightly", text: "smoke" },
            { id: "c", source: "CI", text: "verify-core" },
        ],
        decisions: [],
        firstRunId: 100,
        runId: 112,
        count: 3,
        workflows: { "cargo in /app for glib - Update #1": 110, Nightly: 111, CI: 112 },
        spans: {},
        heard: [],
        turns: 0,
        changed: false,
    }));
    resetMainFixer();

    await resumeMainFixer(repair);

    expect(Object.keys((await failure())?.workflows ?? {})).toEqual(["Nightly", "CI"]);
    expect((await failure())?.spans).toEqual({
        // Nothing passed on file: failing at most since the streak began.
        Nightly: { since: 1, failedAt: recent, trigger: "schedule" },
        // Failing since its newest pass.
        CI: { since: older, failedAt: recent, trigger: "push" },
    });
});

// 2026-11-17, the shinobi-society audit: agents re-ran main to tell whether a failure was theirs. `agents ci` answers from
// what the fixer already read of each failed job (main-known.ts), and says so when nothing was heard.
test("an agent asking what main fails on reads each job's run, commit and failing tests, and nothing heard reads as unknown", async () => {
    const { repair, project, forge, failRun } = await harness();
    expect((await mainKnown(repair)).branches).toEqual([{ repo: "web", state: "unread", jobs: [] }]);

    forge.log = "src/ci/poller.test.ts:\nerror: expect(received).toBe(expected)\n(fail) polls once [3.00ms]";
    await failRun(41);
    const failing = await mainKnown(repair);
    expect(failing.branches).toEqual([
        {
            repo: "web",
            branch: "main",
            state: "failing",
            since: expect.any(Number),
            fixer: FIXER,
            jobs: [
                {
                    workflow: "CI",
                    job: "verify-core",
                    runId: 41,
                    sha: "sha41",
                    readAt: expect.any(Number),
                    errors: ["(fail) polls once — expect(received).toBe(expected)"],
                },
            ],
        },
    ]);
    expect(failing.text).toContain("  CI / verify-core: run 41 at sha41, read ");
    expect(failing.text).toContain("    - (fail) polls once — expect(received).toBe(expected)");

    await runFinished(repair, run(42, "success"));
    // The core's word on the main line's newest run (GET /ci/main-lines `concluded`).
    project.concluded.push({ branch: "main", status: "success", at: Date.now() });
    expect((await mainKnown(repair)).branches).toEqual([
        { repo: "web", branch: "main", state: "clear", jobs: [], lastRun: { status: "success", at: expect.any(Number) } },
    ]);

    // A failure kept before findings kept their own run borrows its workflow's newest failed run, and says what is missing.
    await repair.store.failure("web", "main", () => ({
        since: 1,
        findings: [{ id: "c", source: "CI", text: "verify-core" }],
        decisions: [],
        firstRunId: 50,
        runId: 50,
        count: 1,
        workflows: { CI: 50 },
        spans: { CI: { since: 1, failedAt: 2 } },
        heard: [],
        turns: 0,
        changed: false,
    }));
    const kept = await mainKnown(repair);
    expect(kept.branches[0]?.jobs).toEqual([{ workflow: "CI", job: "verify-core", runId: 50, readAt: 2 }]);
    expect(kept.text).toContain("what its log named was not kept");
});
