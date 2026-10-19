import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SETTLES, waitFor } from "@intentic/testing/bun";
import { unstubbed } from "@intentic/testing";
import { WORKSPACE_ROOT } from "@intentic/constants";
import type { AgentEvent } from "@intentic/sandbox-contract/events/agent-events";
import type { Services } from "../../../composition.js";
import { spawnServices } from "../../../harness/spawn-services.testing.js";
import { drivenBy } from "../../../seams/turn-starter.testing.js";
import type { TurnInput, TurnStarter } from "../../../seams/turn-starter.js";
import { memoryFleet } from "../../../conversations/registry/agents-registry.testing.js";
import { conversationEntry } from "../../../conversations/registry/agents-store.testing.js";
import { childActor } from "../../../auth/principal.js";
import { resetChildrenForTest, spawnChild } from "../children.js";
import { isWorker } from "../child-records.js";
import { resetSubagents, waitForSubagent } from "../subagents.js";
import { awaitScriptRun, resetScriptRunsForTest, resumeScriptRuns, type ScriptRunStatus, startScriptRun, stopScriptRun } from "../script-runs.js";
import { callKey } from "../script-run-calls.js";
import { scriptRunsDocument } from "../script-run-store.js";
import { openDirectory } from "../../../store/open-document.js";

// A workflow run end to end over the real child engine: its workers are spawned children, its calls are kept, and its
// ending reaches its parent once.

const actors = memoryFleet().conversations;
const parent = { conversationId: "conv-parent", cwd: WORKSPACE_ROOT };
const told: string[] = [];

beforeEach(() => {
    told.length = 0;
    resetScriptRunsForTest();
    resetSubagents(actors);
    resetChildrenForTest(actors);
});

// The daemon over a history volume of the test's own, whose registry names the parent and every child of it, and whose
// parent hears what it is told.
const daemon = async (body: TurnStarter["stream"]): Promise<{ readonly services: Services; readonly root: string }> => {
    const root = await mkdtemp(join(tmpdir(), "script-runs-"));
    const driven = drivenBy(spawnServices({}, [], actors), body);
    const services = unstubbed<Services>("services", {
        ...driven,
        config: unstubbed<Services["config"]>("config", { historyRoot: root }),
        agents: unstubbed<Services["agents"]>("agents", {
            entry: (id: string) =>
                id === parent.conversationId
                    ? conversationEntry({ id })
                    : id.startsWith("sub-")
                      ? conversationEntry({ id, identity: { startedBy: childActor(parent.conversationId) } })
                      : undefined,
        }),
        turns: {
            ...driven.turns,
            say: async (said) => {
                told.push(said.turn.prompt);
                return { delivered: "steered", run: "run-parent" };
            },
        },
    });
    return { services, root };
};

// A child that answers its prompt back, each turn.
const echoing = (turns: TurnInput[]): TurnStarter["stream"] =>
    async function* echo(input: TurnInput): AsyncGenerator<AgentEvent> {
        turns.push(input);
        yield { kind: "delta", text: `Checked: ${input.prompt.split("\n")[0] ?? ""}` };
        yield { kind: "text_end" };
        yield { kind: "done" };
    };

const finished = async (services: Services, run: string): Promise<ScriptRunStatus> => {
    const status = await awaitScriptRun(services, parent.conversationId, run, 10_000, new AbortController().signal);
    if ("ok" in status) {
        throw new Error(status.message);
    }
    return status;
};

const started = async (services: Services, script: string, over: Partial<Parameters<typeof startScriptRun>[2]> = {}): Promise<string> => {
    const run = await startScriptRun(services, parent, { script, defaults: { provider: "claude", model: "claude-sonnet-4-6" }, ...over });
    if (!run.ok) {
        throw new Error(run.message);
    }
    return run.run;
};

describe("a workflow run", () => {
    it("fans its calls out as children, returns what its script returns, and wakes its parent once with it", async () => {
        const turns: TurnInput[] = [];
        const { services } = await daemon(echoing(turns));
        const run = await started(
            services,
            `export const meta = { name: "review", phases: [{ title: "Review" }] };
             phase("Review");
             const found = await parallel(args.files.map((file) => () => agent("review " + file, { label: file })));
             return { found };`,
            { args: { files: ["a.ts", "b.ts"] } },
        );

        const status = await finished(services, run);

        expect(status).toMatchObject({
            state: "done",
            phase: "Review",
            phases: ["Review"],
            calls: { total: 2, running: 0, done: 2, failed: 0, cached: 0 },
            result: { found: ["Checked: review a.ts", "Checked: review b.ts"] },
        });
        expect(turns.map((turn) => turn.prompt).toSorted()).toEqual(["review a.ts", "review b.ts"]);
        expect(turns[0]).toMatchObject({ agent: "claude", model: "claude-sonnet-4-6", isolated: true, unattended: true });
        expect(told).toHaveLength(1);
        expect(told[0]).toMatch(new RegExp(`^Workflow \`review\` \\(run \`${run}\`\\) finished: 2 agent calls\\.`, "u"));
        expect(told[0]).toContain('"Checked: review a.ts"');
        // Its workers' endings are the run's: a wait of the parent's on "any" has nothing to hand over.
        expect(await waitForSubagent(actors, parent.conversationId, { until: ["finished"], timeoutMs: 100 })).toMatchObject({ outcome: "unknown-target" });
    });

    it("sends a worker back to fix a result that does not match its schema, and hands the script the fixed value", async () => {
        const turns: TurnInput[] = [];
        const body = async function* (input: TurnInput): AsyncGenerator<AgentEvent> {
            turns.push(input);
            yield { kind: "delta", text: turns.length === 1 ? "It is real." : '```json\n{"verdict": "real"}\n```' };
            yield { kind: "text_end" };
            yield { kind: "done" };
        };
        const { services } = await daemon(body);
        const run = await started(
            services,
            `export const meta = { name: "verify" };
             return await agent("verify finding 3", { schema: { type: "object", properties: { verdict: { type: "string" } }, required: ["verdict"] } });`,
        );

        const status = await finished(services, run);

        expect(status).toMatchObject({ state: "done", result: { verdict: "real" } });
        expect(turns).toHaveLength(2);
        expect(turns[1]?.prompt).toMatch(/^Your parent's workflow could not use your result: It ended without calling its result tool/u);
    });

    it("ends failed with its script's error when a call fails and nothing catches it", async () => {
        const body = async function* (): AsyncGenerator<AgentEvent> {
            yield { kind: "error", message: "Provider refused." };
            yield { kind: "done" };
        };
        const { services } = await daemon(body);
        const run = await started(services, `export const meta = { name: "fragile" };\nreturn await agent("go", { label: "the one" });`);

        // Its worker's own ending, which goes on to say where else the work can go.
        expect(await finished(services, run)).toMatchObject({ state: "failed", error: expect.stringMatching(/^the one: Provider refused\. Its work so far stays in its worktree\./u), calls: { failed: 1 } });
        expect(told[0]).toContain("failed");
    });

    it("refuses a script with no meta before anything runs", async () => {
        const turns: TurnInput[] = [];
        const { services } = await daemon(echoing(turns));
        expect(await startScriptRun(services, parent, { script: "return 1;" })).toMatchObject({ ok: false, message: expect.stringContaining("export const meta") });
        expect(await startScriptRun(services, parent, { script: `export const meta = { description: "no name" };` })).toMatchObject({
            ok: false,
            message: "Its `meta` needs a `name` (and may have a `description` and `phases`).",
        });
        expect(turns).toEqual([]);
    });

    it("refuses a call that names no provider when the run has no defaults, as the script's error", async () => {
        const { services } = await daemon(echoing([]));
        const run = await startScriptRun(services, parent, { script: `export const meta = { name: "bare" };\nreturn await agent("go");` });
        if (!run.ok) {
            throw new Error(run.message);
        }
        expect(await finished(services, run.run)).toMatchObject({
            state: "failed",
            error: "agent() needs a provider and a model: name them in its options, or give the run its defaults.",
        });
    });
});

describe("a resumed run", () => {
    it("hands back every call whose prompt and options are unchanged, and pays only for the edited one", async () => {
        const turns: TurnInput[] = [];
        const { services } = await daemon(echoing(turns));
        const first = await started(services, `export const meta = { name: "audit" };\nreturn await parallel([() => agent("a"), () => agent("b"), () => agent("c")]);`);
        expect(await finished(services, first)).toMatchObject({ state: "done", result: ["Checked: a", "Checked: b", "Checked: c"] });
        turns.length = 0;

        const second = await started(services, `export const meta = { name: "audit" };\nreturn await parallel([() => agent("a"), () => agent("B, again"), () => agent("c")]);`, {
            resume: first,
        });

        expect(await finished(services, second)).toMatchObject({
            state: "done",
            result: ["Checked: a", "Checked: B, again", "Checked: c"],
            calls: { total: 3, cached: 2 },
        });
        expect(turns.map((turn) => turn.prompt)).toEqual(["B, again"]);
    });

    // bb's replay stops at the first call that comes back in another order (server-harness.test.ts there): a pipeline's
    // later stages are asked in the order the earlier ones finish, which differs run to run.
    it("replays a pipeline whose stages finished in another order", async () => {
        let delays = [30, 0];
        const turns: TurnInput[] = [];
        const body = async function* (input: TurnInput): AsyncGenerator<AgentEvent> {
            turns.push(input);
            const wait = input.prompt.startsWith("find ") ? (delays.shift() ?? 0) : 0;
            await new Promise((resolve) => setTimeout(resolve, wait));
            yield { kind: "delta", text: `done ${input.prompt}` };
            yield { kind: "text_end" };
            yield { kind: "done" };
        };
        const { services } = await daemon(body);
        const script = `export const meta = { name: "pipe" };\nreturn await pipeline(["x", "y"], (item) => agent("find " + item), (found) => agent("check " + found));`;
        const first = await started(services, script);
        expect(await finished(services, first)).toMatchObject({ state: "done", result: ["done check done find x", "done check done find y"] });
        turns.length = 0;
        delays = [0, 30];

        const second = await started(services, script, { resume: first });

        expect(await finished(services, second)).toMatchObject({ state: "done", calls: { total: 4, cached: 4 } });
        expect(turns).toEqual([]);
    });

    it("is refused for a run of another conversation's, or one still running", async () => {
        const gate = Promise.withResolvers<void>();
        const body = async function* (): AsyncGenerator<AgentEvent> {
            await gate.promise;
            yield { kind: "done" };
        };
        const { services } = await daemon(body);
        const running = await started(services, `export const meta = { name: "slow" };\nreturn await agent("go");`);
        expect(await startScriptRun(services, parent, { script: `export const meta = { name: "x" };`, resume: running })).toEqual({
            ok: false,
            message: `Run ${running} is still running: stop it first, or wait for it.`,
        });
        expect(await startScriptRun(services, { ...parent, conversationId: "conv-other" }, { script: `export const meta = { name: "x" };`, resume: "wfr-nope" })).toEqual({
            ok: false,
            message: "No run wfr-nope of this conversation's to resume.",
        });
        gate.resolve();
        await finished(services, running);
    });
});

describe("a run across a restart", () => {
    it("waits on the worker its cut call already had rather than starting it twice", async () => {
        const gate = Promise.withResolvers<void>();
        const turns: TurnInput[] = [];
        const body = async function* (input: TurnInput): AsyncGenerator<AgentEvent> {
            turns.push(input);
            await gate.promise;
            yield { kind: "delta", text: "Ported." };
            yield { kind: "text_end" };
            yield { kind: "done" };
        };
        const { services, root } = await daemon(body);
        // The worker the run had started before the daemon went down, still working.
        const worker = await spawnChild(services, parent, { prompt: "port it", provider: "claude", model: "claude-sonnet-4-6", run: { id: "wfr-cut" } });
        if (!worker.ok) {
            throw new Error(worker.message);
        }
        expect(isWorker(actors, worker.id)).toBe(true);
        const now = Date.now();
        await openDirectory(scriptRunsDocument, join(root, scriptRunsDocument.path)).write("wfr-cut", {
            parent: parent.conversationId,
            cwd: parent.cwd,
            name: "port",
            source: `export const meta = { name: "port" };\nreturn await agent("port it");`,
            args: null,
            defaults: { provider: "claude", model: "claude-sonnet-4-6" },
            concurrency: 8,
            state: "running",
            log: [],
            calls: [
                {
                    key: callKey("port it", { provider: "claude", model: "claude-sonnet-4-6", harness: null, effort: null, schema: null }),
                    occurrence: 0,
                    label: "port it",
                    child: worker.id,
                    state: "running",
                    repairs: 0,
                },
            ],
            startedAt: now,
            at: now,
        });

        await resumeScriptRuns(services, { resume: true });
        gate.resolve();

        expect(await finished(services, "wfr-cut")).toMatchObject({ state: "done", result: "Ported.", calls: { total: 1 } });
        expect(turns.map((turn) => turn.prompt)).toEqual(["port it"]);
    });

    it("ends saying so, keeping its calls for a resume, where the restart resumes nothing", async () => {
        const { services, root } = await daemon(echoing([]));
        const now = Date.now();
        await openDirectory(scriptRunsDocument, join(root, scriptRunsDocument.path)).write("wfr-left", {
            parent: parent.conversationId,
            cwd: parent.cwd,
            name: "left",
            source: `export const meta = { name: "left" };`,
            args: null,
            concurrency: 8,
            state: "running",
            log: [],
            calls: [],
            startedAt: now,
            at: now,
        });

        await resumeScriptRuns(services, { resume: false });

        await waitFor(() => expect(told).toHaveLength(1), SETTLES);
        expect(told[0]).toContain('The sandbox restarted, and this restart resumes nothing. Run it again with resume: "wfr-left" to keep its finished calls.');
    });
});

describe("stopping a run", () => {
    it("ends its script and stops its workers still working", async () => {
        const turns: TurnInput[] = [];
        const body = async function* (input: TurnInput, ...rest: unknown[]): AsyncGenerator<AgentEvent> {
            void rest;
            turns.push(input);
            await new Promise(() => {});
            yield { kind: "done" };
        };
        const { services } = await daemon(body);
        const run = await started(services, `export const meta = { name: "endless" };\nreturn await agent("forever");`);
        await waitFor(() => expect(turns).toHaveLength(1), SETTLES);

        expect(stopScriptRun(parent.conversationId, run)).toMatchObject({ ok: true });
        expect(stopScriptRun("conv-other", run)).toEqual({ ok: false, message: `No running run ${run} of this conversation's.` });

        expect(await finished(services, run)).toMatchObject({ state: "stopped", error: "The workflow was stopped." });
        expect(told[0]).toContain("was stopped");
    });
});
