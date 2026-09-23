import { mkdtempSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { STATE_DIR } from "@intentic/constants";
import { defaultGit } from "@intentic/scaffold";
import { type AgentTurn, type PipelineRun, SandboxSettingsSchema } from "@intentic/sandbox-contract";
import { unstubbed } from "@intentic/testing";
import { SETTLES, waitFor } from "@intentic/testing/bun";
import { sqliteTurnJournal } from "../agent/run/turn/turn-journal.js";
import { fileCapabilitiesStore } from "../capabilities/capabilities-store.js";
import type { Services } from "../composition.js";
import type { FetchFn } from "./providers.js";
import { nextStreak, observeCiRun, resetRepairGate } from "./repair-gate.js";
import { createRunsCache } from "./runs-cache.js";
import type { TurnStarter } from "../seams/turn-starter.js";
import { createDomainEvents } from "../seams/domain-events.js";
import { conversationsDbPath, openConversationsDb } from "../store/conversations-db.js";
import { drivenBy, memoryFleet } from "../testing.js";

/* When main's red gets an agent unasked: only on main's newest word, once per failure, never for the fleet's own death. */

const CODE_JOBS = {
    jobs: [{ id: 7, name: "verify-core", conclusion: "failure", steps: [{ name: "Run pnpm turbo run test", conclusion: "failure" }] }],
};
const FLEET_JOBS = { jobs: [{ id: 8, name: "verify-core", conclusion: "failure", steps: [{ name: "Set up job", conclusion: "failure" }] }] };

const run = (runId: number, status: PipelineRun["status"], branch = "main"): PipelineRun => ({
    repo: "web",
    host: "github",
    project: "acme/web",
    runId,
    branch,
    sha: `sha${runId}`,
    status,
    url: `https://github.com/acme/web/actions/runs/${runId}`,
    createdAt: runId,
});

// The runs list as the forge answers it, newest first, from the runs the test names.
const listed = (runs: readonly PipelineRun[]) => ({
    workflow_runs: runs.map((one) => ({
        id: one.runId,
        head_branch: one.branch,
        head_sha: one.sha,
        status: one.status === "running" ? "in_progress" : "completed",
        conclusion: one.status === "failed" ? "failure" : one.status === "success" ? "success" : null,
        html_url: one.url,
        created_at: new Date(one.createdAt).toISOString(),
        updated_at: new Date(one.createdAt).toISOString(),
    })),
});

const harness = async (forge: { jobs: object; runs: readonly PipelineRun[] }, autoRepair = true) => {
    const root = mkdtempSync(join(tmpdir(), "ci-repair-"));
    const dir = join(root, "web");
    await mkdir(dir, { recursive: true });
    await defaultGit(dir, ["init", "--quiet"]);
    await defaultGit(dir, ["remote", "add", "origin", "https://github.com/acme/web.git"]);
    const capabilities = fileCapabilitiesStore(join(root, STATE_DIR, "config", "capabilities.json"));
    await capabilities.upsert({ id: "github", kind: "cli", config: { provider: "github", token: "T" } });
    const told: string[] = [];
    const services = unstubbed<Services>("services", {
        workspace: unstubbed<Services["workspace"]>("workspace", { root }),
        capabilities,
        ciRuns: createRunsCache(60_000),
        sandboxSettings: unstubbed<Services["sandboxSettings"]>("sandboxSettings", { get: async () => SandboxSettingsSchema.parse({ autoRepair }) }),
        agents: unstubbed<Services["agents"]>("agents", { list: () => [], listArchived: () => [] }),
        activity: unstubbed<Services["activity"]>("activity", {
            append: async (event) => {
                told.push(event.type);
            },
        }),
        turnJournal: sqliteTurnJournal(openConversationsDb(conversationsDbPath(root))),
        transcripts: unstubbed<Services["transcripts"]>("transcripts", { read: async () => [], append: async () => {} }),
        pushSender: unstubbed<Services["pushSender"]>("pushSender", { notifyIfAway: async () => ({ delivered: 0, failed: 0 }) }),
        logger: unstubbed<Services["logger"]>("logger", { info: () => {}, warn: () => {}, error: () => {} }),
        conversations: memoryFleet().conversations,
        events: createDomainEvents(() => {}),
    });
    const started: AgentTurn[] = [];
    const wake: TurnStarter["stream"] = async function* (input) {
        started.push(input);
        yield { kind: "done" } as never;
    };
    const reruns: string[] = [];
    const fetchFn: FetchFn = (async (url: string, init?: RequestInit) => {
        const path = String(url);
        if (init?.method === "POST") {
            reruns.push(path);
            return new Response(null, { status: 201 });
        }
        if (path.includes("/logs")) {
            return new Response("FAIL src/a.test.ts > adds");
        }
        return new Response(JSON.stringify(path.includes("/jobs") ? forge.jobs : listed(forge.runs)));
    }) as unknown as FetchFn;
    return { services: drivenBy(services, wake), fetchFn, started, told, reruns };
};

beforeEach(resetRepairGate);

test("a streak continues while any failed job repeats, and starts over when none does", () => {
    const first = nextStreak(undefined, 41, ["verify-core", "verify-site"]);
    expect(first).toEqual({ jobs: ["verify-core", "verify-site"], runs: 1, firstRunId: 41, runId: 41 });
    expect(nextStreak(first, 42, ["verify-core"])).toEqual({ jobs: ["verify-core"], runs: 2, firstRunId: 41, runId: 42 });
    expect(nextStreak(first, 42, ["images"])).toEqual({ jobs: ["images"], runs: 1, firstRunId: 42, runId: 42 });
});

test("the same jobs failing on main twice running start one fix, named for the run the streak began with", async () => {
    const forge = { jobs: CODE_JOBS, runs: [run(42, "failed"), run(41, "failed")] };
    const { services, fetchFn, started, told } = await harness(forge);
    await observeCiRun(services, run(41, "failed"), fetchFn);
    expect(started).toEqual([]);
    await observeCiRun(services, run(42, "failed"), fetchFn);
    await waitFor(() => expect(started).toHaveLength(1), SETTLES);
    expect(started[0]!.conversationId).toBe("ci-fix-web-41");
    expect(started[0]!.prompt).toContain("Nobody pressed Fix");
    expect(told).toContain("ci.repair_started");
});

test("a newer run standing on main holds the fix back: its own result decides", async () => {
    const forge = { jobs: CODE_JOBS, runs: [run(43, "running"), run(42, "failed"), run(41, "failed")] };
    const { services, fetchFn, started } = await harness(forge);
    await observeCiRun(services, run(41, "failed"), fetchFn);
    await observeCiRun(services, run(42, "failed"), fetchFn);
    expect(started).toEqual([]);
});

test("a run that died on the fleet is re-run once, and a second death is said instead of re-run", async () => {
    const { services, fetchFn, started, told, reruns } = await harness({ jobs: FLEET_JOBS, runs: [run(41, "failed")] });
    await observeCiRun(services, run(41, "failed"), fetchFn);
    await observeCiRun(services, run(41, "failed"), fetchFn);
    expect(reruns).toEqual(["https://api.github.com/repos/acme/web/actions/runs/41/rerun"]);
    expect(told).toEqual(["ci.fleet_rerun", "ci.fleet_failed"]);
    expect(started).toEqual([]);
});

test("green on main retires the streak, and a branch other than main moves nothing", async () => {
    const { services, fetchFn, started, told } = await harness({ jobs: CODE_JOBS, runs: [run(42, "success"), run(41, "failed")] });
    await observeCiRun(services, run(41, "failed"), fetchFn);
    await observeCiRun(services, run(42, "success"), fetchFn);
    await observeCiRun(services, run(43, "failed", "agent/x"), fetchFn);
    expect(told).toEqual(["ci.repair_retired"]);
    expect(started).toEqual([]);
});

test("with repairs switched off, main's red is only reported", async () => {
    const { services, fetchFn, started, reruns } = await harness({ jobs: CODE_JOBS, runs: [run(42, "failed"), run(41, "failed")] }, false);
    await observeCiRun(services, run(41, "failed"), fetchFn);
    await observeCiRun(services, run(42, "failed"), fetchFn);
    expect(started).toEqual([]);
    expect(reruns).toEqual([]);
});
