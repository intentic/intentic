import type { AgentSummary, LandConflict } from "@intentic/sandbox-contract";
import { waitFor, stubGlobal, unstubAllGlobals } from "@intentic/testing/bun";
import type { PickAction } from "../../chat/session/selectionReducer";

// A tab's selection as this suite reads it back: its picks, and the one write that sets them and records any model worn.
const pickable = <P extends Record<string, { value: string | undefined }>>(picks: P, worn: unknown[] = []) => ({
    ...picks,
    apply: (action: PickAction): void => {
        if (action.kind === `wearModel`) {
            worn.push(action.pin);
        }
        if (action.kind === `set`) {
            for (const [pick, value] of Object.entries(action.picks)) {
                picks[pick]!.value = value as string | undefined;
            }
        }
    },
});

// The chat tabs agentActions sends through, swappable per test.
const chat = {
    conversations: {
        value: [] as {
            conversationId: string;
            isolated: { value: boolean };
            turn: {
                say: (prompt: string) => void;
                startErrand: (opening: string, compose: (signal: AbortSignal) => Promise<string | undefined>) => Promise<boolean>;
            };
            // Only the errand path touches these, so the tabs the other tests build leave them off.
            selection?: { apply: (action: PickAction) => void; account: { value: string | undefined } };
        }[],
    },
    // Every prompt that reached a conversation: the assertion for "a turn was actually spent".
    enqueued: [] as string[],
    // Every errand turn a conversation opened, by its opening: the row the chat draws before the words exist.
    opened: [] as string[],
};
// A registered tab: `isolated: false` keeps the fleet's draft join from carding it, so the empty roster here leaves
// askAgentToResolve nothing to open. `unsent` is read of every tab regardless of the latch.
const tab = (id: string) => ({
    conversationId: id,
    isolated: { value: false },
    registered: { value: true },
    unsent: { value: false },
    turn: {
        say: (prompt: string) => chat.enqueued.push(prompt),
        // The chat's half of an errand as TurnClient.startErrand keeps it: the turn opens under its opening at once,
        // only a composed prompt is sent, and every send here is one the daemon takes.
        startErrand: async (opening: string, compose: (signal: AbortSignal) => Promise<string | undefined>): Promise<boolean> => {
            chat.opened.push(opening);
            const prompt = await compose(new AbortController().signal);
            if (prompt === undefined) {
                return false;
            }
            chat.enqueued.push(prompt);
            return true;
        },
    },
});

// When the tab being opened has its transcript on screen; held open by the one case about what happens meanwhile.
const painting = { until: undefined as Promise<void> | undefined };
jest.mock("../../chat/run/useChat-sessions", () => ({ transcriptShown: () => painting.until ?? Promise.resolve() }));

// The daemon clients stay real, the typed one included: the bug under test lived in the gap between agentActions and the
// actual request. Everything else mocked here is what agentActions's other actions need for a browser (device, router,
// sandbox).
jest.mock("@intentic/ui", () => ({ useDevice: () => ({ mobile: { value: false } }) }));
jest.mock("../../chat/run/useChat", () => ({
    // `active` and `releaseDone` are both reached by module-scope watchers in useAgents the moment that module loads.
    useChat: () => ({
        conversations: chat.conversations,
        active: { value: { conversationId: undefined } },
        releaseDone: () => {},
    }),
}));
// The strip the fleet reads at module load; empty so no draft card competes with the registry rows under test.
jest.mock("../../chat/panel/useChat-strip", () => ({
    chatStrip: { value: { active: undefined, panes: [], tabs: [] } },
    chatPreviews: { value: {} },
    previewOf: () => undefined,
}));
// The draft startAgent pins and summons, one per test so its pins can be read back.
const draft = {
    value: {
        conversationId: `c1`,
        selection: pickable({ actsAs: { value: undefined as string | undefined }, startIn: { value: undefined as string | undefined } }),
    },
};
jest.mock("../../chat/panel/useChat-reveal", () => ({
    // `actsAs` is on the stub since startAgent pins the draft before summoning it, including to `undefined` when
    // pressing Anyone un-pins a persona.
    draftConversation: () => ({ ...draft.value, turn: { say: (prompt: string) => chat.enqueued.push(prompt) } }),
    agentTabOf: () => ({}),
    composingConversation: () => undefined,
}));
// The summons channel is the seam startAgent shows the new tab through; this suite has no second window to receive it,
// so a summoned turn runs here, as summonTurn does in any window drawing the chat.
jest.mock("../../chat/run/summon", () => ({
    summonChat: () => {},
    summonTurn: (conversation: { turn: { say: (prompt: string) => void } }, prompt: string) => conversation.turn.say(prompt),
}));
jest.mock("../../../lib/queryPersistence", () => ({ queryClient: { invalidateQueries: async () => undefined }, UNPERSISTED: `unpersisted` }));
jest.mock("../../../router", () => ({ router: { push: jest.fn() } }));
jest.mock("../../sandbox/client/useSandbox", () => ({
    useSandbox: () => ({
        active: { value: { token: `connect` } },
        activeSandboxId: { value: `s1` },
        daemonUrl: { value: `https://daemon.test` },
    }),
    sandboxKey: (...parts: unknown[]) => parts,
}));
jest.mock("../../sandbox/session/sandboxSession", () => ({
    useSandboxSession: () => ({ getSessionToken: async () => ({ token: `session-token`, kind: `session` }) }),
}));

const { askAgentToResolve, landAgent, startAgent } = await import("./agentActions");
const { setProjectScope } = await import("../../../app/projectScope");
// The board's own roster, which the errand reads the agent's settings off; written per test, cleared with the tabs.
const { registry } = await import("./useAgents-registry");
const { useAgents } = await import("./useAgents");
const { claim } = await import("./useAgents-provisional");
const { errands } = await import("../../chat/run/errands");

const none = { plan: false, question: false, permission: false, capability: false, credential: false, conflict: false };
// A card refusing to land, as the roster reports one.
const conflicted = (id: string): AgentSummary => ({
    id,
    status: `conflict`,
    provider: `claude`,
    harness: `native`,
    updatedAt: 0,
    attention: { ...none, conflict: true },
});
const lanesOf = (id: string): string[] =>
    Object.entries(useAgents().lanes.value).flatMap(([lane, cards]) => (cards.some((card) => card.id === id) ? [lane] : []));

// Every request fetch was handed, as the Request the daemon would have received.
const sent: Request[] = [];
// The daemon, route by route (`METHOD /path`): each answers a body its contract output accepts, since the typed client
// parses every answer; a route not named here is one the daemon does not know.
const stubDaemon = (routes: Readonly<Record<string, unknown>>): void => {
    stubGlobal(`fetch`, (url: string, init?: RequestInit) => {
        const request = new Request(url, init);
        sent.push(request);
        const answer = routes[`${request.method} ${new URL(request.url).pathname}`];
        return Promise.resolve(answer === undefined ? Response.json({ message: `Not Found` }, { status: 404 }) : Response.json(answer));
    });
};

// A land that carried work, as the daemon answers one.
const LANDED = { landed: true, changed: true };
const stubLand = (): void => stubDaemon({ [`POST /agents/a1/land`]: LANDED });

// GET /agents/{id}/conflicts as the daemon would answer it for a refused land.
const stubConflicts = (conflicts: readonly LandConflict[]): void => stubDaemon({ [`GET /agents/a1/conflicts`]: { conflicts } });

afterEach(() => {
    sent.length = 0;
    chat.conversations.value = [];
    chat.enqueued.length = 0;
    chat.opened.length = 0;
    painting.until = undefined;
    registry.value = [];
    draft.value = { conversationId: `c1`, selection: pickable({ actsAs: { value: undefined }, startIn: { value: undefined } }) };
    setProjectScope(undefined);
    unstubAllGlobals();
});

// Pinned because a missing content-type is invisible from this side and fatal on the daemon's: a string body is
// labelled text/plain, and its oRPC handler drops the `{id}` it took from the path.
it("sends the land body as JSON, so the daemon parses an object and keeps the agent id from the path", async () => {
    stubLand();
    expect(await landAgent(`a1`)).toEqual(LANDED);
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
    stubLand();
    await landAgent(`a1`, `check`, `outstanding`, true);
    expect(await sent[0]?.json()).toEqual({ mode: `check`, span: `outstanding`, force: true });
});

it("carries an explicit mode, so the conflict report's Merge is a different request and not the same one twice", async () => {
    stubLand();
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
    expect(ask).toEqual({ kind: `refused`, why: expect.stringContaining(`Commit them, then land again`) });
});

// The repo-unavailable refusal reads as a conflict on the card and names nothing a rebase could act on, so it's the
// same refusal wearing different copy. Distinct from a report that came back EMPTY, below: that one has no premise left
// at all, this one has a premise the agent simply cannot act on.
it("refuses the ask when the report names no blocked path at all, and names the repo it couldn't reach", async () => {
    chat.conversations.value = [tab(`a1`)];
    stubConflicts([{ repo: `docs`, clean: 0, paths: [] }]);
    expect(await askAgentToResolve(`a1`)).toEqual({ kind: `refused`, why: expect.stringContaining(`couldn't reach your workspace's copy of docs`) });
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
    // A report with nothing in it, and the judgement a measure land hands back: nothing applied, work held.
    stubDaemon({ [`GET /agents/a1/conflicts`]: {}, [`POST /agents/a1/land`]: { landed: false, changed: false, held: true } });
    const ask = await askAgentToResolve(`a1`);
    // Reported as an outcome, not a refusal: the board floats this rather than raising its failure strip.
    expect(ask).toEqual({ kind: `settled`, why: expect.stringContaining(`ready to land`) });
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
    expect(await askAgentToResolve(`a1`)).toEqual({ kind: `sent` });
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
// The account is half of that, and the half that cost a turn: left unnamed, the daemon picks by headroom, which reads
// an account idle BECAUSE it is refusing as the emptiest one — so the errand ran on a seat this very conversation had
// already been refused by, and retired its session to do it.
it("runs the errand on the agent's own model and account, not on the picks this window's tab happens to hold", async () => {
    const worn: unknown[] = [];
    const account = { value: `left-over-account` };
    chat.conversations.value = [{ ...tab(`a1`), selection: pickable({ account }, worn) }];
    registry.value = [
        {
            id: `a1`,
            status: `conflict`,
            provider: `claude`,
            harness: `native`,
            model: `claude-opus-5`,
            effort: `xhigh`,
            thinking: true,
            account: `the-account-that-ran-it`,
            updatedAt: 0,
            attention: { plan: false, question: false, permission: false, capability: false, credential: false, conflict: true },
        },
    ];
    stubConflicts([{ repo: `root`, clean: 0, paths: [{ path: `src/app.ts`, reason: `diverged` }] }]);

    expect(await askAgentToResolve(`a1`)).toEqual({ kind: `sent` });

    expect(worn).toEqual([{ provider: `claude`, model: `claude-opus-5`, harness: `native`, effort: `xhigh`, thinking: true }]);
    expect(account.value).toBe(`the-account-that-ran-it`);
});

// An agent whose registry entry names no account has never run a turn, so there is nothing better than the tab's own
// pick to send on; overwriting it with `undefined` would drop a pick the user did make.
it("leaves the tab's account alone when the registry has no account for the agent", async () => {
    const account = { value: `the-tab-pick` };
    chat.conversations.value = [{ ...tab(`a1`), selection: pickable({ account }) }];
    registry.value = [
        {
            id: `a1`,
            status: `conflict`,
            provider: `claude`,
            harness: `native`,
            model: `claude-opus-5`,
            updatedAt: 0,
            attention: { plan: false, question: false, permission: false, capability: false, credential: false, conflict: true },
        },
    ];
    stubConflicts([{ repo: `root`, clean: 0, paths: [{ path: `src/app.ts`, reason: `diverged` }] }]);

    expect(await askAgentToResolve(`a1`)).toEqual({ kind: `sent` });

    expect(account.value).toBe(`the-tab-pick`);
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
    stubDaemon({ [`GET /personas`]: { personas: [], connected: [] }, [`POST /personas`]: { ok: true } });
    startAgent(`Fix the footer.`);
    expect(draft.value.selection.actsAs.value).toBe(`project-web`);
    expect(draft.value.selection.startIn.value).toBe(`web`);
    await waitFor(() => expect(chat.enqueued).toEqual([`Fix the footer.`]));
    const posted = sent.find((request) => request.method === `POST` && request.url === `https://daemon.test/personas`);
    expect(await posted?.json()).toMatchObject({ id: `project-web`, workspace: { startIn: `web`, folders: [`web`] }, context: { repos: [`web`] } });
});

it("keeps the persona a press named over the project's own", () => {
    setProjectScope(`web`);
    stubDaemon({});
    startAgent(undefined, `maya-support`);
    expect(draft.value.selection.actsAs.value).toBe(`maya-support`);
    expect(draft.value.selection.startIn.value).toBe(`web`);
    expect(sent).toEqual([]);
});

// A card whose conversation is gone has nothing to send to; inventing one would start a turn on the wrong agent.
it("refuses the ask when the agent has no conversation left", async () => {
    stubConflicts([{ repo: `root`, clean: 0, paths: [{ path: `src/app.ts`, reason: `diverged` }] }]);
    expect(await askAgentToResolve(`a1`)).toEqual({ kind: `refused`, why: expect.stringContaining(`no conversation`) });
    // Refused before the report is even read: there is no one to tell.
    expect(sent).toEqual([]);
});

// A re-land after a discard must be a different request from any other land, or it's the same one twice. The default
// span is measured from the last landed tip, which sees nothing once discarded; only the cumulative span reads from the
// branch's base.
it("asks for the cumulative span by name, so a re-land carries work the default span can no longer see", async () => {
    stubLand();
    await landAgent(`a1`, `check`, `cumulative`);
    expect(await sent[0]?.json()).toEqual({ mode: `check`, span: `cumulative`, force: false });
});

// THE PRESS THIS FILE'S RESOLVE PATH WAS REWRITTEN FOR. The report its words are composed from is a full review of the
// branch, measured at seconds and sometimes tens of them, and the press used to wait for it before anything moved: the
// card sat in Attention and the chat showed nothing. Now the card and the chat move on the press, and the read runs
// inside the turn it will name.
it("moves the card to Active and opens the errand on the press, before the report its words need has answered", async () => {
    chat.conversations.value = [tab(`a1`)];
    registry.value = [conflicted(`a1`)];
    let answer: (response: Response) => void = () => undefined;
    stubGlobal(`fetch`, (url: string, init?: RequestInit) => {
        sent.push(new Request(url, init));
        return new Promise<Response>((settle) => (answer = settle));
    });

    const asking = askAgentToResolve(`a1`);

    expect(lanesOf(`a1`)).toEqual([`active`]);
    await waitFor(() => expect(chat.opened).toEqual([errands().landConflict.opening]));
    expect(chat.enqueued).toEqual([]);

    answer(Response.json({ repos: [], absorbed: 0, conflicts: [{ repo: `root`, clean: 0, paths: [{ path: `src/app.ts`, reason: `diverged` }] }] }));

    expect(await asking).toEqual({ kind: `sent` });
    expect(chat.enqueued).toEqual([expect.stringContaining(`src/app.ts`)]);
});

// The rollback is the claim's to do, not the caller's: a press that ends without a turn gives the card back its own
// standing the moment it answers.
it("gives the card back its own lane once the fresh report leaves nothing for the agent to do", async () => {
    chat.conversations.value = [tab(`a1`)];
    registry.value = [conflicted(`a1`)];
    stubConflicts([{ repo: `root`, clean: 4, paths: [{ path: `src/app.ts`, reason: `workspace` }] }]);

    expect((await askAgentToResolve(`a1`)).kind).toBe(`refused`);

    expect(lanesOf(`a1`)).toEqual([`attention`]);
    expect(chat.enqueued).toEqual([]);
});

// Between the press and the turn opening there can be a wait (a chat still painting the tab the press opened), and a
// Stop pressed on the already-moved card in that wait is the press that counts: the errand never opens.
it("never opens the errand when a later press replaced it while the chat was still painting", async () => {
    chat.conversations.value = [tab(`a1`)];
    registry.value = [conflicted(`a1`)];
    stubConflicts([{ repo: `root`, clean: 0, paths: [{ path: `src/app.ts`, reason: `diverged` }] }]);
    let painted: () => void = () => undefined;
    painting.until = new Promise((settle) => (painted = settle));

    const asking = askAgentToResolve(`a1`);
    claim(`a1`, undefined, `stop`);
    // The report's read is already out while the chat paints; the replacing press is what lets it go.
    await waitFor(() => expect(sent.filter((request) => request.url.endsWith(`/agents/a1/conflicts`)).map((request) => request.method)).toEqual([`GET`]));
    painted();

    expect(await asking).toEqual({ kind: `dropped` });
    expect(chat.opened).toEqual([]);
    expect(chat.enqueued).toEqual([]);
    // The report read the press started is let go rather than left to finish for nobody.
    expect(sent.filter((request) => request.url.endsWith(`/agents/a1/conflicts`)).map((request) => request.signal.aborted)).toEqual([true]);
});
