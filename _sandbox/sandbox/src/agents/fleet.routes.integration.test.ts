import { deriveTitle } from "@intentic/sandbox-contract";
import type { Hono } from "hono";
import { expect, test } from "vitest";
import { createApp } from "../app.js";
import type { AppEnv } from "../context.js";
import { clientFor, runAgentTurn, services } from "../route-testing.js";
import { testConfig } from "../testing.js";
import { recordPathOf, type FleetMessage, type FleetRecall, type FleetRow } from "./fleet-recall.js";

/* THE FLEET READ ROUTES, driven the way the `agents ls|show|find` verbs drive them: over HTTP, with the
 * per-boot agent token, against conversations built by real turns rather than by hand.
 *
 * What these pin is the whole bargain the surface was admitted on (auth/grants.ts): the agent token reaches
 * exactly two GETs that can only READ, a handle in any spelling resolves in one call, an ambiguous one is
 * named rather than picked, and nothing here reaches the board's presses. */

// The routes answer no contract schema (they serve a CLI parsing JSON, not a typed client), so the shapes
// come from the module that builds them: a field renamed there fails this file rather than passing it.
interface FleetAnswer {
    readonly agents?: readonly FleetRow[];
    readonly indexing?: boolean;
    readonly agent?: FleetRecall;
    readonly transcript?: { readonly total: number; readonly messages: readonly FleetMessage[] };
    readonly ok?: boolean;
    readonly message?: string;
    readonly candidates?: readonly { readonly id: string }[];
}

// Auth ENABLED — the grants middleware only exists on the exposed daemon, and the grant is half of what is
// being tested. Two conversations, one SDK session each, told apart by the prompt.
const fleetApp = (): Hono<AppEnv> =>
    createApp(
        services({
            auth: { authorize: async () => ({ email: "owner@example.com", role: "owner" as const }) },
            // A settling turn files the point its message can be rewound to, and the harness leaves that
            // store unstubbed on purpose. Inert here: nothing in this file reads an anchor back.
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

// The two halves of a 200, unwrapped where they are missing rather than asserted around: a route that
// answered the wrong shape should name itself here, not fail six lines later on an undefined property.
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
    // The title is the derived opening prompt — the one thing that lets a caller recognise a conversation.
    // Through the daemon's own deriveTitle, so this stays true if the derivation is ever retuned.
    expect(agents.map((agent) => agent.title)).toEqual([deriveTitle(PUBLISH_PROMPT), deriveTitle(PIPELINE_PROMPT)]);
    // A limit is a page, not a filter: newest kept.
    expect((await rosterOf(app, "/fleet?limit=1")).map((agent) => agent.id)).toEqual(["clear-marsh-8c46"]);
});

/* ONE CALL, EVERY SPELLING. This is the failure the surface exists to end: a conversation known only by its
 * worktree directory name, or by the branch a `git branch -a` printed, or by a session id out of a provider's
 * own store, with no way to turn any of them into the others. The BRANCH case also pins something subtler —
 * `agent/…` percent-encodes to one path segment, which is what keeps it inside the grant's one-segment glob
 * (auth/grants.ts) while still reaching the handler as a slash. */
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
        // Off the daemon's own history root, not a literal: this file's sandbox runs on a temp one.
        record: recordPathOf(testConfig.historyRoot, "fair-sage-ey2r"),
        sessionId: "sess-pipeline",
        costUsd: 0.25,
        inputTokens: 4000,
        outputTokens: 120,
    });
    /* The digest is what makes this cheaper than reading the record: the task, where it got to, and how it
     * ended, whitespace collapsed. Everything else is behind ?transcript=1 and the CLI names that command.
     * The prompt in the record carries a run of spaces; what comes back is one, which is the collapsing. */
    expect(agent.digest).toMatchObject({
        messages: 3,
        asked: ["fix the last-commit pipeline autoopen"],
        lastSaid: "ciStreaks.ts was picking the wrong run",
        lastNotice: "Claude usage limit reached.",
    });
    // The composition rides along with the landed fact, which costs nothing: it is the registry's own record.
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
    // A hit in the agent's own words carries the snippet and says whose words they are.
    expect(await rosterOf(app, "/fleet?q=ciStreaks")).toMatchObject([
        { id: "fair-sage-ey2r", snippet: { text: "ciStreaks.ts was picking the wrong run", speaker: "agent" } },
    ]);
    /* A TITLE hit carries none: the row already shows the title, and repeating it spends the space evidence
     * wanted — the /agents/search rule, kept here so the two surfaces cannot disagree. */
    const titled = await rosterOf(app, "/fleet?q=npm%20publish");
    expect(titled.map((agent) => agent.id)).toEqual(["clear-marsh-8c46"]);
    expect(titled[0]?.snippet).toBeUndefined();
    // Nothing said it: an empty list, not an error, so a caller can tell "no match" from "no surface".
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
    // And a handle nothing answers to is a 404 that names the verb which can find it.
    const missing = await fleet(app, "/fleet/nothing-like-this");
    expect(missing.status).toBe(404);
    expect(missing.body.message).toContain("agents find");
});

/* THE GRANT, on the wire rather than only in its table. The whole argument for letting the agent token near
 * the conversation record is that these two routes can only read; a POST arriving here must be refused by the
 * middleware before any handler sees it, and the board's own router must stay out of reach entirely. */
test("the agent token reaches the two reads and nothing that acts on a conversation", async () => {
    const app = fleetApp();
    await twoConversations(app);
    expect((await app.request("http://sandbox.test/fleet", { method: "POST", ...AGENT })).status).toBe(403);
    expect((await app.request("http://sandbox.test/fleet/fair-sage-ey2r", { method: "DELETE", ...AGENT })).status).toBe(403);
    expect((await app.request("http://sandbox.test/agents", AGENT)).status).toBe(403);
    expect((await app.request("http://sandbox.test/agents/fair-sage-ey2r/land", { method: "POST", ...AGENT })).status).toBe(403);
    // A wrong token on an in-scope route is 401, never a fall-through to whatever authorizes behind it.
    expect((await app.request("http://sandbox.test/fleet", { headers: { "x-intentic-agent": "intruder" } })).status).toBe(401);
});
