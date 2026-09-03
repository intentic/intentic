import { STATE_DIR } from "@intentic/constants";
import { TRIAL_PROVIDER } from "@intentic/sandbox-contract";
import { nextTick } from "vue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../sandbox/sandboxClient", () => {
    const sandboxRequest = vi.fn();
    const sandboxJson = vi.fn();
    return {
        sandboxRequest,
        sandboxJson,
    /* The reach-aimed pair, on the real client's terms: `undefined` is the active box, which is every call
     * these tests make. They delegate to the mocks above so the assertions stay written against one spy per
     * verb rather than two that would have to agree. */
        sandboxRequestVia: (_at: string | undefined, path: string, init?: RequestInit) =>
            init === undefined ? sandboxRequest(path) : sandboxRequest(path, init),
        sandboxJsonVia: (_at: string | undefined, path: string, init?: RequestInit) => (init === undefined ? sandboxJson(path) : sandboxJson(path, init)),
        sandboxError: vi.fn(async (response: Response) => {
            const body = (await response.json()) as { message?: string; error?: string };
            return new Error(body.message ?? body.error ?? `Request failed (${response.status}).`);
        }),
    };
});
// Same window.env chain via analytics; send() only fires a milestone event through track.
vi.mock("../analytics", () => ({ track: vi.fn() }));
// Same window.env chain via useApi; the tab persistence only reads activeSandboxId + reachable.
vi.mock("../sandbox/useSandbox", async () => {
    const { ref } = await import("vue");
    const activeSandboxId = ref<string | undefined>(`sb1`);
    const reachable = ref(false);
    // `sandboxKey` too, and not as an afterthought: an agent's transcript is a CACHED read now (agentTranscript
    // .ts), so the hydrate path this file exercises files it under a sandbox-scoped key. A mock missing it left
    // the key builder undefined, and every replay assertion here failed as a transcript that never arrived.
    return { useSandbox: () => ({ activeSandboxId, reachable }), sandboxKey: (...parts: unknown[]) => [...parts, activeSandboxId] };
});

// The node test environment has neither storage; the tab snapshot round-trips need both: sessionStorage is
// where a window's own tabs live and localStorage is the seed a fresh window starts from (see tabSnapshot).
const store = (name: "localStorage" | "sessionStorage"): Map<string, string> => {
    const entries = new Map<string, string>();
    Object.defineProperty(globalThis, name, {
        configurable: true,
        value: {
            getItem: (key: string) => entries.get(key) ?? null,
            setItem: (key: string, value: string) => void entries.set(key, value),
            removeItem: (key: string) => void entries.delete(key),
            clear: () => entries.clear(),
        },
    });
    return entries;
};
const local = store(`localStorage`);
const session = store(`sessionStorage`);
const storage = {
    clear: (): void => {
        local.clear();
        session.clear();
    },
    set: (key: string, value: string): void => {
        local.set(key, value);
        session.set(key, value);
    },
};

const { sandboxJson, sandboxRequest } = await import("../sandbox/sandboxClient");
const { queryClient } = await import("../queryPersistence");
const sandboxRequestMock = vi.mocked(sandboxRequest);
const sandboxJsonMock = vi.mocked(sandboxJson);

// The daemon's connection reads, as one mock. Both halves go through sandboxJson: a read that fails THROWS
// rather than returning an empty list (refreshAccounts), which is what lets the UI tell "you have no account"
// apart from "the daemon didn't answer". `accounts` is keyed by the provider route prefix the call carries.
type Subscriptions = { codex: unknown[]; grok: unknown[]; kimi: unknown[]; gemini: unknown[] };
const NO_SUBSCRIPTIONS: Subscriptions = { codex: [], grok: [], kimi: [], gemini: [] };
const mockConnections = (connections: { subscriptions?: Subscriptions; accounts?: (path: string) => unknown[] } = {}): void => {
    sandboxJsonMock.mockImplementation((path: string) =>
        Promise.resolve(
            path === `/translator/accounts` ? (connections.subscriptions ?? NO_SUBSCRIPTIONS) : { accounts: connections.accounts?.(path) ?? [] },
        ),
    );
};
const { useSandbox } = await import("../sandbox/useSandbox");
const { setDaemonRoutes } = await import("../sandbox/useDaemonRoutes");
const { draftConversation, hydrateOnce, loadAccountStatus, openAgentConversation, refreshConnections, resetChat, reveal, useChat } =
    await import("./useChat");
// The store half of "New agent", as the summons applies it (agentActions.startAgent): the fixture these
// suites open extra tabs with.
const newChat = () => {
    const conversation = draftConversation();
    reveal({ verb: `show`, entries: [conversation], focus: conversation.conversationId, caret: false });
    return conversation;
};

const { closedDrafts } = await import("./closedDrafts");
const { selectedAccountId, usageByAccount } = await import("./providerAccounts");
const { Conversation } = await import("./conversation");
const { endpointProviders, endpointsLoaded, trialStatus } = await import("./providerCatalog");
const { turnDefaults } = await import("./turnDefaults");

beforeEach(() => {
    // A daemon with nothing to say, unless the test says otherwise. The singleton keeps background work in
    // flight across tests (a tab hydrating, a turn reattaching), and an unmocked call resolving to `undefined`
    // surfaces as an unhandled rejection attributed to whichever test happens to be running.
    sandboxRequestMock.mockImplementation(() => Promise.resolve({ ok: false, status: 404, json: () => Promise.resolve({}) } as Response));
    mockConnections();
});

afterEach(async () => {
    vi.clearAllMocks();
    endpointProviders.value = [];
    endpointsLoaded.value = false;
    trialStatus.value = { available: false, allowance: 0, used: 0, remaining: 0, health: `unknown` };
    turnDefaults.provider.value = `claude`;
    // Let the reconciliation and tab-snapshot watches settle before the next test clears their stores.
    await nextTick();
    // An agent's transcript is cached across the app now, and this file reuses conversation ids between tests
    // with different daemon answers behind them, so the cache has to go with the mocks, or one test's reply is
    // handed to the next before its mock is ever asked.
    queryClient.clear();
});

describe(`useChat provider reconciliation`, () => {
    it(`points a GPT-only user's chat at Codex (served by the translator subscription) instead of gating on Claude`, async () => {
        const chat = useChat();
        // A fresh conversation defaults to Claude and reads as disconnected (the gate would show).
        expect(chat.provider.value).toBe(`claude`);
        expect(chat.connected.value).toBe(false);

        // No native accounts anywhere; only the ChatGPT subscription is connected in the translator.
        mockConnections({ subscriptions: { codex: [{ name: `codex-user.json`, label: `user@example.com` }], grok: [], kimi: [], gemini: [] } });
        await loadAccountStatus();
        await nextTick();

        // The untouched fresh conversation follows Codex (subscription-connected), so the composer is reachable:
        // no Claude wall, and no separate ChatGPT account was ever needed.
        expect(chat.provider.value).toBe(`codex`);
        expect(chat.connected.value).toBe(true);
    });

    it(`treats a Kimi Code translator subscription as Kimi's connection`, async () => {
        storage.clear();
        resetChat();
        const chat = useChat();
        mockConnections({ subscriptions: { codex: [], grok: [], kimi: [{ name: `kimi-user.json`, label: `Kimi User` }], gemini: [] } });

        await loadAccountStatus();
        chat.selectProvider(`kimi`);
        await nextTick();

        expect(chat.provider.value).toBe(`kimi`);
        expect(chat.connected.value).toBe(true);
    });

    it(`gates a routed (claude-code harness) chat on the translator subscription, not the native account`, async () => {
        storage.clear();
        resetChat();
        const chat = useChat();
        // Grok's native account is connected, but the translator holds no SuperGrok subscription yet.
        mockConnections({ accounts: (path) => (path.startsWith(`/grok`) ? [{ id: `xai`, label: `Grok`, connectedAt: 0 }] : []) });
        await loadAccountStatus();
        await nextTick();

        chat.selectProvider(`grok`);
        expect(chat.connected.value).toBe(true); // the native harness is served by the account
        chat.active.value.selectHarness(`claude-code`);
        expect(chat.connected.value).toBe(false); // routed: only the translator subscription serves the turn

        // The subscription connects (via the Agent tab's "Under Claude Code" row): the same gate opens.
        mockConnections({
            accounts: (path) => (path.startsWith(`/grok`) ? [{ id: `xai`, label: `Grok`, connectedAt: 0 }] : []),
            subscriptions: { codex: [], grok: [{ name: `xai-user.json`, label: `user@x.ai` }], kimi: [], gemini: [] },
        });
        await loadAccountStatus();
        expect(chat.connected.value).toBe(true);
    });

    /* The two halves of the connection picture land INDEPENDENTLY, and for a while the reconciliation above
     * acted on whichever arrived first. A Claude user with a ChatGPT subscription therefore opened, at random,
     * on GPT: the translator's list came back at once, Claude's account a round-trip later, and the chat was
     * moved in between: then never moved back, because by then it sat on a provider that could send. */
    it(`keeps a Claude user on Claude when the ChatGPT subscription answers first`, async () => {
        storage.clear();
        turnDefaults.provider.value = `claude`;
        resetChat();
        const chat = useChat();
        chat.active.value.selectModel({ provider: `claude`, value: `claude-opus-5` });

        // Both connections are real; only the ORDER they arrive in is unlucky.
        sandboxJsonMock.mockImplementation((path: string) => {
            if (path === `/translator/accounts`) {
                return Promise.resolve({ codex: [{ name: `codex-user.json`, label: `user@example.com` }], grok: [], kimi: [], gemini: [] });
            }
            if (path.startsWith(`/claude/accounts`)) {
                return new Promise((resolve) => setTimeout(() => resolve({ accounts: [{ id: `a1`, label: `Personal`, connectedAt: 0 }] }), 20));
            }
            return Promise.resolve({ accounts: [] });
        });

        await loadAccountStatus();
        await nextTick();

        expect(chat.provider.value).toBe(`claude`);
        expect(chat.model.value).toBe(`claude-opus-5`);
    });

    // A fallback is the app coping with a provider it cannot reach, not the user choosing one, so it moves the
    // chat and leaves the remembered pick alone, and a chat opened afterwards resolves the same way at read.
    it(`moves a GPT-only user's chat to Codex without rewriting the provider they picked`, async () => {
        storage.clear();
        turnDefaults.provider.value = `claude`;
        resetChat();
        const chat = useChat();
        mockConnections({ subscriptions: { codex: [{ name: `codex-user.json`, label: `user@example.com` }], grok: [], kimi: [], gemini: [] } });

        await loadAccountStatus();
        await nextTick();

        expect(chat.provider.value).toBe(`codex`);
        expect(chat.connected.value).toBe(true);
        expect(turnDefaults.provider.value).toBe(`claude`);
        expect(new Conversation().provider.value).toBe(`codex`);
    });

    /* The trial is a FALLBACK, not the provider somebody chose. A full-page OAuth return restores the open
     * draft from its tab snapshot (still trial) and the user's Google pick from turnDefaults independently.
     * Once the account read confirms Google, the untouched draft must converge on that pick; otherwise its
     * first message consumes Intentic's metered trial despite the connection the user just completed. */
    it(`returns an untouched trial fallback to Google once the connected account becomes available`, async () => {
        storage.clear();
        turnDefaults.provider.value = `gemini`;
        resetChat();
        const chat = useChat();

        /* The account read settles with nothing connected, then the platform's trial capability arrives. Both
         * halves are declared because the repoint pass waits for both (access.accessKnown): the endpoint read is
         * the slower one, and acting on the account read alone is what used to move a chat off the user's pick a
         * beat before the trial landed. `resetChat` above cleared it, as a sandbox switch does. */
        mockConnections();
        await refreshConnections(true);
        endpointProviders.value = [{ id: TRIAL_PROVIDER, label: `Free trial`, kind: `endpoint` }];
        endpointsLoaded.value = true;
        trialStatus.value = { available: true, allowance: 12, used: 0, remaining: 12, health: `healthy` };
        await nextTick();
        expect(chat.provider.value).toBe(TRIAL_PROVIDER);

        // Google OAuth completes and the next connection read sees it. The open draft should leave the
        // temporary trial just as a new conversation already would.
        mockConnections({ subscriptions: { codex: [], grok: [], kimi: [], gemini: [{ name: `google.json`, label: `user@gmail.com` }] } });
        await refreshConnections(true);
        await nextTick();

        expect(chat.provider.value).toBe(`gemini`);
        expect(new Conversation().provider.value).toBe(`gemini`);
    });
});

describe(`account usage hydration`, () => {
    beforeEach(() => {
        storage.clear();
        resetChat();
        usageByAccount.value = {};
        mockConnections();
    });

    // The daemon persists each account's usage window; without this the picker stays blank on a fresh load
    // until that account happens to run a turn, which is exactly the turn the user wanted to spend wisely.
    it(`seeds the usage map from the persisted snapshots on the account list`, async () => {
        mockConnections({
            accounts: (path) =>
                path.startsWith(`/claude`)
                    ? [
                          {
                              id: `a1`,
                              label: `Personal`,
                              connectedAt: 0,
                              usage: { windows: [{ kind: `seven_day`, utilization: 12, gates: `all` }], measuredAt: 500 },
                          },
                          { id: `a2`, label: `Work`, connectedAt: 1 },
                      ]
                    : [],
        });
        await loadAccountStatus();

        expect(usageByAccount.value[`claude:a1`]).toMatchObject({ windows: [{ kind: `seven_day`, utilization: 12, gates: `all` }], measuredAt: 500 });
        // An account the daemon has no reading for stays absent: unknown, not 0%.
        expect(usageByAccount.value[`claude:a2`]).toBeUndefined();
    });

    it(`keeps a live streamed reading when the persisted one is older`, async () => {
        usageByAccount.value = { "claude:a1": { windows: [{ kind: `seven_day`, utilization: 80, gates: `all` }], measuredAt: 9_000 } };
        mockConnections({
            accounts: (path) =>
                path.startsWith(`/claude`)
                    ? [{ id: `a1`, label: `Personal`, connectedAt: 0, usage: { windows: [{ kind: `seven_day`, utilization: 30, gates: `all` }], measuredAt: 500 } }]
                    : [],
        });
        await loadAccountStatus();

        // The daemon's write is fire-and-forget, so a refresh can land between a frame and its persist:
        // the newer reading must win, or the chip would flicker backwards mid-session.
        expect(usageByAccount.value[`claude:a1`]).toMatchObject({ windows: [{ kind: `seven_day`, utilization: 80, gates: `all` }], measuredAt: 9_000 });
    });
});

describe(`native account connection`, () => {
    beforeEach(() => {
        storage.clear();
        resetChat();
    });

    it(`starts Cursor on its dedicated login route and preserves the daemon's failure`, async () => {
        const chat = useChat();
        const daemonMessage = `The Cursor SDK download failed: npm registry unavailable.`;
        chat.setManagedProvider(`cursor`);
        sandboxRequestMock.mockResolvedValue(
            new Response(JSON.stringify({ message: daemonMessage }), {
                status: 412,
                headers: { "content-type": `application/json` },
            }),
        );

        await chat.startConnect();

        expect(sandboxRequestMock).toHaveBeenCalledWith(`/cursor/login/start`, { method: `POST` });
        expect(chat.error.value).toBe(daemonMessage);
        expect(chat.accountBusy.value).toBeUndefined();
    });
});

/* Which account serves the turn is a deliberate choice: headroom left on one, a different organization on
 * another, and it used to live in memory only: every refresh resolved it back to "the provider's first account"
 * and silently undid the pick. It is remembered per sandbox now (account ids name credential files in ONE
 * sandbox's store), while an already-open chat keeps the account it was actually running on. */
describe(`the remembered account`, () => {
    const TWO = (path: string): unknown[] =>
        path.startsWith(`/claude`)
            ? [
                  { id: `first`, label: `Claude`, connectedAt: 1 },
                  { id: `second`, label: `Claude`, connectedAt: 2 },
              ]
            : [];

    // A page load, as the singleton sees one: it re-reads its own stores for the sandbox, then the daemon answers.
    const reload = async (): Promise<void> => {
        await nextTick(); // let the snapshot / preference watches land before the stores are re-read
        resetChat();
        await loadAccountStatus();
    };

    beforeEach(async () => {
        storage.clear();
        mockConnections({ accounts: TWO });
        resetChat();
        await loadAccountStatus();
    });

    it(`opens a new session on the account last picked, not on the provider's first`, async () => {
        const chat = useChat();
        chat.selectAccount(`second`);

        await reload();
        expect(chat.account.value).toBe(`second`);

        // ...and so does the next new chat in that window, which is what "default" means.
        newChat();
        expect(chat.account.value).toBe(`second`);
    });

    it(`holds the pick through the window where the daemon hasn't answered yet`, async () => {
        const chat = useChat();
        chat.selectAccount(`second`);
        await nextTick();

        // The moment a reload paints: the account list is unread, so the only thing that knows the pick is the
        // store. Resolving it against the empty list is what used to flip the selection back to the first account
        // a beat before the real list arrived: visibly, and for the turn a fast sender got in during it.
        resetChat();
        expect(chat.account.value).toBe(`second`);

        await loadAccountStatus();
        expect(chat.account.value).toBe(`second`);
    });

    it(`leaves an open chat on the account it was running on when another tab switches`, async () => {
        const chat = useChat();
        const first = chat.active.value.conversationId;
        chat.selectAccount(`first`);
        chat.draft.value = `keep this tab real`;

        const other = newChat();
        chat.selectAccount(`second`);
        other.draft.value = `and this one`;

        await reload();
        const restored = (id: string): string | undefined =>
            chat.conversations.value.find((conversation) => conversation.conversationId === id)?.account.value;
        expect(restored(first)).toBe(`first`);
        expect(restored(other.conversationId)).toBe(`second`);
    });

    it(`moves a chat off an account that was disconnected while the window was away`, async () => {
        const chat = useChat();
        chat.selectAccount(`second`);

        // Away, the user disconnects it elsewhere. The remembered pin would otherwise fail every turn with
        // "No Claude account connected": about an account that is connected, naming a fix already done.
        await nextTick();
        mockConnections({ accounts: (path) => (path.startsWith(`/claude`) ? [{ id: `first`, label: `Claude`, connectedAt: 1 }] : []) });
        resetChat();
        await loadAccountStatus();

        expect(chat.account.value).toBe(`first`);
    });

    it(`keeps each sandbox's pick to itself: an account id names a credential in one sandbox's store`, async () => {
        const chat = useChat();
        chat.selectAccount(`second`);
        await nextTick();

        const { activeSandboxId } = useSandbox();
        activeSandboxId.value = `sb2`;
        resetChat();
        await loadAccountStatus();
        // sb2 has never been picked for: its own first account serves, not sb1's chosen id.
        expect(chat.account.value).toBeUndefined();

        activeSandboxId.value = `sb1`;
        await reload();
        expect(chat.account.value).toBe(`second`);
    });

    it(`survives an account read that comes back EMPTY: a list is not a verdict on the user's choice`, async () => {
        const chat = useChat();
        chat.selectAccount(`second`);
        await nextTick();

        /* A 200 carrying no accounts, which is what a daemon serves while its credential store is still coming
         * up. Resolving the pick against that answer (and persisting the result, as the preference watch does)
         * is how a deliberate choice was lost for good: every session after it opened on the first account. */
        mockConnections({ accounts: () => [] });
        resetChat();
        await loadAccountStatus();
        // The open chat keeps its pin: there is nothing to move it TO, and a provider with no accounts is the
        // composer's connect gate to talk about, not the account axis.
        expect(chat.account.value).toBe(`second`);

        // The real list lands. The pick was never overwritten, so it is still in force: including for the next
        // new chat, which is where the loss used to show up (and where it stayed, because it was persisted).
        mockConnections({ accounts: TWO });
        resetChat();
        await loadAccountStatus();
        expect(chat.account.value).toBe(`second`);
        // The draft is what makes the next tab real: newChat hands back an untouched one rather than minting a
        // second, and a restored empty tab carries its own pin, which would answer for the preference.
        chat.draft.value = `this tab is in use`;
        newChat();
        expect(chat.account.value).toBe(`second`);
    });

    it(`moves an open chat off a pick the list no longer has, and still remembers the pick`, async () => {
        const chat = useChat();
        chat.selectAccount(`second`);
        await nextTick();

        // `second` is gone (disconnected elsewhere): the open chat cannot keep sending against it, so it moves:
        // and, being what that chat now runs on, `first` is what its own tab comes back wearing after this.
        mockConnections({ accounts: (path) => (path.startsWith(`/claude`) ? [{ id: `first`, label: `Claude`, connectedAt: 1 }] : []) });
        resetChat();
        await loadAccountStatus();
        expect(chat.account.value).toBe(`first`);

        // The preference behind it is untouched, so once `second` is connected again a FRESH chat opens on it.
        // (The draft is what makes the new tab real: newChat hands back an untouched one rather than minting a
        // second, so a restored empty tab would answer for it.)
        mockConnections({ accounts: TWO });
        resetChat();
        await loadAccountStatus();
        chat.draft.value = `this tab is in use`;
        newChat();
        expect(chat.account.value).toBe(`second`);
    });
});

describe(`per-tab drafts`, () => {
    beforeEach(() => {
        storage.clear();
        resetChat();
    });

    it(`keeps each tab's draft through new-tab and switching back`, () => {
        const chat = useChat();
        const first = chat.active.value.conversationId;
        chat.draft.value = `hello A`;

        newChat();
        expect(chat.draft.value).toBe(``);

        chat.setActive(first);
        expect(chat.draft.value).toBe(`hello A`);
    });

    it(`restores tabs, drafts, attachment metadata, and the active tab from the persisted snapshot`, async () => {
        const chat = useChat();
        chat.draft.value = `draft one`;
        chat.attachments.value = [
            { id: `a1`, name: `pic.png`, path: `${STATE_DIR}/records/artifacts/attachments/u1/pic.png`, status: `done`, progress: 1 },
        ];
        newChat();
        chat.draft.value = `draft two`;
        await nextTick(); // flush the persistence watch

        resetChat(); // same restore path as a page refresh / sandbox switch-back
        const tabs = chat.conversations.value;
        expect(tabs).toHaveLength(2);
        expect(tabs[0]!.draft.value).toBe(`draft one`);
        expect(tabs[0]!.attachments.value).toMatchObject([
            { name: `pic.png`, path: `.intentic/records/artifacts/attachments/u1/pic.png`, status: `done` },
        ]);
        expect(tabs[1]!.draft.value).toBe(`draft two`);
        expect(chat.active.value).toBe(tabs[1]); // the second tab was active when persisted
    });

    // A queued message is text the user wrote and nobody has answered yet: a refresh mid-turn must not eat it.
    it(`restores messages queued behind a running turn, with their attachments`, async () => {
        const chat = useChat();
        chat.active.value.queued.value = [
            {
                id: `q1`,
                text: `also update the tests`,
                attachments: [{ name: `spec.md`, path: `${STATE_DIR}/records/artifacts/attachments/u1/spec.md` }],
            },
        ];
        await nextTick();

        resetChat();
        expect(chat.queued.value).toMatchObject([
            { text: `also update the tests`, attachments: [{ name: `spec.md`, path: `.intentic/records/artifacts/attachments/u1/spec.md` }] },
        ]);
    });

    it(`degrades a corrupt snapshot to a single fresh tab`, () => {
        storage.set(`intentic.chatTabs.sb1`, `not json`);
        resetChat();
        expect(useChat().conversations.value).toHaveLength(1);
        expect(useChat().draft.value).toBe(``);
    });

    /* HOW LONG THE MESSAGE HAS BEEN STANDING (Conversation.draftAt), which is what the unsent marks on the board
     * and the chat rail report and the one fact that separates a sentence broken off a minute ago from one
     * abandoned last week. */
    it(`stamps a composer the first time it holds something unsent, and clears it when that goes`, async () => {
        const clock = vi.spyOn(Date, `now`).mockReturnValue(1_000);
        try {
            const chat = useChat();
            expect(chat.active.value.draftAt.value).toBeUndefined();

            chat.draft.value = `half a sentence`;
            await nextTick();
            expect(chat.active.value.draftAt.value).toBe(1_000);

            /* ...AND IT DOES NOT MOVE AS THE MESSAGE GROWS. The age is of the message, not of its last
             * keystroke, and a stamp that advanced per character would also churn the draft echo's publish key,
             * which is deliberately built to stop changing once the preview settles (draftEcho). */
            clock.mockReturnValue(5_000);
            chat.draft.value = `half a sentence, then the other half`;
            await nextTick();
            expect(chat.active.value.draftAt.value).toBe(1_000);

            chat.draft.value = ``;
            await nextTick();
            expect(chat.active.value.draftAt.value).toBeUndefined();
        } finally {
            clock.mockRestore();
        }
    });

    // Persisted with the draft, because a stamp kept only in memory restarts at "just now" every time the window
    // does: a four-day-old abandoned sentence would come back from every reload looking like live work.
    it(`restores the age of a draft rather than re-stamping it as freshly written`, async () => {
        const clock = vi.spyOn(Date, `now`).mockReturnValue(1_000);
        try {
            useChat().draft.value = `half a sentence`;
            await nextTick(); // flush the stamp and the persistence watch

            clock.mockReturnValue(9_000);
            resetChat(); // same restore path as a page refresh
            await nextTick();

            expect(useChat().conversations.value[0]!.draftAt.value).toBe(1_000);
        } finally {
            clock.mockRestore();
        }
    });
});

/* The composer's pills (model, reasoning effort, extended thinking) describe the CHAT they sit under, so they
 * are stored with it. The remembered picks (turnDefaults) seed a NEW conversation and nothing else: re-seeding
 * the open ones from them is how every tab came back from a reload wearing the model last chosen in whichever
 * tab happened to be focused, stated over sessions that had demonstrably run on something else. */
describe(`per-tab turn settings`, () => {
    beforeEach(() => {
        storage.clear();
        resetChat();
    });

    it(`gives each tab back the settings it was showing, not the last pick made anywhere`, async () => {
        const chat = useChat();
        chat.draft.value = `keep me`; // content — the focus-leave sweep takes an untouched draft
        chat.selectModel({ provider: `claude`, value: `claude-sonnet-4-5-20250929` });
        chat.effort.value = `medium`;
        chat.thinking.value = false;

        newChat();
        chat.draft.value = `and me`;
        chat.selectModel({ provider: `claude`, value: `claude-opus-4-1-20250805` });
        await nextTick(); // flush the persistence watch

        resetChat(); // the same restore path as a page refresh
        const tabs = chat.conversations.value;
        expect(tabs[0]!.model.value).toBe(`claude-sonnet-4-5-20250929`);
        expect(tabs[0]!.effort.value).toBe(`medium`);
        expect(tabs[0]!.thinking.value).toBe(false);
        expect(tabs[1]!.model.value).toBe(`claude-opus-4-1-20250805`);
    });

    // A stored pair can be one the API refuses ('max' is Claude-with-thinking only), so the restore clamps it
    // for the same reason the constructor does: an invalid pair fails every turn until something touches it.
    it(`clamps a restored effort the tab's provider can no longer run`, () => {
        storage.set(
            `intentic.chatTabs.sb1`,
            JSON.stringify({
                active: `t1`,
                tabs: [
                    {
                        conversationId: `t1`,
                        isolated: true,
                        draft: `x`,
                        provider: `claude`,
                        effort: `max`,
                        thinking: false,
                        fast: false,
                        attachments: [],
                        queued: [],
                    },
                ],
            }),
        );

        resetChat();

        expect(useChat().effort.value).toBe(`xhigh`);
    });
});

/* A tab set belongs to the WINDOW it is open in, and the app is used in several at once: the daemon
 * multiplexes attach streams and the presence roster counts viewers per connection precisely so it can be.
 * While every window rewrote one shared key on every keystroke and streamed title, the last writer won: after
 * a reload (the dev server's live-reload reloads them all at once) a window came back wearing another
 * window's tabs: unfamiliar names, transcripts it had never cached, and a tab it had just closed back on the
 * strip because a window that still had it open wrote it again. */
describe(`tab snapshots across windows and sandboxes`, () => {
    // What another window would leave in the shared seed: a snapshot naming conversations by id.
    // Each tab carries composer text, which is what makes it a tab worth restoring at all: an EMPTY isolated tab
    // is an untouched "New agent" draft, and the strip keeps one of those only while it holds the focus.
    const foreignSnapshot = (active: string, ids: readonly string[]): string =>
        JSON.stringify({
            active,
            tabs: ids.map((conversationId) => ({ conversationId, isolated: true, draft: `typed in another window`, attachments: [], queued: [] })),
        });

    beforeEach(() => {
        storage.clear();
        resetChat();
    });

    it(`keeps a tab this window closed closed, whatever another window writes afterwards`, async () => {
        const chat = useChat();
        const kept = chat.active.value.conversationId;
        chat.draft.value = `keep me`; // content — the focus-leave sweep must not take the tab `closed` steals focus from
        const closed = newChat().conversationId;
        await nextTick();

        chat.closeTabs(new Set([closed]));
        await nextTick();

        // The other window is still on the pre-close set and persists it on its next change.
        local.set(`intentic.chatTabs.sb1`, foreignSnapshot(closed, [kept, closed]));

        resetChat(); // a reload — the live-reload's or the user's
        expect(chat.conversations.value.map((conversation) => conversation.conversationId)).toEqual([kept]);
    });

    // The seed is what makes "open the app, your chats are still there" survive closing the browser, so a
    // window that has never opened this sandbox does adopt the last session's tabs.
    it(`seeds a window with no tabs of its own from the last session's snapshot`, () => {
        session.clear();
        local.set(`intentic.chatTabs.sb1`, foreignSnapshot(`conv-b`, [`conv-a`, `conv-b`]));

        resetChat();
        const chat = useChat();
        expect(chat.conversations.value.map((conversation) => conversation.conversationId)).toEqual([`conv-a`, `conv-b`]);
        expect(chat.activeId.value).toBe(`conv-b`);
    });

    /* A restore is a write like any other, so the one-untouched-draft invariant holds across it: an empty
     * isolated tab that isn't the one holding the focus does not come back. Without that, a snapshot written
     * while such a tab existed (another window's, or one persisted a beat before the focus moved off it) came
     * back as a permanent "New agent" tab: one no focus change could ever take, because the focus had already
     * left it before the reload. It sat in the strip and carded itself on the fleet board indefinitely. */
    it(`drops a restored "New agent" tab that isn't the one holding the focus`, () => {
        session.clear();
        local.set(
            `intentic.chatTabs.sb1`,
            JSON.stringify({
                active: `conv-real`,
                tabs: [
                    { conversationId: `conv-empty`, isolated: true, draft: ``, attachments: [], queued: [] },
                    { conversationId: `conv-real`, isolated: true, draft: `carry on`, attachments: [], queued: [] },
                ],
            }),
        );

        resetChat();
        const chat = useChat();
        expect(chat.conversations.value.map((conversation) => conversation.conversationId)).toEqual([`conv-real`]);
        expect(chat.activeId.value).toBe(`conv-real`);
    });

    /* The switch flips activeSandboxId a flush before sandboxScope's watch re-scopes the chat. Anything that
     * changes a tab inside that window (a keystroke, a streamed title landing on a background tab) used to
     * write the OUTGOING sandbox's tabs under the INCOMING sandbox's key, which restoreTabs then read back one
     * line later as if they were its own: a strip full of another sandbox's chats, every one of them empty
     * because their conversations live on a daemon this sandbox has never spoken to. */
    it(`writes a tab snapshot under the sandbox its tabs came from, never the one being switched to`, async () => {
        const chat = useChat();
        const { activeSandboxId } = useSandbox();
        chat.draft.value = `still typing in sandbox one`;
        await nextTick();

        activeSandboxId.value = `sb2`;
        chat.draft.value = `still typing in sandbox one, mid-switch`;
        await nextTick();

        resetChat(); // sandboxScope's watch, one flush later
        expect(chat.conversations.value).toHaveLength(1);
        expect(chat.draft.value).toBe(``);

        activeSandboxId.value = `sb1`;
        resetChat();
        expect(chat.draft.value).toBe(`still typing in sandbox one, mid-switch`);
    });
});

/* The strip's close sets (the tab ×, and the right-click menu's Close Others / Close to the Right / Close All)
 * all land here. The invariant the menu leans on: the strip is never left empty, and focus only moves when the
 * tab that had it is one of the closed ones. */
describe(`closing tabs`, () => {
    beforeEach(() => {
        storage.clear();
        resetChat();
    });

    /* Four tabs, the third active: the shape every case below closes a different slice out of. Each one gets
     * composer text as it opens: an untouched "New agent" tab is not a tab the strip can hold alongside another
     * (setConversations enforces one at most, and only as the focused one), so four EMPTY presses would collapse
     * into a single reused draft. */
    const openFour = (): readonly string[] => {
        const chat = useChat();
        const ids: string[] = [];
        for (let at = 0; at < 4; at++) {
            const conversation = at === 0 ? chat.active.value : newChat();
            conversation.draft.value = `tab ${at}`;
            ids.push(conversation.conversationId);
        }
        chat.setActive(ids[2]!);
        return ids;
    };

    it(`closes one tab and leaves the active one alone`, () => {
        const chat = useChat();
        const ids = openFour();

        chat.closeTabs(new Set([ids[0]!]));

        expect(chat.conversations.value.map((c) => c.conversationId)).toEqual([ids[1], ids[2], ids[3]]);
        expect(chat.activeId.value).toBe(ids[2]); // untouched, it wasn't in the set
    });

    it(`closes every other tab and moves focus to the survivor`, () => {
        const chat = useChat();
        const ids = openFour();
        // "Close Others" from a right-click on the FIRST tab: the menu acts on the right-clicked tab, not the
        // active one, so the active tab is among the closed and focus has to move.
        chat.closeTabs(new Set([ids[1]!, ids[2]!, ids[3]!]));

        expect(chat.conversations.value.map((c) => c.conversationId)).toEqual([ids[0]]);
        expect(chat.activeId.value).toBe(ids[0]);
    });

    it(`closes the tabs to the right of the right-clicked one`, () => {
        const chat = useChat();
        const ids = openFour();

        chat.closeTabs(new Set([ids[2]!, ids[3]!])); // to the right of the second tab

        expect(chat.conversations.value.map((c) => c.conversationId)).toEqual([ids[0], ids[1]]);
        expect(chat.activeId.value).toBe(ids[1]); // the active tab went; focus falls to the one it was on before
    });

    /* WHERE THE FOCUS GOES WHEN THE TAB HOLDING IT CLOSES: to the tab it was on before this one, not to whichever
     * sits last in the strip. The rail sorts by lane, so "last" was most often a finished or archived chat nobody
     * was reading, and a draft closed from the board sent the popped-out chat to some old session. The same rule
     * for the rail's × and the board's, so the two closes land in the same place. */
    it(`hands the focus back to the most recently focused survivor when the focused tab closes`, () => {
        const chat = useChat();
        const ids = openFour(); // ...and the focus has visited them in order, ending on the third
        chat.setActive(ids[0]!);
        chat.setActive(ids[3]!);

        chat.closeTabs(new Set([ids[3]!]));

        expect(chat.activeId.value).toBe(ids[0]); // not ids[2], the last tab in the strip
    });

    // "Close All" can't leave the panel with nothing to render: the composer needs a conversation to write into.
    it(`replaces the strip with one fresh conversation when everything closes`, () => {
        const chat = useChat();
        const ids = openFour();

        chat.closeTabs(new Set(ids));

        expect(chat.conversations.value).toHaveLength(1);
        expect(chat.conversations.value[0]!.conversationId).not.toBeOneOf([...ids]);
        expect(chat.activeId.value).toBe(chat.conversations.value[0]!.conversationId);
        expect(chat.draft.value).toBe(``);
    });

    /* THE ONE THING A CLOSE MUST NOT DESTROY: the reported bug, from the surface it was pressed on.
     *
     * Everything else a closed chat held is somewhere else — the transcript is in History, the session is the
     * daemon's — but the message standing in the composer exists in this browser and nowhere at all besides,
     * and the × asks for no confirmation. So it is set aside (closedDrafts), the board keeps a card for it,
     * and opening that card puts the words back where they were typed. */
    it(`sets a closing chat's unsent message aside, and puts it back when the chat is opened again`, async () => {
        const chat = useChat();
        const ids = openFour();
        const closing = chat.conversations.value.find((c) => c.conversationId === ids[1]!)!;
        closing.draft.value = `the half-written message`;
        await nextTick(); // the stamp that dates the message (the unsent-edge watch)

        chat.closeTabs(new Set([ids[1]!]));

        expect(chat.conversations.value.map((c) => c.conversationId)).toEqual([ids[0], ids[2], ids[3]]);
        expect(closedDrafts.value.find((tab) => tab.conversationId === ids[1]!)?.draft).toBe(`the half-written message`);

        // The board's card for it, pressed: the same conversation, with its composer as it was left.
        const back = openAgentConversation({ id: ids[1]!, provider: `claude`, harness: `native`, registered: false });

        expect(back.draft.value).toBe(`the half-written message`);
        expect(back.draftAt.value).toBeGreaterThan(0); // dated from when it was written, not from the reopen
        // ...and taken out, never copied: two accounts of one draft is how the stale one ends up on the board.
        expect(closedDrafts.value.some((tab) => tab.conversationId === ids[1]!)).toBe(false);
    });

    // ...and a chat closed with NOTHING waiting in it is simply closed. This is not a history of tabs: reopening
    // an agent is what History is for, and a card for every × ever pressed is litter, not a rescue.
    it(`sets nothing aside for a chat closed with an empty composer`, async () => {
        const chat = useChat();
        const ids = openFour();
        const closing = chat.conversations.value.find((c) => c.conversationId === ids[1]!)!;
        closing.draft.value = ``;
        await nextTick();

        chat.closeTabs(new Set([ids[1]!]));

        expect(closedDrafts.value.some((tab) => tab.conversationId === ids[1]!)).toBe(false);
    });

    it(`ignores ids that aren't open`, () => {
        const chat = useChat();
        const ids = openFour();

        chat.closeTabs(new Set([`c999`]));

        expect(chat.conversations.value.map((c) => c.conversationId)).toEqual(ids);
        expect(chat.activeId.value).toBe(ids[2]);
    });

    // A click carrying a dead id (a strip that hasn't repainted since the tab went, another surface holding an
    // id from before a reset) must not move the focus: `active` falls back to the FIRST tab, so writing it
    // would surface a chat nobody asked for while the strip highlights none of them.
    it(`ignores a click on a tab that is no longer open`, () => {
        const chat = useChat();
        const ids = openFour();
        chat.closeTabs(new Set([ids[0]!]));

        chat.setActive(ids[0]!);

        expect(chat.activeId.value).toBe(ids[2]);
        expect(chat.active.value.conversationId).toBe(ids[2]);
    });
});

/* The strip must not hoard what the user walked away from: an untouched "New agent" tab (no text, no
 * attachment, nothing queued, no turn, no name) exists only while it holds the focus. It is also the fleet
 * board's draft card, so an abandoned press otherwise squats in the Active lane looking like work in flight.
 * Anything at all in the tab makes it real and it stays.
 *
 * The rule is an invariant of the ONE writer (setConversations), enforced in the same write that moves the
 * focus, not a watcher reaping afterwards, which is what it was. Every case here therefore asserts
 * SYNCHRONOUSLY: the list a caller reads back is already the list the user sees, so no surface can render or
 * persist the doomed in-between, and an explicit action can't be quietly cancelled out by a reaper racing it. */
describe(`abandoned drafts`, () => {
    beforeEach(async () => {
        storage.clear();
        resetChat();
        await nextTick();
    });

    it(`closes an untouched New agent tab when focus leaves it: whitespace alone isn't text`, () => {
        const chat = useChat();
        const first = chat.active.value.conversationId;
        chat.draft.value = `real work`;
        const abandoned = newChat();
        abandoned.draft.value = `   `;

        chat.setActive(first);

        expect(chat.conversations.value.map((c) => c.conversationId)).toEqual([first]);
        expect(chat.activeId.value).toBe(first);
    });

    it(`keeps the tab once anything is in it: a half-typed draft is not abandoned`, async () => {
        const chat = useChat();
        const first = chat.active.value.conversationId;
        chat.draft.value = `real work`;
        const kept = newChat();
        kept.draft.value = `half a thought`;
        await nextTick();

        chat.setActive(first);
        await nextTick();

        expect(chat.conversations.value.map((c) => c.conversationId)).toEqual([first, kept.conversationId]);
    });

    /* "New agent" pressed while an untouched one is already open hands THAT tab back. It used to append a
     * second and let the reaper close the first, which came to the same list one flush later, and so read as a
     * press that did nothing at all, because the two drafts were indistinguishable: same name, same emptiness,
     * same board card. There is nothing for a second one to be, so the press is about the caret (startAgent
     * asks for it either way) and the tab count is deliberately unchanged. */
    it(`hands back the untouched draft already open instead of minting a second`, () => {
        const chat = useChat();
        chat.draft.value = `real work`;
        const first = newChat();

        const again = newChat();

        expect(again).toBe(first);
        expect(chat.conversations.value).toHaveLength(2);
        expect(chat.activeId.value).toBe(first.conversationId);
    });

    // The same reuse from a DIFFERENT tab: the press lands the user on the draft they already have, which is a
    // visible tab switch rather than a silent no-op.
    it(`focuses an untouched draft the press finds on another tab`, () => {
        const chat = useChat();
        const first = chat.active.value.conversationId;
        chat.draft.value = `real work`;
        const draft = newChat();
        // A conversation that opened alongside it (a fleet card, a history row) takes the focus but not the draft.
        const opened = openAgentConversation({ id: `agent-1`, provider: `claude`, harness: `native`, title: `Someone else's work` });
        expect(chat.conversations.value.map((c) => c.conversationId)).toEqual([first, opened.conversationId]);

        const pressed = newChat();

        expect(pressed).not.toBe(draft); // that one went with the focus it lost
        expect(chat.activeId.value).toBe(pressed.conversationId);
    });

    /* WHAT EVERYTHING OUTSIDE THE PANEL READS (chatStrip): this window's own strip while it draws the chat, and
     * the strip the popped-out window publishes while it does not, never a mix of the two. With the chat on
     * another screen this window's tabs are a frozen copy, and every popped-out defect so far was a reader taking
     * one fact from the copy and another from the echo: a draft card swept because the copy looked empty, an
     * unsent chip kept because the copy still held sent words. So the copy is not consulted at all. */
    it(`answers for the strip from whichever window draws the chat`, async () => {
        const { chatStrip } = await import("./useChat");
        const { receiveChatNote } = await import("./chatChannel");
        const { receiveFloatingNote } = await import("../floating");
        const chat = useChat();
        const own = chat.active.value.conversationId;
        chat.draft.value = `real work`;
        await nextTick();

        expect(chatStrip.value.active).toBe(own);
        expect(chatStrip.value.tabs.map((tab) => ({ id: tab.id, unsent: tab.unsent, preview: tab.preview }))).toEqual([
            { id: own, unsent: true, preview: `real work` },
        ]);

        // Popped out: what this window holds stops counting, and what the holder says is the whole answer.
        receiveFloatingNote({ kind: `here`, panel: `chat`, id: `w1`, since: 1 });
        receiveChatNote({
            sandbox: `sb1`,
            note: {
                kind: `strip`,
                strip: {
                    active: `far`,
                    panes: [`far`],
                    tabs: [{ id: `far`, registered: false, standing: `draft`, provider: `claude`, harness: `native`, model: ``, unsent: true, preview: `half a thought` }],
                },
            },
        });
        expect(chatStrip.value.active).toBe(`far`);
        expect(chatStrip.value.tabs.map((tab) => tab.id)).toEqual([`far`]);

        // Docked again: this window draws the chat and answers for it, the echo is ignored whatever it last said.
        receiveFloatingNote({ kind: `gone`, panel: `chat`, id: `w1` });
        expect(chatStrip.value.active).toBe(own);
    });

    /* "NEW AGENT" PRESSED WHERE THE COMPOSER CANNOT BE SEEN. With the chat popped out, this window's tabs are a
     * shadow: it holds the draft it summoned earlier exactly as untouched as it was then, while the reader has
     * been typing into it a window away, since typing is never broadcast. Handing that shadow back summoned the
     * chat they were already in and opened nothing. A window that is not drawing the chat mints instead; the
     * drawing window's own write sweeps an untouched draft if it held one, so the strip converges either way. */
    it(`mints a fresh draft from a window that is not drawing the chat: its copy cannot tell empty from being typed into`, async () => {
        const { receiveFloatingNote } = await import("../floating");
        const chat = useChat();
        chat.draft.value = `real work`;
        const shadow = newChat();
        expect(draftConversation()).toBe(shadow); // docked, the untouched draft is handed back

        receiveFloatingNote({ kind: `here`, panel: `chat`, id: `w1`, since: 1 });
        try {
            const pressed = draftConversation();
            expect(pressed).not.toBe(shadow);
            expect(chat.conversations.value.map((c) => c.conversationId)).toContain(shadow.conversationId);
        } finally {
            receiveFloatingNote({ kind: `gone`, panel: `chat`, id: `w1` });
        }
    });

    it(`leaves a draft the fleet has registered alone: that tab is a real agent now`, async () => {
        const chat = useChat();
        const first = chat.active.value.conversationId;
        chat.draft.value = `real work`;
        const registered = newChat();
        registered.registered.value = true;
        await nextTick();

        chat.setActive(first);
        await nextTick();

        expect(chat.conversations.value.map((c) => c.conversationId)).toEqual([first, registered.conversationId]);
    });
});

/* Opening a card on the fleet board resolves the agent's current transcript by durable conversation/worktree
 * identity: the daemon may hold several runtime sessions for it.
 *
 * There is no provider gate here at all, and that is the fix rather than an omission. It was `provider ===
 * 'claude'` once, which opened a finished Gemini (or Kimi) agent as an empty "start a conversation with Google"
 * panel; widening it to "runs the Claude Code loop" fixed those two and left codex/grok NATIVE and every ACP blank
 * for the same reason, one provider later. Each widening asked "does this agent's provider keep a store we can
 * read?", when the answer that ends the bug is that the DAEMON keeps the store: it records what it streams
 * (sessions/transcript-record.ts), so the question no longer has to be asked. */
/* What the daemon says each of these agents' sessions is bound to, its registry entry's own record of the last
 * turn, keyed by conversation id so the fixture answers per agent exactly as the route does. */
const SESSION_BINDINGS: Record<string, { provider: string; harness: string; account?: string }> = {
    a1: { provider: `gemini`, harness: `native`, account: `acct-work` },
    a2: { provider: `codex`, harness: `claude-code`, account: `acct-work` },
    a3: { provider: `codex`, harness: `native`, account: `acct-work` },
    a4: { provider: `claude`, harness: `native`, account: `acct-work` },
    // The chat somebody switched accounts in: its session was minted on `acct-work` whatever its tab now picks.
    a6: { provider: `claude`, harness: `native`, account: `acct-work` },
};

describe(`opening a fleet agent`, () => {
    beforeEach(() => {
        storage.clear();
        resetChat();
        // Nothing is running for the agent, so the attach probe stands down and the stored transcript is what
        // paints: the finished-lane case the board's cards are mostly made of.
        sandboxRequestMock.mockImplementation((path: string) => {
            if (path.endsWith(`/transcript`)) {
                const agent = path.split(`/`)[2] ?? ``;
                return Promise.resolve({
                    ok: true,
                    json: () =>
                        Promise.resolve({
                            sessionId: `current-sdk-session`,
                            /* THE SESSION'S BINDING RIDES WITH ITS ID (AgentTranscriptSchema), the registry's
                             * record of what actually minted it, which is why the answer differs per agent here
                             * the way the daemon's does. The client adopts a session only when the daemon says
                             * what it is bound to: that trio is what the next send compares its picks against,
                             * and filling any of it in from the tab is the forgery this field exists to end. */
                            ...SESSION_BINDINGS[agent],
                            messages: [
                                { role: `user`, text: `What model are you?` },
                                { role: `assistant`, text: `Gemini.` },
                            ],
                        }),
                } as Response);
            }
            return Promise.resolve({ ok: false, status: 404 } as Response);
        });
    });

    it(`replays a finished Gemini agent's transcript, no native runtime means its session is the SDK store's`, async () => {
        // `native` is what the registry recorded: it persists the harness the CLIENT sent, and that is the
        // default for a provider with no harness to choose. Gemini runs the Claude Code loop either way, which
        // is exactly the drift a provider check tripped over.
        const conversation = openAgentConversation({ id: `a1`, sessionId: `sess-g`, provider: `gemini`, harness: `native` });

        await vi.waitFor(() => expect(conversation.messages.value).toHaveLength(2));
        expect(sandboxRequestMock).toHaveBeenCalledWith(`/agents/a1/transcript`);
        expect(conversation.messages.value[1]).toMatchObject({ role: `assistant`, text: `Gemini.` });
        expect(conversation.session.value?.id).toBe(`current-sdk-session`);
    });

    it(`replays a Codex agent routed under the Claude Code harness`, async () => {
        const conversation = openAgentConversation({ id: `a2`, sessionId: `sess-c`, provider: `codex`, harness: `claude-code` });

        await vi.waitFor(() => expect(conversation.messages.value).toHaveLength(2));
        expect(sandboxRequestMock).toHaveBeenCalledWith(`/agents/a2/transcript`);
        expect(conversation.session.value?.id).toBe(`current-sdk-session`);
    });

    it(`reconciles an already-open tab to a workspace conversation's registered placement`, () => {
        const existing = useChat().active.value;
        expect(existing.isolated.value).toBe(true);

        const opened = openAgentConversation({ id: existing.conversationId, provider: `claude`, harness: `native` });

        expect(opened).toBe(existing);
        expect(opened.registered.value).toBe(true);
        expect(opened.isolated.value).toBe(false);
    });

    // The registry records what each turn ran under, and that is what the tab opens on. Seeding it from the
    // browser's remembered picks instead is the reported bug: every agent you opened claimed the model you had
    // last chosen somewhere else, however long ago its own session had run on another one.
    it(`opens on the settings the agent ran with, leaving the tab that made the picks alone`, () => {
        const chat = useChat();
        chat.draft.value = `mine`; // content, so this tab survives losing the focus to the agent
        chat.selectModel({ provider: `claude`, value: `claude-fable-5` });
        chat.thinking.value = true;

        const conversation = openAgentConversation({
            id: `a4`,
            sessionId: `sess-s`,
            provider: `claude`,
            harness: `native`,
            model: `claude-sonnet-4-5-20250929`,
            effort: `medium`,
            thinking: false,
            fast: false,
        });

        expect(conversation.model.value).toBe(`claude-sonnet-4-5-20250929`);
        expect(conversation.effort.value).toBe(`medium`);
        expect(conversation.thinking.value).toBe(false);
        expect(chat.conversations.value[0]!.model.value).toBe(`claude-fable-5`);
    });

    it(`falls back to the remembered picks for an agent that has run nothing to describe`, () => {
        const chat = useChat();
        chat.selectModel({ provider: `claude`, value: `claude-fable-5` });

        expect(openAgentConversation({ id: `a5`, provider: `claude`, harness: `native`, registered: false }).model.value).toBe(`claude-fable-5`);
    });

    // The agent this whole change exists for. A native Codex turn runs no Claude Code loop and files no SDK
    // session, and the tab used to return before it asked anything, so an hour of work opened as "Start a
    // conversation with Codex." The tab asks now, like every other one.
    it(`replays a NATIVE Codex agent: the daemon holds what it streamed, whatever ran the turn`, async () => {
        const conversation = openAgentConversation({ id: `a3`, sessionId: `sess-n`, provider: `codex`, harness: `native` });

        await vi.waitFor(() => expect(conversation.messages.value).toHaveLength(2));
        expect(sandboxRequestMock).toHaveBeenCalledWith(`/agents/a3/transcript`);
    });

    /* WHOSE SESSION IS IT, when the tab's account pick and the session's account are not the same one, which is
     * every chat somebody switched accounts in (a spent allowance is how most of them got there).
     *
     * The reported bug, end to end: the board's card named the account that ran the turn, the composer named the
     * tab's pick, and hydrating stamped the PICK onto the session ref. So switching the composer back to the
     * account actually holding the session announced "your next message starts a fresh session", and then went
     * and started one, re-seeding the whole transcript against a cold prompt cache; leaving it on the other
     * account promised a resume and would have sent that session's id out under a credential that never minted
     * it. The daemon names the binding now (AgentTranscriptSchema) and the client takes it as given. */
    /* A TAB OPENED WITH NO PIN takes the account the daemon says served the session (Conversation.bindSession):
     * the card's chip and the picker then name the same account, and the next send resumes rather than
     * comparing "no pick" against a bound session and retiring it. */
    it(`pins a tab that opened unpinned to the account the daemon says its session ran on`, async () => {
        // No remembered pick and no account list yet: the seed the tab falls back to is nothing at all.
        selectedAccountId.value = { ...selectedAccountId.value, claude: undefined };
        const conversation = openAgentConversation({ id: `a4`, sessionId: `sess-s`, provider: `claude`, harness: `native` });
        expect(conversation.account.value).toBeUndefined();

        await vi.waitFor(() => expect(conversation.session.value?.account).toBe(`acct-work`));

        expect(conversation.account.value).toBe(`acct-work`);
    });

    it(`binds a reopened session to the account the daemon recorded, not to the tab's pick`, async () => {
        const conversation = openAgentConversation({
            id: `a6`,
            sessionId: `sess-b`,
            provider: `claude`,
            harness: `native`,
            // The pick this tab was left on, which is NOT what its last turn ran under.
            account: `acct-personal`,
        });

        await vi.waitFor(() => expect(conversation.session.value?.id).toBe(`current-sdk-session`));
        expect(conversation.session.value?.account).toBe(`acct-work`);
        expect(conversation.account.value).toBe(`acct-personal`);

        // Back onto the account that holds it: nothing is retired, so there is nothing to announce.
        conversation.selectAccount(`acct-work`);
        expect(conversation.messages.value.some((message) => message.role === `notice`)).toBe(false);

        // ...and away from it again, which genuinely does cost a fresh session, so it says so.
        conversation.selectAccount(`acct-personal`);
        expect(conversation.messages.value.some((message) => message.role === `notice` && message.text.startsWith(`Switched to Claude`))).toBe(true);
    });
});

/* A tab and its board card are one conversation under two skins, and `registered` is the claim that the fleet
 * has a card for it: latched on daemon evidence so it outlives an archive and a dropped roster. What it must
 * NOT outlive is the entry itself: a tab still claiming an agent the daemon has discarded is invisible on
 * /agents (no registry entry to render, and the draft half of the fleet skips registered conversations) while
 * sitting in the strip as an empty, untitled "New agent" that the focus-leave sweep is barred from taking:
 * the ghost card behind "there's a New agent in the rail in a floating window that doesn't exist on the board". */
describe(`a tab whose agent the fleet no longer has`, () => {
    beforeEach(() => {
        storage.clear();
        resetChat();
        // Nothing running; the agent's transcript route answers NOT_FOUND: the daemon speaking about this exact
        // id, which is what an archive (entry kept) or an unreachable daemon (throw) never do.
        sandboxRequestMock.mockImplementation((path: string) =>
            Promise.resolve(path.endsWith(`/transcript`) ? ({ ok: false, status: 404 } as Response) : ({ ok: false, status: 404 } as Response)),
        );
    });

    it(`stops claiming the agent, so an empty one leaves the strip with the focus`, async () => {
        const chat = useChat();
        const first = chat.active.value.conversationId;
        chat.draft.value = `real work`;
        const ghost = openAgentConversation({ id: `discarded-agent`, provider: `claude`, harness: `claude-code` });

        await vi.waitFor(() => expect(ghost.registered.value).toBe(false));
        // Nothing in it and no entry behind it: an ordinary untouched draft again, and the sweep takes it the
        // moment the focus moves, where before it was a permanent tab no surface could account for.
        chat.setActive(first);

        expect(chat.conversations.value.map((c) => c.conversationId)).toEqual([first]);
    });

    it(`keeps one that has a transcript: the work is still readable, the fleet claim is not`, async () => {
        const chat = useChat();
        const kept = openAgentConversation({ id: `discarded-with-work`, provider: `claude`, harness: `claude-code`, title: `Ship the thing` });
        kept.restoreMessages([{ role: `user`, text: `do the thing` }]);

        await vi.waitFor(() => expect(kept.registered.value).toBe(false));

        expect(chat.conversations.value).toContain(kept);
        expect(kept.messages.value).toHaveLength(1);
    });

    it(`believes a 404 only from a daemon that advertises the route`, async () => {
        // An older sandbox answers 404 for a route it was built without. Reading that as "your agent is gone"
        // would unregister every open agent tab in the app against a daemon that is merely behind.
        setDaemonRoutes([`agents.list`]);
        const stale = openAgentConversation({ id: `still-there`, provider: `claude`, harness: `claude-code` });

        await vi.waitFor(() => expect(sandboxRequestMock).toHaveBeenCalledWith(`/agents/still-there/transcript`));
        await nextTick();

        expect(stale.registered.value).toBe(true);
        setDaemonRoutes(undefined);
    });
});

/* Claude's API rejects effort 'max' with extended thinking disabled: a 400 that kills the turn before the
 * model sees the prompt, and reaches the user only as the SDK's opaque `unknown` error category. Both halves
 * persist into turnDefaults, so an unclamped pair would poison every NEW conversation too, not just the tab it
 * was set on. The toggle is the only user-facing write path for thinking, so it is where the pair is repaired. */
describe(`effort/thinking pairing`, () => {
    beforeEach(() => {
        storage.clear();
        resetChat();
    });

    it(`clamps a 'max' effort down when extended thinking is switched off, and persists the clamp`, () => {
        const chat = useChat();
        chat.effort.value = `max`;

        chat.thinking.value = false;
        expect(chat.effort.value).toBe(`xhigh`);

        // The next new conversation seeds from turnDefaults; it must not inherit the pair the API rejects.
        newChat();
        expect(chat.effort.value).toBe(`xhigh`);
    });

    it(`leaves 'max' alone while thinking stays on`, () => {
        const chat = useChat();
        chat.effort.value = `max`;
        chat.thinking.value = true;
        expect(chat.effort.value).toBe(`max`);
    });
});

/* THE PANES, which of the open chats are on screen at once, and in which columns. One is the ordinary case;
 * several is the floating window showing a fleet side by side (ChatPanel renders one ChatPane per id).
 *
 * The rule every case below turns on: SWITCHING is not OPENING. Everything that moves the focus, a rail
 * click, a card on the board, a deep link, a history row, a close reseating the focus: lands on setActive and
 * swaps the focused column, leaving the other panes where they are. Adding a column is a verb of its own. */
describe(`chat panes`, () => {
    beforeEach(() => {
        storage.clear();
        resetChat();
    });

    // Three tabs with content, so none of them is the untouched draft the strip reaps; the first is focused.
    const openThree = (): readonly string[] => {
        const chat = useChat();
        const ids: string[] = [];
        for (let at = 0; at < 3; at++) {
            const conversation = at === 0 ? chat.active.value : newChat();
            conversation.draft.value = `tab ${at}`;
            ids.push(conversation.conversationId);
        }
        chat.setActive(ids[0]!);
        return ids;
    };

    it(`starts as one pane, holding the focused chat`, () => {
        const chat = useChat();
        expect(chat.panes.value).toEqual([chat.activeId.value]);
    });

    it(`gives a chat a column of its own beside the focused one, and the focus with it`, () => {
        const chat = useChat();
        const ids = openThree();

        chat.openBeside(ids[1]!);

        expect(chat.panes.value).toEqual([ids[0], ids[1]]);
        expect(chat.activeId.value).toBe(ids[1]);
    });

    it(`swaps the focused pane rather than adding one when a chat is merely selected`, () => {
        const chat = useChat();
        const ids = openThree();
        chat.openBeside(ids[1]!); // panes [0, 1], focus on 1

        chat.setActive(ids[2]!);

        // The column the focus was in shows the new chat; the other pane is untouched.
        expect(chat.panes.value).toEqual([ids[0], ids[2]]);
        expect(chat.activeId.value).toBe(ids[2]);
    });

    // Selecting a chat that is already on screen is a focus move and nothing else: no second column for it.
    it(`only moves the focus when the selected chat already has a pane`, () => {
        const chat = useChat();
        const ids = openThree();
        chat.openBeside(ids[1]!);

        chat.setActive(ids[0]!);

        expect(chat.panes.value).toEqual([ids[0], ids[1]]);
        expect(chat.activeId.value).toBe(ids[0]);
    });

    it(`takes a chat's column back without closing the chat`, () => {
        const chat = useChat();
        const ids = openThree();
        chat.openBeside(ids[1]!);

        chat.closePane(ids[1]!);

        expect(chat.panes.value).toEqual([ids[0]]);
        expect(chat.conversations.value.map((c) => c.conversationId)).toEqual(ids); // still open, still in the rail
        expect(chat.activeId.value).toBe(ids[0]);
    });

    // The panel IS its last pane, so there is no such thing as closing it: the way to have no chat on screen
    // is to have no chats.
    it(`refuses to close the last pane`, () => {
        const chat = useChat();
        const ids = openThree();

        chat.closePane(ids[0]!);

        expect(chat.panes.value).toEqual([ids[0]]);
    });

    it(`drops a pane whose tab is closed`, () => {
        const chat = useChat();
        const ids = openThree();
        chat.openBeside(ids[1]!);

        chat.closeTabs(new Set([ids[1]!]));

        expect(chat.panes.value).toEqual([ids[0]]);
        expect(chat.activeId.value).toBe(ids[0]);
    });

    /* THE RESET: what a click carrying no modifier means on a surface whose modifiers build a selection. It
     * keeps the FOCUSED chat, since the click that asks for it has already moved the focus onto the row or the
     * card it landed on; the rest give their columns back without closing anything. */
    it(`collapses to the focused chat alone`, () => {
        const chat = useChat();
        const ids = openThree();
        chat.openBeside(ids[1]!);
        chat.openBeside(ids[2]!); // panes [0, 1, 2], focus on 2

        chat.setActive(ids[0]!); // the plain click: focus moves, the columns are still up
        chat.collapsePanes();

        expect(chat.panes.value).toEqual([ids[0]]);
        expect(chat.activeId.value).toBe(ids[0]);
        expect(chat.conversations.value.map((c) => c.conversationId)).toEqual(ids); // nothing was closed
    });

    it(`leaves a single pane alone`, () => {
        const chat = useChat();
        const ids = openThree();

        chat.collapsePanes();

        expect(chat.panes.value).toEqual([ids[0]]);
    });

    /* A multi-selection lands as a SET, and the chats already on screen keep the columns they are in: adding a
     * third chat must not reshuffle the two the user is reading (pane order is insertion order, never the
     * rail's, which re-sorts as turns end). */
    it(`keeps existing columns and appends the newcomers when a selection lands`, () => {
        const chat = useChat();
        const ids = openThree();
        chat.openBeside(ids[2]!); // panes [0, 2]

        chat.setPanes([ids[2]!, ids[1]!, ids[0]!]); // the same three, named in a different order

        expect(chat.panes.value).toEqual([ids[0], ids[2], ids[1]]);
    });

    // The board's order: claim the column, THEN open the chat. Without the claim coming first, the opening
    // would take the focused pane's column on its way in and the chat being read would vanish to make room.
    it(`keeps the chat being read when a not-yet-open chat claims a column first`, () => {
        const chat = useChat();
        const ids = openThree();
        const arriving = `agent-from-the-board`;

        chat.openBeside(arriving);
        openAgentConversation({ id: arriving, provider: `claude`, harness: `native` });

        expect(chat.panes.value).toEqual([ids[0], arriving]);
        expect(chat.activeId.value).toBe(arriving);
    });

    /* "NEW AGENT" IS A FRESH START, NOT AN ARRIVAL. Every other way into a chat swaps the focused column and
     * leaves the rest: those are chats the reader deliberately put up side by side. A brand-new one has
     * nothing in it to be beside anything, so it takes the panel whole; the chat it displaced is still open,
     * one click from a column again. */
    it(`gives the whole panel to a new chat rather than one column of a split`, () => {
        const chat = useChat();
        const ids = openThree();
        chat.openBeside(ids[1]!);
        expect(chat.panes.value).toEqual([ids[0], ids[1]]);

        const fresh = newChat();

        expect(chat.panes.value).toEqual([fresh.conversationId]);
        expect(chat.activeId.value).toBe(fresh.conversationId);
        // The split was given back, not closed: every chat that was open still is.
        expect(chat.conversations.value.map((conversation) => conversation.conversationId)).toEqual([...ids, fresh.conversationId]);
    });

    /* The same, down the OTHER branch: pressed while an untouched draft is already open, "New agent" hands that
     * one back rather than minting a second (see "chat tabs"), and the press has to mean the same thing either
     * way: a draft the reader has since given a second column to still comes back as the whole panel. */
    it(`gives the whole panel back when New agent hands over the draft it already opened`, () => {
        const chat = useChat();
        const ids = openThree();
        const fresh = newChat();
        // A Shift-range on the rail: a second column, with the focus left on the draft, the one way a draft
        // survives alongside another pane, since any move of the focus off it reaps it.
        chat.setPanes([fresh.conversationId, ids[1]!]);
        expect(chat.panes.value).toEqual([fresh.conversationId, ids[1]]);

        const again = newChat();

        expect(again.conversationId).toBe(fresh.conversationId);
        expect(chat.panes.value).toEqual([fresh.conversationId]);
    });

    it(`comes back from a reload with its columns, in the order they were left`, async () => {
        const chat = useChat();
        const ids = openThree();
        chat.openBeside(ids[2]!);
        await nextTick();

        resetChat();

        expect(useChat().panes.value).toEqual([ids[0], ids[2]]);
    });

    // A pane naming a tab that did not come back is a column with nothing in it: the restore keeps the rest.
    it(`reconciles a restored pane set against the tabs that actually restored`, () => {
        session.clear();
        local.set(
            `intentic.chatTabs.sb1`,
            JSON.stringify({
                active: `conv-a`,
                panes: [`conv-a`, `conv-gone`, `conv-b`],
                tabs: [
                    { conversationId: `conv-a`, isolated: true, draft: `one`, attachments: [], queued: [] },
                    { conversationId: `conv-b`, isolated: true, draft: `two`, attachments: [], queued: [] },
                ],
            }),
        );

        resetChat();

        expect(useChat().panes.value).toEqual([`conv-a`, `conv-b`]);
    });

    // A window that never split has no layout to record, and comes back as the single pane it always was.
    it(`restores a snapshot that names no panes as the focused chat alone`, () => {
        session.clear();
        local.set(
            `intentic.chatTabs.sb1`,
            JSON.stringify({
                active: `conv-b`,
                tabs: [
                    { conversationId: `conv-a`, isolated: true, draft: `one`, attachments: [], queued: [] },
                    { conversationId: `conv-b`, isolated: true, draft: `two`, attachments: [], queued: [] },
                ],
            }),
        );

        resetChat();

        expect(useChat().panes.value).toEqual([`conv-b`]);
    });
});

/* A TURN THAT IS STILL RUNNING IS NOT IN THE DAEMON'S RECORD, and hydration has to survive that.
 *
 * The record (/agents/:id/transcript) is written as turns SETTLE, so while one is in flight it holds every turn
 * but that one, and painting it is a whole-transcript rebuild. Landing that on top of a turn a stream had
 * already rendered took the turn with it: its prompt bubble, its tool cards, and the plan card it was parked on.
 * Nothing redrew them, because a turn parked on a card emits no further frames. What was left on screen was a
 * spinner over a transcript that ended one turn early, with nothing to approve, and reloading reproduced it
 * rather than fixing it, since every open runs the same reads again.
 *
 * Two things had to be true for it, and both are pinned below: hydration must not run twice at once, and a
 * replayed record must stand down rather than paint over a live turn. */
describe(`hydrating a conversation whose turn is still running`, () => {
    const encoder = new TextEncoder();
    const sseFrame = (payload: unknown): Uint8Array => encoder.encode(`data: ${JSON.stringify(payload)}\n\n`);

    // The record: the turn BEFORE the live one, which is all a settling-time record can hold.
    const RECORDED = {
        sessionId: `sess-live`,
        messages: [
            { role: `user`, text: `reword the notice` },
            { role: `assistant`, text: `Reworded and verified.` },
        ],
    } as const;

    // A run parked on its plan card: head, one frame, and no `end`, the stream stays open for as long as the
    // agent waits on the user, which is the whole reason nothing redraws what a rebuild takes away.
    const parkedRun = (): Response => {
        const body = new ReadableStream<Uint8Array>({
            start(controller) {
                controller.enqueue(sseFrame({ kind: `attached`, run: `r1`, prompt: `add the reconcile engine`, startedAt: 1000, seq: 1 }));
                controller.enqueue(
                    sseFrame({ kind: `frame`, seq: 1, event: { kind: `plan`, requestId: `p1`, text: `# Reconcile engine\n\nStep 1` } }),
                );
            },
        });
        return { ok: true, body } as Response;
    };

    // The typewriter and the frame buffer drain via requestAnimationFrame; run them synchronously so a frame
    // that arrived has landed by the time an assertion reads the transcript.
    beforeEach(() => {
        vi.stubGlobal(`requestAnimationFrame`, (callback: FrameRequestCallback): number => {
            callback(0);
            return 0;
        });
        vi.stubGlobal(`cancelAnimationFrame`, () => {});
        storage.clear();
        resetChat();
    });

    afterEach(() => {
        vi.unstubAllGlobals();
    });

    /* Opening a fleet agent hydrates it, and the pane's fleet watcher hydrates it again the moment the roster
     * names the conversation (ChatPane), so two passes in flight at once is the ordinary case. Each holds its
     * own round-trip, and the slower one answers about a tab the faster one has already moved on. */
    it(`runs one pass at a time, so a second trigger cannot answer about a tab the first has moved on`, async () => {
        let reads = 0;
        sandboxRequestMock.mockImplementation((path: string) => {
            if (path.endsWith(`/transcript`)) {
                reads += 1;
                return Promise.resolve({ ok: true, json: () => Promise.resolve(RECORDED) } as Response);
            }
            return Promise.resolve({ ok: false, status: 404, json: () => Promise.resolve({}) } as Response);
        });

        const conversation = openAgentConversation({ id: `hydrated-twice`, provider: `claude`, harness: `native` });
        hydrateOnce(conversation);

        await vi.waitFor(() => expect(conversation.messages.value).toHaveLength(2));
        await new Promise((resolve) => setTimeout(resolve, 0));

        expect(reads).toBe(1);
    });

    /* The invariant behind that, and the one that holds however the two got interleaved: a probe that finds the
     * turn already owned by another stream reports "not attached", which is NOT "nothing is running", and the
     * fall-back replay must not take the running turn off the screen. */
    it(`leaves a live turn alone when the stored replay lands after another stream engaged`, async () => {
        const conversation = useChat().active.value;
        // A tab with a transcript already on it: the record is only re-read on the fall-back path.
        conversation.registered.value = true;
        conversation.restoreMessages(RECORDED.messages);

        // The hydrate's probe attaches first and is answered LAST: by then the turn belongs to the stream
        // below, the probe stands down, and the fall-back replay runs against a conversation that is streaming.
        let releaseProbe = (): void => undefined;
        const probed = new Promise<void>((resolve) => {
            releaseProbe = resolve;
        });
        let attaches = 0;
        sandboxRequestMock.mockImplementation((path: string) => {
            if (path.endsWith(`/transcript`)) {
                return Promise.resolve({ ok: true, json: () => Promise.resolve(RECORDED) } as Response);
            }
            if (path !== `/agent/attach`) {
                return Promise.resolve({ ok: false, status: 404, json: () => Promise.resolve({}) } as Response);
            }
            attaches += 1;
            return attaches === 1 ? probed.then(parkedRun) : Promise.resolve(parkedRun());
        });

        hydrateOnce(conversation);
        await vi.waitFor(() => expect(attaches).toBe(1));
        void conversation.reattach();
        await vi.waitFor(() => expect(conversation.messages.value.some((message) => message.plan !== undefined)).toBe(true));

        releaseProbe();
        // The fall-back read leaving the mock is not the redraw it would cause: that is another turn of the
        // microtask queue past it, and asserting before it lands is what makes this test pass on the bug.
        await new Promise((resolve) => setTimeout(resolve, 0));
        await nextTick();

        expect(conversation.streaming.value).toBe(true);
        expect(conversation.messages.value.map((message) => message.text)).toContain(`add the reconcile engine`);
        expect(conversation.messages.value.find((message) => message.plan !== undefined)?.plan?.status).toBe(`pending`);
    });
});

/* THE OFFER TO CARRY ON BELONGS TO THE CONVERSATION, NOT TO THE WINDOW THAT WATCHED IT STOP.
 *
 * `pickUp` was armed only by the stream that saw a turn die, so the continue press existed exactly where
 * somebody had been looking. Every other way of arriving at the same stopped session had nothing: a Stop pressed
 * on the board with the chat closed (agentActions.stopAgent posts the cancel straight to the daemon), a session
 * stopped on another device, a tab closed and reopened from its card, a turn the daemon was killed under. All of
 * them left a chat whose only way on was typing "Continue" by hand, which is the one thing the press exists to
 * spare. The daemon says how the last turn ended now (AgentTranscriptSchema.stoppedShort), and hydration takes
 * it: the offer is a property of the conversation from here on, whoever opens it and whenever. */
describe(`opening a session whose last turn stopped short`, () => {
    const STOPPED = {
        sessionId: `sess-stopped`,
        stoppedShort: true,
        messages: [
            { role: `user`, text: `rewrite the reconcile engine` },
            { role: `assistant`, text: `Started on the reducer.` },
        ],
    } as const;

    // The record answers the transcript read; nothing is running, so the attach probe finds no turn (the 404
    // every other path falls back to, see the file's default mock).
    const daemonReads = (body: unknown): void => {
        sandboxRequestMock.mockImplementation((path: string) =>
            path.endsWith(`/transcript`)
                ? Promise.resolve({ ok: true, json: () => Promise.resolve(body) } as Response)
                : Promise.resolve({ ok: false, status: 404, json: () => Promise.resolve({}) } as Response),
        );
    };

    beforeEach(() => {
        storage.clear();
        resetChat();
    });

    it(`offers the continuation on a tab that never watched the turn stop`, async () => {
        daemonReads(STOPPED);

        const conversation = openAgentConversation({ id: `stopped-elsewhere`, provider: `claude`, harness: `native` });
        hydrateOnce(conversation);

        await vi.waitFor(() => expect(conversation.messages.value).toHaveLength(2));
        // `stopped` and not one of the endings that know more: a record says the turn did not finish and nothing
        // else, which is exactly what the strip's plainest sentence and a live press are drawn from.
        await vi.waitFor(() => expect(conversation.pickUp.value).toEqual({ reason: `stopped` }));
    });

    // The commonest ending by far, and the one this must stay silent about: a chat that offered to continue
    // finished work would teach people to ignore the strip everywhere it means something.
    it(`says nothing about a conversation whose last turn ended on its own`, async () => {
        daemonReads({ sessionId: `sess-done`, messages: STOPPED.messages });

        const conversation = openAgentConversation({ id: `finished-cleanly`, provider: `claude`, harness: `native` });
        hydrateOnce(conversation);

        await vi.waitFor(() => expect(conversation.messages.value).toHaveLength(2));
        expect(conversation.pickUp.value).toBeUndefined();
    });

    /* A PICK-UP THE STREAM ALREADY ARMED OUTRANKS THE RECORD, because it knows strictly more than a record can
     * carry: the turn is HELD whole (so the press re-runs it rather than appending a message after it) and the
     * allowance names the hour it comes back. Flattened to a bare `stopped`, the strip would lose its countdown
     * and the press would post the word "Continue" into a conversation the daemon is holding a turn for. */
    it(`keeps what the stream armed instead of flattening it to a bare stop`, async () => {
        daemonReads(STOPPED);

        const conversation = openAgentConversation({ id: `stopped-on-a-limit`, provider: `claude`, harness: `native` });
        const spent = { reason: `limit`, readyAt: 4_000, held: { ran: true } } as const;
        conversation.pickUp.value = spent;
        hydrateOnce(conversation);

        await vi.waitFor(() => expect(conversation.messages.value).toHaveLength(2));
        expect(conversation.pickUp.value).toEqual(spent);
    });

    // A record the daemon could not produce leaves nothing to carry on FROM, and the press would open the
    // conversation with the word "Continue" — the shape of the bug `turnAccepted` exists to prevent, arriving
    // by another road.
    it(`refuses to offer a continuation over a transcript that never painted`, async () => {
        daemonReads({ ...STOPPED, messages: [] });

        const conversation = openAgentConversation({ id: `stopped-but-empty`, provider: `claude`, harness: `native` });
        hydrateOnce(conversation);

        await vi.waitFor(() => expect(sandboxRequestMock.mock.calls.some(([path]) => String(path).endsWith(`/transcript`))).toBe(true));
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(conversation.messages.value).toHaveLength(0);
        expect(conversation.pickUp.value).toBeUndefined();
    });
});

/* FORKING FROM A CUT. The gesture is the transcript's, but everything it decides lives here: which tab the user
 * lands in, what that tab is holding, and: the part the old edit-and-branch got wrong, whether anything ran. */
describe(`forking at a cut`, () => {
    beforeEach(() => {
        storage.clear();
        resetChat();
        sandboxRequestMock.mockReset();
    });

    // Four bubbles, two of them prompts the daemon still holds a state for: a conversation reopened from
    // history, which is the state most forks are taken from.
    const seed = (): ReturnType<typeof useChat> => {
        const chat = useChat();
        chat.active.value.restoreMessages([
            { role: `user`, text: `first`, checkpointId: `snap-1` },
            { role: `assistant`, text: `one` },
            { role: `user`, text: `second`, checkpointId: `snap-2` },
            { role: `assistant`, text: `two` },
        ]);
        return chat;
    };

    it(`opens a new tab holding the prompt below the cut, and sends nothing`, () => {
        const chat = seed();
        const source = chat.active.value;

        chat.forkAt(2, `now`);

        // The fork is a new tab, focused, carrying the turns above the cut and nothing below it.
        expect(chat.conversations.value).toHaveLength(2);
        const fork = chat.active.value;
        expect(fork).not.toBe(source);
        expect(fork.messages.value.map((message) => message.text)).toEqual([`first`, `one`]);
        // The prompt is in the composer to be read and changed, not in the transcript, and not on the wire.
        expect(fork.draft.value).toBe(`second`);
        expect(sandboxRequestMock).not.toHaveBeenCalled();
        // And the source is exactly as it was, which is the point of forking rather than rewinding.
        expect(source.messages.value.map((message) => message.text)).toEqual([`first`, `one`, `second`, `two`]);
    });

    // Past the last message there is no prompt below the cut to inherit, so the fork opens on an empty composer:
    // the whole conversation, carried on in a fresh tab.
    it(`forks the whole conversation with an empty composer`, () => {
        const chat = seed();

        chat.forkAt(4, `now`);

        const fork = chat.active.value;
        expect(fork.messages.value.map((message) => message.text)).toEqual([`first`, `one`, `second`, `two`]);
        expect(fork.draft.value).toBe(``);
    });

    /* "Files as they were" is only sayable in a checkout of the fork's own, so asking for it turns the fork
     * isolated whatever the source was: a fork of a main-tree chat that wants the old files becomes an agent. */
    it(`isolates a fork that asks for the files as they were`, () => {
        const chat = seed();
        chat.active.value.isolated.value = false;

        chat.forkAt(2, `then`);

        expect(chat.active.value.isolated.value).toBe(true);
    });

    // Asking for today's files decides nothing about placement, so the fork simply works where its source did:
    // main tree or worktree alike.
    it(`leaves a fork asking for today's files where its source was working`, () => {
        const chat = seed();
        chat.active.value.isolated.value = false;

        chat.forkAt(2, `now`);
        expect(chat.active.value.isolated.value).toBe(false);

        chat.setActive(chat.conversations.value[0]!.conversationId);
        chat.active.value.isolated.value = true;
        chat.forkAt(2, `now`);
        expect(chat.active.value.isolated.value).toBe(true);
    });

    // A cut nobody could have made (past the end of a transcript that has since shrunk) opens no tab at all.
    it(`refuses a cut out of range`, () => {
        const chat = seed();

        chat.forkAt(9, `now`);
        expect(chat.conversations.value).toHaveLength(1);
    });

    /* A RUNNING TURN SPLITS THIS IN TWO. The turns above the cut are settled and copying them costs the run
     * below nothing, so branching off mid-turn: the moment a long answer is going somewhere you don't want
     * is exactly when a second attempt is worth having: opens its tab. Asking for the FILES as they were is
     * refused until the turn ends: restoring a checkpoint under an agent writing to those same files is a
     * different act, and one no menu row should perform by surprise. */
    it(`forks the chat while a turn runs, and refuses to move files under it`, () => {
        const chat = seed();
        chat.active.value.streaming.value = true;

        chat.forkAt(2, `then`);
        expect(chat.conversations.value).toHaveLength(1);

        chat.forkAt(2, `now`);
        expect(chat.conversations.value).toHaveLength(2);
    });
});

/* THE UNSENT BOARD: several drafts standing on the /agents board, each prepared with its own message and its
 * own model. Picking a model in one of them is a statement about that one chat, and about what the NEXT new
 * chat should open on — never about the other drafts already standing. */
describe(`unsent drafts keep their own picks`, () => {
    beforeEach(() => {
        storage.clear();
        resetChat();
    });

    const bothConnected = (): void => {
        mockConnections({
            accounts: (path) =>
                path.startsWith(`/claude`) || path.startsWith(`/cursor`) ? [{ id: `a-${path.slice(1, 7)}`, label: `Personal`, connectedAt: 0 }] : [],
        });
    };

    it(`leaves the other drafts alone when one of them picks a different model`, async () => {
        bothConnected();
        const chat = useChat();
        await loadAccountStatus();
        endpointsLoaded.value = true;
        await nextTick();

        const first = chat.active.value;
        first.draft.value = `first task`;
        first.selectModel({ provider: `cursor`, value: `composer-2.5` });

        const second = newChat();
        second.draft.value = `second task`;
        second.selectModel({ provider: `claude`, value: `claude-opus-5` });
        await nextTick();

        expect([first.provider.value, first.model.value]).toEqual([`cursor`, `composer-2.5`]);

        // A routine connection refresh (they run on a timer) must not drag the first draft onto the last pick.
        await refreshConnections(true);
        await nextTick();
        expect([first.provider.value, first.model.value]).toEqual([`cursor`, `composer-2.5`]);
    });

    it(`gives every draft its own pick back after a reload`, async () => {
        bothConnected();
        const chat = useChat();
        await loadAccountStatus();
        endpointsLoaded.value = true;
        await nextTick();

        chat.active.value.draft.value = `first task`;
        chat.active.value.selectModel({ provider: `cursor`, value: `composer-2.5` });
        const second = newChat();
        second.draft.value = `second task`;
        second.selectModel({ provider: `claude`, value: `claude-opus-5` });
        await nextTick();

        resetChat(); // the same restore path as a page refresh
        await loadAccountStatus();
        endpointsLoaded.value = true;
        await nextTick();

        expect(chat.conversations.value.map((tab) => [tab.provider.value, tab.model.value])).toEqual([
            [`cursor`, `composer-2.5`],
            [`claude`, `claude-opus-5`],
        ]);
    });

    /* THE PICK THAT KEEPS THE PROVIDER IS STILL A PICK. It is the ordinary one, too: going back to a draft that
     * already sits on Cursor and choosing a different Cursor model. The provider pointer used to be written only
     * by a pick that MOVED the chat, so this recorded the model under Cursor and left the pointer on whatever
     * provider some other tab was last switched to, and the next New agent opened on that provider showing a
     * model the user had never chosen. */
    it(`opens a new agent on the last model picked, even when that pick kept the provider`, async () => {
        bothConnected();
        const chat = useChat();
        await loadAccountStatus();
        endpointsLoaded.value = true;
        await nextTick();

        const prepared = chat.active.value;
        prepared.draft.value = `first task`;
        prepared.selectModel({ provider: `cursor`, value: `composer-2.5` });

        // A second draft, switched to Claude: this is what leaves the remembered provider pointing elsewhere.
        const second = newChat();
        second.draft.value = `second task`;
        second.selectModel({ provider: `claude`, value: `claude-opus-5` });

        // Back to the first draft, and a different CURSOR model chosen in it.
        chat.setActive(prepared.conversationId);
        prepared.selectModel({ provider: `cursor`, value: `composer-2.5-fast` });
        await nextTick();

        const fresh = new Conversation();
        expect([fresh.provider.value, fresh.model.value]).toEqual([`cursor`, `composer-2.5-fast`]);
    });

    /* THE FALLBACK STILL COMES BACK, which is what the drag above was standing in for: a chat the APP moved off
     * a provider it could not reach returns to that provider the moment it can — to its OWN, not to whatever was
     * picked most recently somewhere else, and without disturbing the drafts beside it. */
    it(`returns only the chat the app moved, and only to the provider it was moved off`, async () => {
        const chat = useChat();
        const stranded = chat.active.value;
        stranded.draft.value = `written while Claude was down`;
        stranded.selectModel({ provider: `claude`, value: `claude-opus-5` });

        const beside = newChat();
        beside.draft.value = `prepared on Cursor`;
        beside.selectModel({ provider: `cursor`, value: `composer-2.5` });

        // Only Cursor answers: the Claude draft cannot send, so the app parks it there.
        mockConnections({ accounts: (path) => (path.startsWith(`/cursor`) ? [{ id: `cur`, label: `Cursor`, connectedAt: 0 }] : []) });
        await loadAccountStatus();
        endpointsLoaded.value = true;
        await nextTick();
        expect(stranded.provider.value).toBe(`cursor`);
        expect([beside.provider.value, beside.model.value]).toEqual([`cursor`, `composer-2.5`]);

        // Claude comes back. The chat that was moved goes home, on the model it was moved off; the one that was
        // deliberately prepared on Cursor stays exactly where the user put it.
        bothConnected();
        await refreshConnections(true);
        await nextTick();
        expect([stranded.provider.value, stranded.model.value]).toEqual([`claude`, `claude-opus-5`]);
        expect([beside.provider.value, beside.model.value]).toEqual([`cursor`, `composer-2.5`]);
    });

    /* NEW AGENT OPENS ON THE LATEST PICK EVEN WHEN IT OPENS NOTHING. A second press must not mint a twin of an
     * empty draft, so the one already open is handed back — carrying the picks that were remembered when it
     * happened to be created, which after any pick made since is a model the user never chose sitting under a
     * heading that says "New agent". Untouched, it is re-seeded, so what comes back is the chat a fresh one
     * would have been. */
    it(`re-seeds the empty draft New agent hands back, so it opens on the latest pick`, async () => {
        bothConnected();
        const chat = useChat();
        await loadAccountStatus();
        endpointsLoaded.value = true;
        await nextTick();

        const prepared = chat.active.value;
        prepared.draft.value = `first task`;
        prepared.selectModel({ provider: `claude`, value: `claude-opus-5` });

        // The empty draft the strip keeps, minted while Claude was the remembered pick.
        const empty = newChat();
        expect([empty.provider.value, empty.model.value]).toEqual([`claude`, `claude-opus-5`]);

        // A pick made since, in the OTHER chat (the focus stays on the empty draft, which would otherwise be
        // swept: the strip keeps at most one untouched draft, and only as the focused tab).
        prepared.selectModel({ provider: `cursor`, value: `composer-2.5` });

        const started = draftConversation();
        expect(started.conversationId).toBe(empty.conversationId);
        expect([started.provider.value, started.model.value]).toEqual([`cursor`, `composer-2.5`]);
    });

    /* ...AND EACH GOES BACK TO ITS OWN MODEL. Two drafts on two Claude models, both parked on Cursor by one
     * outage: the return used to re-read the provider's remembered model, so both came back on whichever had
     * been picked most recently. What was displaced is what is owed back. */
    it(`gives each displaced draft back the model it was moved off, not the provider's latest`, async () => {
        const chat = useChat();
        const opus = chat.active.value;
        opus.draft.value = `the opus task`;
        opus.selectModel({ provider: `claude`, value: `claude-opus-5` });

        const sonnet = newChat();
        sonnet.draft.value = `the sonnet task`;
        sonnet.selectModel({ provider: `claude`, value: `claude-sonnet-4-5-20250929` });

        mockConnections({ accounts: (path) => (path.startsWith(`/cursor`) ? [{ id: `cur`, label: `Cursor`, connectedAt: 0 }] : []) });
        await loadAccountStatus();
        endpointsLoaded.value = true;
        await nextTick();
        expect([opus.provider.value, sonnet.provider.value]).toEqual([`cursor`, `cursor`]);

        bothConnected();
        await refreshConnections(true);
        await nextTick();
        expect(opus.model.value).toBe(`claude-opus-5`);
        expect(sonnet.model.value).toBe(`claude-sonnet-4-5-20250929`);
    });

    /* A chat can be BORN on a substitute: a new chat opened while the remembered provider is down is seeded with
     * one that can send (rememberedProviderFor resolves the pick without writing over it). That is the same
     * displacement the pass above makes, noticed a moment earlier, so it is owed the same return. */
    it(`returns a chat that OPENED on a substitute once its own provider is back`, async () => {
        const chat = useChat();
        chat.active.value.selectModel({ provider: `claude`, value: `claude-opus-5` });
        mockConnections({ accounts: (path) => (path.startsWith(`/cursor`) ? [{ id: `cur`, label: `Cursor`, connectedAt: 0 }] : []) });
        await loadAccountStatus();
        endpointsLoaded.value = true;
        await nextTick();

        // Opened during the outage: Claude is the pick, Cursor is what can answer.
        const born = newChat();
        born.draft.value = `written during the outage`;
        expect(born.provider.value).toBe(`cursor`);

        bothConnected();
        await refreshConnections(true);
        await nextTick();
        expect([born.provider.value, born.model.value]).toEqual([`claude`, `claude-opus-5`]);
    });
});
