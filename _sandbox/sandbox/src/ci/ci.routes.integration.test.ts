import { mkdtempSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { STATE_DIR } from "@intentic/constants";
import { defaultGit } from "@intentic/scaffold";
import { type AgentTurn, type ModelPin, NATIVE_PROVIDERS, SandboxSettingsSchema } from "@intentic/sandbox-contract";
import { unstubbed } from "@intentic/testing";
import { call } from "@orpc/server";
import { SETTLES, waitFor } from "@intentic/testing/bun";
import { sqliteTurnJournal } from "../agent/run/turn/turn-journal.js";
import { conversationsDbPath, openConversationsDb } from "../store/conversations-db.js";
import { fileCapabilitiesStore } from "../capabilities/capabilities-store.js";
import type { OrpcContext } from "../app-env.js";
import type { Services } from "../composition.js";
import { type CiFailure, fileCiStore } from "./ci-store.js";
import { createCiRoutes } from "./ci.routes.js";
import type { FetchFn } from "./providers.js";
import { createRunsCache } from "./runs-cache.js";
import type { TurnStarter } from "../seams/turn-starter.js";
import { createDomainEvents } from "../seams/domain-events.js";
import { drivenBy, memoryFleet } from "../testing.js";

/* What Fix on a failed pipeline actually starts: a session nobody has limited, carrying a prepared prompt. */

const context: OrpcContext = { headers: new Headers(), method: "POST", url: "/ci/fix" };

const RUN_ID = 41;

// One failed job with a failed step of its own, so the run reads as this repository's code failing rather than a
// runner dying in its own setup (which `fix` refuses before starting anybody).
const JOBS = { jobs: [{ id: 7, name: "onboarding", conclusion: "failure", steps: [{ name: "Run onboarding tier", conclusion: "failure" }] }] };

// Main failing since run 40, its fix agent's turns spent, as the CI store keeps it.
const SPENT: CiFailure = {
    since: 1,
    findings: [{ id: "f", source: "CI", text: "onboarding" }],
    decisions: [
        {
            kind: "fix-up",
            conversationId: "ci-fix-web-40",
            at: 1,
            detail: "Its first failed job, onboarding, put a fix agent on it; every later failure goes to the same one.",
        },
        { kind: "spent", reason: "turns", conversationId: "ci-fix-web-40", at: 2, detail: "Its fix agent had its 3 turns and main still fails." },
    ],
    firstRunId: 40,
    runId: RUN_ID,
    count: 2,
    workflows: { CI: RUN_ID },
    heard: ["40/6", "41/7"],
    turns: 3,
    changed: false,
};

// Which providers this sandbox can serve, and what Models pins for fixing pipelines; Claude alone and nothing, unless
// a test says otherwise.
interface Setup {
    readonly ready?: readonly string[];
    readonly pinned?: readonly ModelPin[];
}

const harness = async ({ ready = ["claude"], pinned = [] }: Setup = {}) => {
    const root = mkdtempSync(join(tmpdir(), "ci-fix-"));
    const dir = join(root, "web");
    await mkdir(dir, { recursive: true });
    await defaultGit(dir, ["init", "--quiet"]);
    await defaultGit(dir, ["remote", "add", "origin", "https://github.com/acme/web.git"]);
    const capabilities = fileCapabilitiesStore(join(root, `${STATE_DIR}`, "config", "capabilities.json"));
    await capabilities.upsert({ id: "github", kind: "cli", config: { provider: "github", token: "T" } });
    const ciRuns = createRunsCache(60_000);
    ciRuns.replace([
        {
            repo: "web",
            host: "github",
            project: "acme/web",
            runId: RUN_ID,
            title: "build broke",
            branch: "main",
            sha: "sha41",
            status: "failed",
            url: `https://github.com/acme/web/actions/runs/${RUN_ID}`,
            createdAt: 1,
        },
    ]);
    const services = unstubbed<Services>("services", {
        workspace: unstubbed<Services["workspace"]>("workspace", { root }),
        capabilities,
        ciRuns,
        // Where main's failures live: a press on a run of a failing main is its streak's.
        ciStore: fileCiStore(join(root, STATE_DIR, "secrets", "ci.json")),
        ciHooks: unstubbed<Services["ciHooks"]>("ciHooks", { warnings: () => new Map() }),
        // Loopback: no identities, so the caller is the owner.
        auth: undefined,
        sandboxSettings: unstubbed<Services["sandboxSettings"]>("sandboxSettings", {
            get: async () => SandboxSettingsSchema.parse({ modelRoles: { "pipeline-fix": pinned } }),
        }),
        // SAFETY: one entry per native provider, which is the whole of the record's keys.
        providerReadiness: async () =>
            Object.fromEntries(NATIVE_PROVIDERS.map((provider) => [provider, ready.includes(provider)])) as Awaited<ReturnType<Services["providerReadiness"]>>,
        // A pin's rung is asked whether it has been dying; none has.
        usage: unstubbed<Services["usage"]>("usage", { turns: async () => [] }),
        agents: unstubbed<Services["agents"]>("agents", { list: () => [], listArchived: () => [], clearArchived: async () => {} }),
        turnJournal: sqliteTurnJournal(openConversationsDb(conversationsDbPath(root))),
        transcripts: unstubbed<Services["transcripts"]>("transcripts", { read: async () => [], append: async () => {} }),
        pushSender: unstubbed<Services["pushSender"]>("pushSender", { notifyIfAway: async () => ({ delivered: 0, failed: 0 }) }),
        logger: unstubbed<Services["logger"]>("logger", { info: () => {}, warn: () => {}, error: () => {} }),
        // Real actors, which hold the run a Fix starts; what reacts to it is composition's to subscribe.
        conversations: memoryFleet().conversations,
        events: createDomainEvents(() => {}),
    });
    const started: AgentTurn[] = [];
    const wake: TurnStarter["stream"] = async function* (input) {
        started.push(input);
        yield { kind: "done" } as never;
    };
    const fetchFn: FetchFn = (async (url: string) =>
        String(url).includes("/logs")
            ? new Response("Error: P1001: Can't reach database server at `postgres:5432`")
            : new Response(JSON.stringify(JOBS))) as unknown as FetchFn;
    return { routes: createCiRoutes(drivenBy(services, wake), fetchFn), started, services };
};

// The complaint this exists for: the turn carried `unattended`, so its own briefing told it nobody had started it, and
// it reported the failure half-diagnosed rather than asking, planning or reaching an account.
test("a pressed Fix starts an ordinary session: a run role, and nothing marking it unwatched", async () => {
    const { routes, started } = await harness();
    const outcome = await call(routes.fix, { repo: "web", runId: RUN_ID }, { context });
    expect(outcome.conversationId).toContain("web");
    await waitFor(() => expect(started).toHaveLength(1), SETTLES);
    const turn = started[0]!;
    expect(turn).toMatchObject({ isolated: true, runRole: "pipeline-fix" });
    expect(turn.unattended).toBeUndefined();
});

// C4: the Fix button names the model a new chat would open on, and the press sends it; the sandbox used to open an
// unpinned fix on Claude, which a Z.ai-only owner never connected.
test("a plain Fix with nothing pinned opens on the chat default the pressing browser sent", async () => {
    const { routes, started } = await harness({ ready: ["claude", "zai"] });
    await call(routes.fix, { repo: "web", runId: RUN_ID, fallback: { agent: "zai", model: "glm-4.6" } }, { context });
    await waitFor(() => expect(started).toHaveLength(1), SETTLES);
    expect(started[0]).toMatchObject({ agent: "zai", model: "glm-4.6", runRole: "pipeline-fix" });
});

test("a model pinned for fixing pipelines wins over the chat default the browser sent", async () => {
    const { routes, started } = await harness({ ready: ["claude", "zai"], pinned: [{ provider: "claude", model: "claude-sonnet-4-6" }] });
    await call(routes.fix, { repo: "web", runId: RUN_ID, fallback: { agent: "zai", model: "glm-4.6" } }, { context });
    await waitFor(() => expect(started).toHaveLength(1), SETTLES);
    expect(started[0]).toMatchObject({ agent: "claude", model: "claude-sonnet-4-6" });
});

// A chat default on a provider this sandbox cannot serve is no better than Claude was: the sandbox's own fallback runs.
test("a chat default this sandbox cannot serve gives way to a provider it can", async () => {
    const { routes, started } = await harness({ ready: ["zai"] });
    await call(routes.fix, { repo: "web", runId: RUN_ID, fallback: { agent: "codex", model: "gpt-5" } }, { context });
    await waitFor(() => expect(started).toHaveLength(1), SETTLES);
    expect(started[0]?.agent).toBe("zai");
    expect(started[0]?.model).toBeUndefined();
});

// `gh` is not in the sandbox image, so a prompt naming it sends the fix agent at a wall and it gives up on verifying.
test("the prompt points at the host's API for a job this sandbox cannot run, never at a CLI it lacks", async () => {
    const { routes, started } = await harness();
    await call(routes.fix, { repo: "web", runId: RUN_ID }, { context });
    await waitFor(() => expect(started).toHaveLength(1), SETTLES);
    const prompt = started[0]!.prompt;
    expect(prompt).toContain("github REST API");
    expect(prompt).toContain("`github` skill");
    expect(prompt).not.toContain("gh workflow run");
    expect(prompt).not.toContain("gh run watch");
    // The evidence still rides with it, which is what makes the log tail worth fetching more of.
    expect(prompt).toContain("P1001");
});

// A failing main has one fix agent: a press on any of its runs continues that one, with its turns back, rather than
// opening a second conversation on the same failure.
test("a pressed Fix on a run of a failing main continues the streak's one fix agent, with its turns back", async () => {
    const { routes, started, services } = await harness();
    await services.ciStore.failure("web", "main", () => SPENT);

    const outcome = await call(routes.fix, { repo: "web", runId: RUN_ID }, { context });

    expect(outcome.conversationId).toBe("ci-fix-web-40");
    await waitFor(() => expect(started.map(({ conversationId }) => conversationId)).toEqual(["ci-fix-web-40"]), SETTLES);
    const failure = (await services.ciStore.failures())["web\nmain"];
    expect(failure?.turns).toBe(0);
    expect(failure?.decisions.at(-1)).toMatchObject({ kind: "fix-up", conversationId: "ci-fix-web-40" });
});

// The Pipelines rail reads each failing main-line branch off the runs list, under the name the contract gives it.
test("the runs list answers each failing main-line branch as a failure, with its fix agent and its latest decision", async () => {
    const { routes, services } = await harness();
    await services.ciStore.failure("web", "main", () => SPENT);

    const answer = await call(routes.runs, undefined, { context });

    expect(answer.runs.map(({ runId }) => runId)).toEqual([RUN_ID]);
    expect(answer.failures).toEqual([
        {
            repo: "web",
            branch: "main",
            since: 1,
            runId: RUN_ID,
            jobs: ["onboarding"],
            fixer: "ci-fix-web-40",
            decision: {
                kind: "spent",
                reason: "turns",
                conversationId: "ci-fix-web-40",
                at: 2,
                detail: "Its fix agent had its 3 turns and main still fails.",
            },
        },
    ]);
    expect(Object.keys(answer)).toEqual(["repos", "runs", "failures"]);
});
