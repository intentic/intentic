import { type FakeExtension, fakeExtensionApi, type FakeManifest } from "@intentic/extension-api/testing";
import type { AgentSummary } from "@intentic/sandbox-contract/schemas/agents";
import type { CiFailure, CiRepairHandOver, PipelineRun } from "@intentic/sandbox-contract/schemas/ci";
import { SETTLES, waitFor } from "@intentic/testing/bun";
import manifestFile from "../../intentic-extension.json";
import { resetMainFixer } from "./main-fixer.js";
import { opt } from "./opt.js";
import { repairStore } from "./repair-store.js";
import { activateServer, MAIN_FAILURES_TOOL } from "./server.js";

/* The backend as the daemon runs it, on the real extension api against a fake daemon that judges every call by this
   manifest's reach: CI heard on its event stream, its fix agent started and told through POST /agent, main lines claimed
   as the owner's switch says, and what the daemon kept of main's repair taken over at the update. */

// SAFETY: the manifest as this extension ships it, which compliance.test.ts holds to the daemon's own schema; JSON reads its
// lists' literals as strings.
const manifest = manifestFile as FakeManifest;

const NO_ATTENTION = { plan: false, question: false, permission: false, capability: false, credential: false, conflict: false };

const run = (runId: number, status: PipelineRun["status"]): PipelineRun => ({
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
});

const summary = (id: string, status: AgentSummary["status"] = "running"): AgentSummary => ({
    id,
    status,
    provider: "claude",
    harness: "native",
    attention: { ...NO_ATTENTION },
    updatedAt: 1,
});

interface Daemon {
    // Every POST /agent, as the daemon was asked.
    readonly said: { readonly conversationId?: string | undefined; readonly prompt?: string | undefined; readonly job?: string | undefined; readonly isolated?: boolean | undefined }[];
    readonly claims: boolean[];
    readonly agents: Map<string, AgentSummary>;
    handedOver: Omit<CiRepairHandOver, "autoRepair"> | undefined;
}

const json = (body: unknown, status = 200): Response => Response.json(body, { status });

const daemonOf = (state: Daemon) => async (request: Request): Promise<Response | undefined> => {
    const { pathname } = new URL(request.url);
    const route = `${request.method} ${pathname}`;
    switch (route) {
        case "GET /ci/main-lines":
            return json({ lines: [{ repo: "web", host: "github", project: "acme/web", branches: ["main"], named: true, concluded: [] }] });
        case "POST /ci/main-lines/claim":
            // SAFETY: the extension's own claim, as its daemon adapter sends it.
            state.claims.push(((await request.json()) as { claimed: boolean }).claimed);
            return json({ ok: true });
        case "POST /ci/repair/hand-over": {
            const handed = state.handedOver ?? { failures: {}, passes: {}, fleetReruns: {}, ownerSteps: {} };
            state.handedOver = undefined;
            return json(handed);
        }
        case "POST /ci/runs/list":
            return json({ runs: [] });
        case "POST /ci/runs/failed-steps":
            return json({ steps: [{ job: "verify-core", id: 410, step: "Run tests", steps: ["Run tests"] }] });
        case "POST /ci/runs/passed-jobs":
            return json({ jobs: [] });
        case "POST /ci/jobs/log":
            return json({ log: "FAIL src/a.test.ts > adds" });
        case "POST /ci/jobs/annotations":
            return json({ annotations: [] });
        case "GET /ci/main/local":
            return json({ local: [], text: "" });
        case "GET /agents":
        case "GET /agents/archived":
            return json({ agents: route === "GET /agents" ? [...state.agents.values()] : [], rev: 1 });
        case "POST /agent": {
            // SAFETY: a test reads back only the fields it names.
            const turn = (await request.json()) as Daemon["said"][number];
            state.said.push(turn);
            const id = turn.conversationId ?? "";
            const live = state.agents.get(id)?.status === "running";
            state.agents.set(id, summary(id));
            return json({ delivered: live ? "steered" : "started", run: "r1" });
        }
        default: {
            const agent = /^GET \/agents\/([^/]+)$/u.exec(route)?.[1];
            if (agent !== undefined) {
                const found = state.agents.get(decodeURIComponent(agent));
                return found === undefined ? json({ message: "not found" }, 404) : json(found);
            }
            return undefined;
        }
    }
};

const started = async (state: Daemon, settings: Readonly<Record<string, boolean>> = {}, stateDir?: string): Promise<FakeExtension> => {
    resetMainFixer({ handoverDelayMs: 60_000 });
    const fake = await fakeExtensionApi({ manifest, daemon: daemonOf(state), settings, ...opt("stateDir", stateDir) });
    await fake.activate({ activateServer });
    return fake;
};

const failingMain = (fake: FakeExtension, runId: number): void => fake.emit({ kind: "ci", event: { kind: "run", run: run(runId, "failed") } });

// The record as the backend keeps it, read through the same store.
const repairOf = (fake: FakeExtension): Promise<Readonly<Record<string, CiFailure>>> => repairStore(fake.api).failures();

const fresh = (): Daemon => ({ said: [], claims: [], agents: new Map(), handedOver: undefined });

// The whole point of the move: a run that fails on main, heard on the extension's own stream, puts exactly one agent on
// it, under this extension's job, and a second hearing of the same run puts nobody else on it.
test("a failing run on main wakes exactly one fix agent, through the extension", async () => {
    const state = fresh();
    const fake = await started(state);
    try {
        await waitFor(() => expect(state.claims).toEqual([true]), SETTLES);
        failingMain(fake, 41);
        failingMain(fake, 41);
        await waitFor(() => expect(state.said).toHaveLength(1), SETTLES);
        // Named for the run the streak began in, in the ci-fix family the board groups attempts by.
        expect(state.said[0]).toMatchObject({ conversationId: expect.stringMatching(/^fix-web-/u), isolated: true, job: "pipeline-fix" });
        expect(state.said[0]?.prompt).toContain(`run 41 failed 1 job: "verify-core", on main of "web"`);
        await waitFor(async () => expect((await repairOf(fake))["web\nmain"]).toMatchObject({ turns: 1, heard: ["41/410"] }), SETTLES);
        expect(fake.activities.map(({ type }) => type)).toEqual(["ci.repair_started"]);
        // What `agents ci` reads through the turn's shell: the failing job, under its run.
        // SAFETY: the tool answers CiMainResponse as JSON (server.ts); only its words are read.
        const answer = JSON.parse(String(await fake.callTool(MAIN_FAILURES_TOOL))) as { text: string };
        expect(answer.text).toContain("web · main: FAILING since");
    } finally {
        await fake.dispose();
    }
});

// The update that moved main's fix agent out of the daemon: its streak, with the turns its agent was given, is taken over
// once, so the next failure goes to the agent already on it; and a restart of the backend keeps it as well.
test("the streak survives the update and a restart: the next failure goes to the agent already on it", async () => {
    const state = fresh();
    state.agents.set("fix-web-40", summary("fix-web-40", "ready"));
    state.handedOver = {
        failures: {
            "web\nmain": {
                since: 1,
                findings: [{ id: "f", source: "CI", text: "verify-core" }],
                decisions: [{ kind: "fix-up", conversationId: "fix-web-40", at: 2 }],
                firstRunId: 40,
                runId: 40,
                count: 1,
                workflows: { CI: 40 },
                spans: {},
                heard: ["40/400"],
                turns: 2,
                changed: true,
            },
        },
        passes: {},
        fleetReruns: {},
        ownerSteps: {},
    };
    const first = await started(state);
    await waitFor(async () => expect(Object.keys(await repairOf(first))).toEqual(["web\nmain"]), SETTLES);
    const stateDir = first.api.stateDir;
    await first.deactivate();
    // The backend restarted: what it kept is read back from its own record, and the daemon hands nothing over twice.
    const second = await started(state, {}, stateDir);
    try {
        await waitFor(() => expect(state.claims).toEqual([true, true]), SETTLES);
        failingMain(second, 41);
        await waitFor(() => expect(state.said).toHaveLength(1), SETTLES);
        expect(state.said[0]).toMatchObject({ conversationId: "fix-web-40", job: "pipeline-fix" });
        expect(state.said[0]?.isolated).toBeUndefined();
        await waitFor(async () => expect((await repairOf(second))["web\nmain"]).toMatchObject({ turns: 3, heard: ["40/400", "41/410"] }), SETTLES);
    } finally {
        await first.dispose();
        await second.dispose();
    }
});

// The owner's switch: off, main's failure is only reported, nobody is sent, and main lines are let go of, so the owner's
// own `ci` automations hear main fail again.
test("with autoRepair off, main's failure is only reported and main lines are not claimed", async () => {
    const state = fresh();
    const fake = await started(state, { autoRepair: false });
    try {
        await waitFor(() => expect(state.claims).toEqual([false]), SETTLES);
        failingMain(fake, 41);
        await waitFor(async () => expect((await repairOf(fake))["web\nmain"]?.decisions.map(({ kind }) => kind)).toEqual(["reported"]), SETTLES);
        expect(state.said).toEqual([]);
        // Switched on again: claimed again.
        fake.setSettings({ autoRepair: true });
        await waitFor(() => expect(state.claims).toEqual([false, true]), SETTLES);
    } finally {
        await fake.dispose();
    }
});
