import { mkdtempSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { STATE_DIR } from "@intentic/constants";
import { defaultGit } from "@intentic/scaffold";
import { type AgentTurn, SandboxSettingsSchema } from "@intentic/sandbox-contract";
import { unstubbed } from "@intentic/testing";
import { call } from "@orpc/server";
import { test, expect } from "bun:test";
import { SETTLES, waitFor } from "@intentic/testing/bun";
import { sqliteTurnJournal } from "../agent/run/turn/turn-journal.js";
import { conversationsDbPath, openConversationsDb } from "../store/conversations-db.js";
import { fileCapabilitiesStore } from "../capabilities/capabilities-store.js";
import type { OrpcContext } from "../app-env.js";
import type { Services } from "../composition.js";
import { createCiRoutes } from "./ci.routes.js";
import type { FetchFn } from "./providers.js";
import { createRunsCache } from "./runs-cache.js";
import type { TurnStarter } from "../seams/turn-starter.js";
import { createDomainEvents } from "../seams/domain-events.js";
import { drivenBy, memoryFleet } from "../testing.js";

/* What Fix on a red pipeline actually starts: a session nobody has limited, carrying a prepared prompt. */

const context: OrpcContext = { headers: new Headers(), method: "POST", url: "/ci/fix" };

const RUN_ID = 41;

// One failed job with a failed step of its own, so the run reads as this repository's code failing rather than a
// runner dying in its own setup (which `fix` refuses before starting anybody).
const JOBS = { jobs: [{ id: 7, name: "onboarding", conclusion: "failure", steps: [{ name: "Run onboarding tier", conclusion: "failure" }] }] };

const harness = async () => {
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
        sandboxSettings: unstubbed<Services["sandboxSettings"]>("sandboxSettings", { get: async () => SandboxSettingsSchema.parse({}) }),
        agents: unstubbed<Services["agents"]>("agents", { list: () => [], listArchived: () => [] }),
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
    return { routes: createCiRoutes(drivenBy(services, wake), fetchFn), started };
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
