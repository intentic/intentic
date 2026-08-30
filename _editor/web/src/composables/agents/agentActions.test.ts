import type { LandConflict } from "@intentic/sandbox-contract";
import { afterEach, expect, it, vi } from "vitest";

// The chat tabs agentActions sends through, swappable per test. Hoisted because the module factory below is.
const chat = vi.hoisted(() => ({
    conversations: { value: [] as { conversationId: string; isolated: { value: boolean }; enqueue: (prompt: string) => void }[] },
    // Every prompt that reached a conversation: the assertion for "a turn was actually spent".
    enqueued: [] as string[],
}));
// A registered tab: `isolated: false` keeps the fleet's draft join from carding it (see useAgents.fleet), which
// is what this suite wants: the roster is empty here, so askAgentToResolve finds no agent to open and goes
// straight to the part under test. `unsent` is read of EVERY tab whatever the latch says, so it is part of
// looking like a conversation at all rather than part of the draft half.
const tab = (id: string) => ({
    conversationId: id,
    isolated: { value: false },
    registered: { value: true },
    unsent: { value: false },
    enqueue: (prompt: string) => chat.enqueued.push(prompt),
});

// sandboxClient is the one thing left REAL here: the bug under test lived in the gap between agentActions and
// the request that actually goes out, so a mock at that seam would assert the very thing that was wrong. What is
// mocked is only what agentActions imports for its OTHER actions (startAgent's tab/caret/route, the post-land
// cache invalidation) and whose module scope wants a browser: ui's useDevice reads window.matchMedia at import,
// the router builds a history, and useSandbox reaches environment.ts's window.env. The useSandbox stub serves
// both consumers: agentActions reads `sandboxKey`, and sandboxClient reads its base through the real
// useEndpoint, whose daemonBase falls through to `daemonUrl` when no loopback shortcut is resolved.
vi.mock("@intentic/ui", () => ({ useDevice: () => ({ mobile: { value: false } }) }));
vi.mock("../chat/useChat", () => ({
    // `active` is read by a module-scope watcher in useAgents (the "seen while you watch it" rule), which
    // evaluates the moment that module loads.
    useChat: () => ({
        conversations: chat.conversations,
        active: { value: { conversationId: undefined } },
    }),
    // `actsAs` is on the stub because startAgent PINS the draft before summoning it: including to `undefined`,
    // which is how pressing Anyone un-pins a draft that was aimed at a persona a moment ago.
    draftConversation: () => ({ conversationId: `c1`, actsAs: { value: undefined }, enqueue: (prompt: string) => chat.enqueued.push(prompt) }),
    agentTabOf: () => ({}),
}));
// The summons channel is the seam startAgent shows the new tab through: a broadcast this suite has no second
// window to receive; what it asserts is the prompt spend, which stays local by design.
vi.mock("../chat/summon", () => ({ summonChat: () => {} }));
vi.mock("../queryPersistence", () => ({ queryClient: { invalidateQueries: async () => undefined } }));
vi.mock("../../router", () => ({ router: { push: vi.fn() } }));
vi.mock("../sandbox/useSandbox", () => ({
    useSandbox: () => ({
        active: { value: { token: `connect` } },
        activeSandboxId: { value: `s1` },
        daemonUrl: { value: `https://daemon.test` },
    }),
    sandboxKey: (...parts: unknown[]) => parts,
}));
vi.mock("../sandbox/sandboxSession", () => ({
    useSandboxSession: () => ({ getSessionToken: async () => ({ token: `session-token`, kind: `session` }) }),
}));

const { askAgentToResolve, landAgent, startAgent } = await import("./agentActions");

// Every request fetch was handed, as the Request the daemon would have received.
const sent: Request[] = [];
const stubFetch = (body: unknown = { landed: true }): void => {
    vi.stubGlobal(`fetch`, (url: string, init?: RequestInit) => {
        sent.push(new Request(url, init));
        return Promise.resolve(Response.json(body));
    });
};

// GET /agents/{id}/diff as the daemon would answer it for a refused land.
const stubConflicts = (conflicts: readonly LandConflict[]): void => stubFetch({ repos: [], conflicts });

afterEach(() => {
    sent.length = 0;
    chat.conversations.value = [];
    chat.enqueued.length = 0;
    vi.unstubAllGlobals();
});

/* THE LAND REQUEST'S CONTENT-TYPE, pinned because its absence was invisible from this side and fatal on the
 * other. `fetch` labels a bare string body `text/plain`; the daemon's oRPC handler then parses the body as a
 * STRING rather than an object, and its compact-input codec hands that string to the route schema as the whole
 * input: dropping the `{id}` it took from the path. So every land came back 400 "Input validation failed",
 * which took out the review panel's Land/Merge AND the only route an errored or conflicted card had to the
 * Finished lane. Asserted on the Request rather than on the init object, because sandboxRequest rebuilds the
 * headers on the way out and it is the wire that has to be right. */
it("sends the land body as JSON, so the daemon parses an object and keeps the agent id from the path", async () => {
    stubFetch();
    await expect(landAgent(`a1`)).resolves.toEqual({ landed: true });
    const [request] = sent;
    expect(request?.url).toBe(`https://daemon.test/agents/a1/land`);
    expect(request?.headers.get(`content-type`)).toBe(`application/json`);
    // The drag-to-Finished drop and the panel's Land button both take the defaults: check-only, so a refusal
    // leaves the workspace byte-identical, and the outstanding span, so a land carries only what has not
    // landed yet. The cumulative span is asked for by name and by one surface alone ("Land again").
    // `force: false` rides along on every ordinary land: it is the turn guard, and the default is to respect it.
    expect(await request?.json()).toEqual({ mode: `check`, span: `outstanding`, force: false });
});

/* THE MID-WRITE LAND, and the reason it is a flag rather than a mode: it changes WHEN a land may run, not what
 * it carries. The daemon refuses a land while the agent is writing unless this says the user was warned and
 * said yes anyway (agents.routes.ts landable), so it must reach the wire from the confirm dialog's press and
 * from nowhere else. A land on a PARKED turn needs none of this and sends false like any other. */
it("carries the force flag, so a warned user can land while the agent is still writing", async () => {
    stubFetch();
    await landAgent(`a1`, `check`, `outstanding`, true);
    expect(await sent[0]?.json()).toEqual({ mode: `check`, span: `outstanding`, force: true });
});

it("carries an explicit mode, so the conflict report's Merge is a different request and not the same one twice", async () => {
    stubFetch();
    await landAgent(`a1`, `merge`);
    expect(sent[0]?.headers.get(`content-type`)).toBe(`application/json`);
    expect(await sent[0]?.json()).toEqual({ mode: `merge`, span: `outstanding`, force: false });
});

/* WHO THE ASK IS FOR, decided against the report and not against the card. The board arms its "Have the agent
 * resolve it" button on `status: "conflict"` alone, the roster carries no blockers, so the surface offering
 * the ask is structurally unable to know whether a rebase could reach the conflict. Only this function, holding
 * the freshly-read report, can; every caller (the card's button, the drag-to-Finished drop, the review panel's
 * own button) therefore has to be able to be told no. */
it("refuses the ask when every blocked path is the user's own uncommitted work, a rebase cannot reach it", async () => {
    chat.conversations.value = [tab(`a1`)];
    stubConflicts([{ repo: `root`, clean: 4, paths: [{ path: `src/app.ts`, reason: `workspace` }] }]);
    const ask = await askAgentToResolve(`a1`);
    // The failure this prevents: a turn spent on a prompt whose "What blocked the land:" section is empty,
    // ending in a land that refuses identically: the agent cannot see the user's checkout, let alone stage it.
    expect(chat.enqueued).toEqual([]);
    expect(ask).toEqual({ sent: false, why: expect.stringContaining(`Commit or stash them`) });
});

// The repo-unavailable refusal (empty `paths`, `clean: 0`) reads as a conflict on the card and names nothing a
// rebase could act on, so it is the same refusal wearing different copy: never a silently successful send.
it("refuses the ask when the report names no blocked path at all", async () => {
    chat.conversations.value = [tab(`a1`)];
    stubConflicts([{ repo: `root`, clean: 0, paths: [] }]);
    expect(await askAgentToResolve(`a1`)).toEqual({ sent: false, why: expect.stringContaining(`Nothing left for the agent to rebase`) });
    expect(chat.enqueued).toEqual([]);
});

it("sends the composed prompt when the agent's own rebase could reach it, and fences off the user's half", async () => {
    chat.conversations.value = [tab(`a1`)];
    stubConflicts([
        {
            repo: `root`,
            clean: 2,
            paths: [
                { path: `src/app.ts`, reason: `diverged` },
                { path: `logo.png`, reason: `binary` },
            ],
        },
        { repo: `docs`, clean: 0, paths: [{ path: `README.md`, reason: `workspace` }] },
    ]);
    expect(await askAgentToResolve(`a1`)).toEqual({ sent: true });
    // One turn, carrying the agent's half as work and the user's half as hands-off: the split resolvePrompt
    // exists to draw, asserted here because this is the call that decides a turn is worth spending at all.
    expect(chat.enqueued).toHaveLength(1);
    expect(chat.enqueued[0]).toContain(`src/app.ts`);
    expect(chat.enqueued[0]).toContain(`logo.png`);
    expect(chat.enqueued[0]).toContain(`Leave these alone`);
});

/* "NEW AGENT" AND "NEW AGENT, ON THIS" ARE ONE ACTION. A surface holding a composed task (the codebase-health
 * panel's per-row refactor) must not assemble the three steps itself: an opened tab whose prompt never went
 * reads as a press that did nothing, and a prompt sent to a conversation nobody focused reads as an agent that
 * started on its own. The prompt goes as an ordinary message, so the transcript shows what was asked. */
it("starts a fresh agent already running the task it was handed", () => {
    startAgent(`Refactor src/app.ts.`);
    expect(chat.enqueued).toEqual([`Refactor src/app.ts.`]);
});

it("still starts an empty one when there is nothing to say", () => {
    startAgent();
    expect(chat.enqueued).toEqual([]);
});

// A card whose conversation is gone (discarded, purged) has nothing to send to, and inventing one would start a
// turn on the wrong agent. It reports rather than resolving quietly, like every other refusal here.
it("refuses the ask when the agent has no conversation left", async () => {
    stubConflicts([{ repo: `root`, clean: 0, paths: [{ path: `src/app.ts`, reason: `diverged` }] }]);
    expect(await askAgentToResolve(`a1`)).toEqual({ sent: false, why: expect.stringContaining(`no conversation`) });
    // Refused before the report is even read: there is no one to tell.
    expect(sent).toEqual([]);
});

/* THE WAY BACK AFTER A DISCARD, and it has to be a different request from every other land: otherwise it is
 * the same one twice and does nothing. Landing is measured from the last landed tip, so once the user discards
 * a land's work from the workspace the default span is EMPTY: every sha still says the work went in, because
 * it did. Only a reading from the branch's base can still see that it is gone. */
it("asks for the cumulative span by name, so a re-land carries work the default span can no longer see", async () => {
    stubFetch();
    await landAgent(`a1`, `check`, `cumulative`);
    expect(await sent[0]?.json()).toEqual({ mode: `check`, span: `cumulative`, force: false });
});
