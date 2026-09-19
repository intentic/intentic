import type { LandConflict } from "@intentic/sandbox-contract";
import { afterEach, expect, it, vi } from "vitest";

// The chat tabs agentActions sends through, swappable per test; hoisted because the module factory below is.
const chat = vi.hoisted(() => ({
    conversations: {
        value: [] as {
            conversationId: string;
            isolated: { value: boolean };
            enqueue: (prompt: string) => void;
            // Only the errand path calls it, so the tabs the other tests build leave it off.
            wearModel?: (pin: unknown) => void;
        }[],
    },
    // Every prompt that reached a conversation: the assertion for "a turn was actually spent".
    enqueued: [] as string[],
}));
// A registered tab: `isolated: false` keeps the fleet's draft join from carding it, so the empty roster here leaves
// askAgentToResolve nothing to open. `unsent` is read of every tab regardless of the latch.
const tab = (id: string) => ({
    conversationId: id,
    isolated: { value: false },
    registered: { value: true },
    unsent: { value: false },
    enqueue: (prompt: string) => chat.enqueued.push(prompt),
});

// sandboxClient stays real: the bug under test lived in the gap between agentActions and the actual request. Everything
// else mocked here is what agentActions's other actions need for a browser (device, router, sandbox).
vi.mock("@intentic/ui", () => ({ useDevice: () => ({ mobile: { value: false } }) }));
vi.mock("../../chat/run/useChat", () => ({
    // `active` and `releaseDone` are both reached by module-scope watchers in useAgents the moment that module loads.
    useChat: () => ({
        conversations: chat.conversations,
        active: { value: { conversationId: undefined } },
        releaseDone: () => {},
    }),
}));
// The strip the fleet reads at module load; empty so no draft card competes with the registry rows under test.
vi.mock("../../chat/panel/useChat-strip", () => ({ chatStrip: { value: { active: undefined, panes: [], tabs: [] } } }));
// The draft startAgent pins and summons, one per test so its pins can be read back.
const draft = vi.hoisted(() => ({
    value: { conversationId: `c1`, actsAs: { value: undefined as string | undefined }, startIn: { value: undefined as string | undefined } },
}));
vi.mock("../../chat/panel/useChat-reveal", () => ({
    // `actsAs` is on the stub since startAgent pins the draft before summoning it, including to `undefined` when
    // pressing Anyone un-pins a persona.
    draftConversation: () => ({ ...draft.value, enqueue: (prompt: string) => chat.enqueued.push(prompt) }),
    agentTabOf: () => ({}),
}));
// The summons channel is the seam startAgent shows the new tab through; this suite has no second window to receive it,
// so a summoned turn runs here, as summonTurn does in any window drawing the chat.
vi.mock("../../chat/run/summon", () => ({
    summonChat: () => {},
    summonTurn: (conversation: { enqueue: (prompt: string) => void }, prompt: string) => conversation.enqueue(prompt),
}));
vi.mock("../../../lib/queryPersistence", () => ({ queryClient: { invalidateQueries: async () => undefined } }));
vi.mock("../../../router", () => ({ router: { push: vi.fn() } }));
vi.mock("../../sandbox/client/useSandbox", () => ({
    useSandbox: () => ({
        active: { value: { token: `connect` } },
        activeSandboxId: { value: `s1` },
        daemonUrl: { value: `https://daemon.test` },
    }),
    sandboxKey: (...parts: unknown[]) => parts,
}));
vi.mock("../../sandbox/session/sandboxSession", () => ({
    useSandboxSession: () => ({ getSessionToken: async () => ({ token: `session-token`, kind: `session` }) }),
}));

const { askAgentToResolve, landAgent, startAgent } = await import("./agentActions");
const { setProjectScope } = await import("../../../app/projectScope");
// The board's own roster, which the errand reads the agent's settings off; written per test, cleared with the tabs.
const { registry } = await import("./useAgents-registry");

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
    registry.value = [];
    draft.value = { conversationId: `c1`, actsAs: { value: undefined }, startIn: { value: undefined } };
    setProjectScope(undefined);
    vi.unstubAllGlobals();
});

// Pinned because a missing content-type is invisible from this side and fatal on the daemon's: a string body is
// labelled text/plain, and its oRPC handler drops the `{id}` it took from the path.
it("sends the land body as JSON, so the daemon parses an object and keeps the agent id from the path", async () => {
    stubFetch();
    await expect(landAgent(`a1`)).resolves.toEqual({ landed: true });
    const [request] = sent;
    expect(request?.url).toBe(`https://daemon.test/agents/a1/land`);
    expect(request?.headers.get(`content-type`)).toBe(`application/json`);
    // Both the drag-drop and the panel's Land button take the defaults: check-only, the outstanding span, and `force:
    // false` respecting the turn guard.
    expect(await request?.json()).toEqual({ mode: `check`, span: `outstanding`, force: false });
});

// The force flag changes WHEN a land may run, not what it carries: the daemon refuses a land mid-write unless this says
// the user was warned. A land on a parked turn sends false like any other.
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

// Decided against the freshly-read report, not the card: the board arms "resolve" on `status: "conflict"` alone and
// can't know whether a rebase could reach it, so every caller must be told no.
it("refuses the ask when every blocked path is the user's own uncommitted work, a rebase cannot reach it", async () => {
    chat.conversations.value = [tab(`a1`)];
    stubConflicts([{ repo: `root`, clean: 4, paths: [{ path: `src/app.ts`, reason: `workspace` }] }]);
    const ask = await askAgentToResolve(`a1`);
    // The failure this prevents: a turn spent on a prompt whose "What blocked the land:" section is empty, ending in an
    // identical refusal.
    expect(chat.enqueued).toEqual([]);
    expect(ask).toEqual({ sent: false, why: expect.stringContaining(`Commit or stash them`) });
});

// The repo-unavailable refusal reads as a conflict on the card and names nothing a rebase could act on, so it's the
// same refusal wearing different copy. Distinct from a report that came back EMPTY, below: that one has no premise left
// at all, this one has a premise the agent simply cannot act on.
it("refuses the ask when the report names no blocked path at all, and names the repo it couldn't reach", async () => {
    chat.conversations.value = [tab(`a1`)];
    stubConflicts([{ repo: `docs`, clean: 0, paths: [] }]);
    expect(await askAgentToResolve(`a1`)).toEqual({ sent: false, why: expect.stringContaining(`couldn't reach your workspace's copy of docs`) });
    expect(chat.enqueued).toEqual([]);
    // Nothing is re-judged: the refusal still stands, so retiring it would clear a card that is genuinely stuck.
    expect(sent.filter((request) => request.method === `POST`)).toEqual([]);
});

// THE DEAD END THIS PRESS USED TO BE. The stored refusal is what holds the card in Attention and only a land retires it
// (agents-registry.recordLanded), so a refusal whose cause the user has since cleared left the board stuck on a clash
// that no longer existed — and the card's only press answered "nothing left to rebase, go read the report", pointing at
// a report with nothing in it. It re-judges instead, through the one land mode that writes to no tree.
it("re-judges instead of scolding when the refusal it was pressed about has evaporated", async () => {
    chat.conversations.value = [tab(`a1`)];
    stubFetch({ repos: [] });
    const ask = await askAgentToResolve(`a1`);
    // Reported as an outcome, not a refusal: the board floats this rather than raising its failure strip.
    expect(ask).toEqual({ sent: false, settled: true, why: expect.stringContaining(`ready to land`) });
    // No turn spent on a rebase with nothing to rebase...
    expect(chat.enqueued).toEqual([]);
    // ...and the re-judge is a `measure`, the mode that judges a stored refusal without touching the main tree.
    const land = sent.find((request) => request.url === `https://daemon.test/agents/a1/land`);
    expect(await land?.json()).toEqual({ mode: `measure`, span: `outstanding`, force: false });
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
    // One turn carrying the agent's half as work and the user's half as hands-off, the split resolvePrompt exists to
    // draw.
    expect(chat.enqueued).toHaveLength(1);
    expect(chat.enqueued[0]).toContain(`src/app.ts`);
    expect(chat.enqueued[0]).toContain(`logo.png`);
    expect(chat.enqueued[0]).toContain(`Leave these alone`);
});

// The app composed this turn, so it is not a pick: it must run on what this agent's own turns ran on. A tab minted from
// a history row, or one in a second window, carries the last pick made THERE — and a turn sent on that both spends
// against a model the user never chose for this agent and relabels the card with it, since the registry describes a
// conversation by the model its last turn used.
it("runs the errand on the agent's own model, not on the pick this window's tab happens to hold", async () => {
    const worn: unknown[] = [];
    chat.conversations.value = [{ ...tab(`a1`), wearModel: (pin: unknown) => worn.push(pin) }];
    registry.value = [
        {
            id: `a1`,
            status: `conflict`,
            provider: `claude`,
            harness: `native`,
            model: `claude-opus-5`,
            effort: `xhigh`,
            thinking: true,
            updatedAt: 0,
            attention: { plan: false, question: false, permission: false, capability: false, credential: false, conflict: true },
        },
    ];
    stubConflicts([{ repo: `root`, clean: 0, paths: [{ path: `src/app.ts`, reason: `diverged` }] }]);

    expect(await askAgentToResolve(`a1`)).toEqual({ sent: true });

    expect(worn).toEqual([{ provider: `claude`, model: `claude-opus-5`, harness: `native`, effort: `xhigh`, thinking: true }]);
});

// "New agent" and a composed-task press are one action: a caller must not assemble the three steps itself, or an opened
// tab whose prompt never went reads as a press that did nothing.
it("starts a fresh agent already running the task it was handed", () => {
    startAgent(`Refactor src/app.ts.`);
    expect(chat.enqueued).toEqual([`Refactor src/app.ts.`]);
});

it("still starts an empty one when there is nothing to say", () => {
    startAgent();
    expect(chat.enqueued).toEqual([]);
});

// Under a project, a press naming no persona wears the project's own card (projectPersona.ts), made on the spot when
// the list lacks it; the prompt goes only once the card exists, or the daemon would answer an unknown persona with an
// ordinary chat.
it("starts an agent under the open project wearing the project's own persona, made first if missing", async () => {
    setProjectScope(`web`);
    stubFetch({ personas: [], connected: [] });
    startAgent(`Fix the footer.`);
    expect(draft.value.actsAs.value).toBe(`project-web`);
    expect(draft.value.startIn.value).toBe(`web`);
    await vi.waitFor(() => expect(chat.enqueued).toEqual([`Fix the footer.`]));
    const posted = sent.find((request) => request.method === `POST` && request.url === `https://daemon.test/personas`);
    expect(await posted?.json()).toMatchObject({ id: `project-web`, workspace: { startIn: `web`, folders: [`web`] }, context: { repos: [`web`] } });
});

it("keeps the persona a press named over the project's own", () => {
    setProjectScope(`web`);
    stubFetch();
    startAgent(undefined, `maya-support`);
    expect(draft.value.actsAs.value).toBe(`maya-support`);
    expect(draft.value.startIn.value).toBe(`web`);
    expect(sent).toEqual([]);
});

// A card whose conversation is gone has nothing to send to; inventing one would start a turn on the wrong agent.
it("refuses the ask when the agent has no conversation left", async () => {
    stubConflicts([{ repo: `root`, clean: 0, paths: [{ path: `src/app.ts`, reason: `diverged` }] }]);
    expect(await askAgentToResolve(`a1`)).toEqual({ sent: false, why: expect.stringContaining(`no conversation`) });
    // Refused before the report is even read: there is no one to tell.
    expect(sent).toEqual([]);
});

// A re-land after a discard must be a different request from any other land, or it's the same one twice. The default
// span is measured from the last landed tip, which sees nothing once discarded; only the cumulative span reads from the
// branch's base.
it("asks for the cumulative span by name, so a re-land carries work the default span can no longer see", async () => {
    stubFetch();
    await landAgent(`a1`, `check`, `cumulative`);
    expect(await sent[0]?.json()).toEqual({ mode: `check`, span: `cumulative`, force: false });
});
