import { deriveTitle } from "@intentic/sandbox-contract";
import type { Hono } from "hono";
import { expect, test } from "vitest";
import { createApp } from "../../app.js";
import type { AppEnv } from "../../app-env.js";
import { clientFor } from "../../harness/route-client.testing.js";
import { services } from "../../harness/route-services.testing.js";
import { runAgentTurn } from "../../harness/route-turns.testing.js";
import { testConfig } from "../../testing.js";
import { recordPathOf, type FleetMessage, type FleetRecall, type FleetRow } from "./fleet-recall.js";

// Pins the fleet read routes over HTTP with the agent token: exactly two GETs, read-only, any handle spelling resolves
// in one call, ambiguous ones are named not picked.

// Shapes mirror what the routes actually return; there is no shared schema, so a field renamed there fails here first.
interface FleetAnswer {
    readonly agents?: readonly FleetRow[];
    readonly indexing?: boolean;
    readonly agent?: FleetRecall;
    readonly transcript?: { readonly total: number; readonly messages: readonly FleetMessage[] };
    readonly ok?: boolean;
    readonly message?: string;
    readonly candidates?: readonly { readonly id: string }[];
}

// Auth enabled: the grants middleware only exists on the exposed daemon and is half of what this tests. Two
// conversations, one SDK session each, told apart by the prompt.
const fleetApp = (): Hono<AppEnv> =>
    createApp(
        services({
            auth: { authorize: async () => ({ email: "owner@example.com", role: "owner" as const }) },
            // Left unstubbed on purpose; inert here, since nothing in this file reads an anchor back.
            turnAnchors: { record: async () => {}, of: async () => undefined, all: async () => new Map(), truncate: async () => {} },
            async *agent(request) {
                yield { kind: "session", sessionId: request.prompt.includes("pipeline") ? "sess-pipeline" : "sess-publish" };
                yield { kind: "usage", costUsd: 0.25, inputTokens: 4000, outputTokens: 120 };
                yield { kind: "done" };
            },
            sessions: {
                list: async () => [],
                read: async (_dir, id) =>
                    id === "sess-pipeline"
                        ? [
                              { role: "user" as const, text: "fix the   last-commit pipeline autoopen" },
                              { role: "assistant" as const, text: "ciStreaks.ts was picking the wrong run" },
                              { role: "notice" as const, text: "Claude usage limit reached." },
                          ]
                        : [{ role: "user" as const, text: "check the npm publish workflow" }],
                readTail: async () => [],
                search: async () => [],
                exists: async () => true,
            },
        }),
    );

const AGENT = { headers: { "x-intentic-agent": "agent-secret" } };

const fleet = async (app: Hono<AppEnv>, path: string): Promise<{ status: number; body: FleetAnswer }> => {
    const response = await app.request(`http://sandbox.test${path}`, AGENT);
    return { status: response.status, body: (await response.json()) as FleetAnswer };
};

// Unwraps where the field is missing rather than asserting around it, so a wrong-shaped response names itself here, not
// six lines later.
const rosterOf = async (app: Hono<AppEnv>, path: string): Promise<readonly FleetRow[]> => {
    const { status, body } = await fleet(app, path);
    expect(status, path).toBe(200);
    if (body.agents === undefined) {
        throw new Error(`no roster in ${path}: ${JSON.stringify(body)}`);
    }
    return body.agents;
};

const recallOf = async (app: Hono<AppEnv>, path: string): Promise<FleetRecall> => {
    const { status, body } = await fleet(app, path);
    expect(status, path).toBe(200);
    if (body.agent === undefined) {
        throw new Error(`no conversation in ${path}: ${JSON.stringify(body)}`);
    }
    return body.agent;
};

const PIPELINE_PROMPT = "fix the last-commit pipeline autoopen";
const PUBLISH_PROMPT = "check the npm publish workflow";

const twoConversations = async (app: Hono<AppEnv>): Promise<void> => {
    const client = clientFor(app);
    await runAgentTurn(client, { prompt: PIPELINE_PROMPT, conversationId: "fair-sage-ey2r", isolated: true });
    await runAgentTurn(client, { prompt: PUBLISH_PROMPT, conversationId: "clear-marsh-8c46", isolated: true });
};

test("the roster answers every conversation, newest first, with what a caller needs to choose one", async () => {
    const app = fleetApp();
    await twoConversations(app);
    const agents = await rosterOf(app, "/fleet");
    expect(agents).toMatchObject([
        { id: "clear-marsh-8c46", status: "idle", provider: "claude", branch: "agent/clear-marsh-8c46", running: false, archived: false },
        { id: "fair-sage-ey2r", status: "idle", provider: "claude", branch: "agent/fair-sage-ey2r" },
    ]);
    // Title is the derived opening prompt, via the daemon's own `deriveTitle`.
    expect(agents.map((agent) => agent.title)).toEqual([deriveTitle(PUBLISH_PROMPT), deriveTitle(PIPELINE_PROMPT)]);
    // Limit pages the newest entries; it is not a filter.
    expect((await rosterOf(app, "/fleet?limit=1")).map((agent) => agent.id)).toEqual(["clear-marsh-8c46"]);
});

// The branch case percent-encodes `agent/...` to one path segment, staying inside the grant's one-segment glob while
// still reaching the handler as a slash.
test("a conversation resolves from its id, its branch, an id prefix or its session id", async () => {
    const app = fleetApp();
    await twoConversations(app);
    for (const handle of ["fair-sage-ey2r", encodeURIComponent("agent/fair-sage-ey2r"), "fair-sage", "sess-pipeline"]) {
        expect((await recallOf(app, `/fleet/${handle}?diff=0`)).id, handle).toBe("fair-sage-ey2r");
    }
});

test("one conversation answers whole: its settings, its branch, its record and what it said", async () => {
    const app = fleetApp();
    await twoConversations(app);
    const agent = await recallOf(app, "/fleet/fair-sage-ey2r?diff=0");
    expect(agent).toMatchObject({
        id: "fair-sage-ey2r",
        title: deriveTitle(PIPELINE_PROMPT),
        status: "idle",
        branch: "agent/fair-sage-ey2r",
        worktree: "/history/worktrees/fair-sage-ey2r",
        // Built from `testConfig.historyRoot`, since this suite's sandbox uses a temporary one, not a literal path.
        record: recordPathOf(testConfig.historyRoot, "fair-sage-ey2r"),
        sessionId: "sess-pipeline",
        costUsd: 0.25,
        inputTokens: 4000,
        outputTokens: 120,
    });
    // Fixture prompt carries a run of spaces; the digest collapses it to one.
    expect(agent.digest).toMatchObject({
        messages: 3,
        asked: ["fix the last-commit pipeline autoopen"],
        lastSaid: "ciStreaks.ts was picking the wrong run",
        lastNotice: "Claude usage limit reached.",
    });
    // `repoStates`'s landed fact is free: it is the registry's own record, not a git read.
    expect(agent.repoStates).toEqual([{ repo: "root", base: "a".repeat(40), landed: false }]);
});

test("the record itself is one flag away, bounded by last and narrowed by grep", async () => {
    const app = fleetApp();
    await twoConversations(app);
    const whole = await fleet(app, "/fleet/fair-sage-ey2r?diff=0&transcript=1");
    expect(whole.body.transcript?.total).toBe(3);
    expect(whole.body.transcript?.messages.map((message) => message.role)).toEqual(["user", "assistant", "notice"]);
    const tail = await fleet(app, "/fleet/fair-sage-ey2r?diff=0&transcript=1&last=1");
    expect(tail.body.transcript?.messages.map((message) => message.text)).toEqual(["Claude usage limit reached."]);
    const grepped = await fleet(app, "/fleet/fair-sage-ey2r?diff=0&transcript=1&grep=ciStreaks");
    expect(grepped.body.transcript?.total).toBe(1);
    expect(grepped.body.transcript?.messages[0]).toMatchObject({ role: "assistant", at: 1 });
});

test("a search answers which conversations said a phrase, with the line that proves it", async () => {
    const app = fleetApp();
    await twoConversations(app);
    // Snippet's `speaker` names who said the matched line.
    expect(await rosterOf(app, "/fleet?q=ciStreaks")).toMatchObject([
        { id: "fair-sage-ey2r", snippet: { text: "ciStreaks.ts was picking the wrong run", speaker: "agent" } },
    ]);
    // A title-only hit carries no snippet, mirroring the `/agents/search` rule; the title is already on the row.
    const titled = await rosterOf(app, "/fleet?q=npm%20publish");
    expect(titled.map((agent) => agent.id)).toEqual(["clear-marsh-8c46"]);
    expect(titled[0]?.snippet).toBeUndefined();
    // No match returns an empty list, not an error.
    expect(await rosterOf(app, "/fleet?q=nothing-said-this")).toEqual([]);
});

test("a handle several conversations answer to is refused with the candidates, never resolved to one of them", async () => {
    const app = fleetApp();
    const client = clientFor(app);
    await runAgentTurn(client, { prompt: "fix the pipeline autoopen", conversationId: "fair-sage-ey2r", isolated: true });
    await runAgentTurn(client, { prompt: "follow up on the autoopen", conversationId: "fair-sage-other", isolated: true });
    const { status, body } = await fleet(app, "/fleet/fair-sage");
    expect(status).toBe(409);
    expect(body.ok).toBe(false);
    expect(body.candidates?.map((candidate) => candidate.id)).toEqual(["fair-sage-other", "fair-sage-ey2r"]);
    // An unmatched handle is a 404 naming `agents find`.
    const missing = await fleet(app, "/fleet/nothing-like-this");
    expect(missing.status).toBe(404);
    expect(missing.body.message).toContain("agents find");
});

test("the agent token reaches the two reads and nothing that acts on a conversation", async () => {
    const app = fleetApp();
    await twoConversations(app);
    expect((await app.request("http://sandbox.test/fleet", { method: "POST", ...AGENT })).status).toBe(403);
    expect((await app.request("http://sandbox.test/fleet/fair-sage-ey2r", { method: "DELETE", ...AGENT })).status).toBe(403);
    expect((await app.request("http://sandbox.test/agents", AGENT)).status).toBe(403);
    expect((await app.request("http://sandbox.test/agents/fair-sage-ey2r/land", { method: "POST", ...AGENT })).status).toBe(403);
    // Wrong token on an in-scope route is 401, not a fall-through to whatever authorizes behind it.
    expect((await app.request("http://sandbox.test/fleet", { headers: { "x-intentic-agent": "intruder" } })).status).toBe(401);
});
