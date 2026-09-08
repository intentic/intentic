import { STATE_DIR } from "@intentic/constants";
import { sandboxRouteName, TRIAL_PROVIDER } from "@intentic/sandbox-contract";
import { nextTick } from "vue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../sandbox/client/sandboxClient", () => {
    const sandboxRequest = vi.fn();
    const sandboxJson = vi.fn();
    return {
        sandboxRequest,
        sandboxJson,
        // sandboxRequestVia delegates to the same spies (`at` is always the active box in these tests).
        sandboxRequestVia: (_at: string | undefined, path: string, init?: RequestInit) =>
            init === undefined ? sandboxRequest(path) : sandboxRequest(path, init),
        sandboxJsonVia: (_at: string | undefined, path: string, init?: RequestInit) =>
            init === undefined ? sandboxJson(path) : sandboxJson(path, init),
        sandboxError: vi.fn(async (response: Response) => {
            const body = (await response.json()) as { message?: string; error?: string };
            return new Error(body.message ?? body.error ?? `Request failed (${response.status}).`);
        }),
    };
});
// Avoids the window.env chain; send() only needs track() mocked.
vi.mock("../../../app/analytics", () => ({ track: vi.fn() }));
// Avoids the window.env chain; tab persistence only reads activeSandboxId + reachable.
vi.mock("../../sandbox/client/useSandbox", async () => {
    const { ref } = await import("vue");
    const activeSandboxId = ref<string | undefined>(`sb1`);
    const reachable = ref(false);
    // sandboxKey included: hydrate's transcript cache read is keyed by sandbox, and needs it defined.
    return { useSandbox: () => ({ activeSandboxId, reachable }), sandboxKey: (...parts: unknown[]) => [...parts, activeSandboxId] };
});

// Node has neither storage; tab snapshots need both (session for a window's tabs, local as the seed for a fresh one).
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

const { sandboxJson, sandboxRequest } = await import("../../sandbox/client/sandboxClient");
const { queryClient } = await import("../../../lib/queryPersistence");
const sandboxRequestMock = vi.mocked(sandboxRequest);
const sandboxJsonMock = vi.mocked(sandboxJson);

// Both connection reads go through sandboxJson; a real failure throws rather than resolving empty (see
// refreshAccounts). `accounts` is keyed by the provider route prefix.
type Subscriptions = { codex: unknown[]; grok: unknown[]; kimi: unknown[]; gemini: unknown[] };
const NO_SUBSCRIPTIONS: Subscriptions = { codex: [], grok: [], kimi: [], gemini: [] };
const mockConnections = (connections: { subscriptions?: Subscriptions; accounts?: (path: string) => unknown[] } = {}): void => {
    sandboxJsonMock.mockImplementation((path: string) =>
        Promise.resolve(
            path === `/translator/accounts` ? (connections.subscriptions ?? NO_SUBSCRIPTIONS) : { accounts: connections.accounts?.(path) ?? [] },
        ),
    );
};
const { useSandbox } = await import("../../sandbox/client/useSandbox");
const { setDaemonRoutes } = await import("../../sandbox/overview/useDaemonRoutes");
const { resetChat, useChat } = await import("./useChat");
const { agentTabOf, draftConversation, openAgentConversation, reveal } = await import("../panel/useChat-reveal");
const { hydrateOnce } = await import("./useChat-sessions");
const { loadAccountStatus, providerBase, refreshConnections } = await import("../accounts/useChat-accounts");
// The store half of "New agent", as the summons applies it (agentActions.startAgent): the fixture these
// suites open extra tabs with.
const newChat = () => {
    const conversation = draftConversation();
    reveal({ verb: `show`, entries: [conversation], focus: conversation.conversationId, caret: false });
    return conversation;
};

const { closedDrafts } = await import("../drafts/closedDrafts");
// Asserts what tabFacts (the strip's own reading) reports, not an internal flag.
const { tabFacts, unasked } = await import("../tabs/tabFacts");
const { selectedAccountId, usageByAccount } = await import("../accounts/providerAccounts");
const { Conversation } = await import("../session/conversation");
const { endpointProviders, endpointsLoaded, trialStatus } = await import("../accounts/providerCatalog");
const { turnDefaults } = await import("./turnDefaults");

beforeEach(() => {
    // Default: nothing to say unless a test overrides it. Resolving keeps a stray background read from surfacing as an
    // unhandled rejection.
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
    // Transcript cache persists across tests; ids get reused with different mocks, so it must clear too.
    queryClient.clear();
});

describe(`useChat provider reconciliation`, () => {
    it(`points a GPT-only user's chat at Codex (served by the translator subscription) instead of gating on Claude`, async () => {
        const chat = useChat();
        expect(chat.provider.value).toBe(`claude`);
        expect(chat.connected.value).toBe(false);

        mockConnections({ subscriptions: { codex: [{ name: `codex-user.json`, label: `user@example.com` }], grok: [], kimi: [], gemini: [] } });
        await loadAccountStatus();
        await nextTick();

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
        mockConnections({ accounts: (path) => (path.startsWith(`/accounts/grok`) ? [{ id: `xai`, label: `Grok`, connectedAt: 0 }] : []) });
        await loadAccountStatus();
        await nextTick();

        chat.selectProvider(`grok`);
        expect(chat.connected.value).toBe(true);
        chat.active.value.selectHarness(`claude-code`);
        expect(chat.connected.value).toBe(false);

        mockConnections({
            accounts: (path) => (path.startsWith(`/accounts/grok`) ? [{ id: `xai`, label: `Grok`, connectedAt: 0 }] : []),
            subscriptions: { codex: [], grok: [{ name: `xai-user.json`, label: `user@x.ai` }], kimi: [], gemini: [] },
        });
        await loadAccountStatus();
        expect(chat.connected.value).toBe(true);
    });

    it(`keeps a Claude user on Claude when the ChatGPT subscription answers first`, async () => {
        storage.clear();
        turnDefaults.provider.value = `claude`;
        resetChat();
        const chat = useChat();
        chat.active.value.selectModel({ provider: `claude`, value: `claude-opus-5` });

        sandboxJsonMock.mockImplementation((path: string) => {
            if (path === `/translator/accounts`) {
                return Promise.resolve({ codex: [{ name: `codex-user.json`, label: `user@example.com` }], grok: [], kimi: [], gemini: [] });
            }
            if (path.startsWith(`/accounts/claude`)) {
                return new Promise((resolve) => setTimeout(() => resolve({ accounts: [{ id: `a1`, label: `Personal`, connectedAt: 0 }] }), 20));
            }
            return Promise.resolve({ accounts: [] });
        });

        await loadAccountStatus();
        await nextTick();

        expect(chat.provider.value).toBe(`claude`);
        expect(chat.model.value).toBe(`claude-opus-5`);
    });

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

    it(`returns an untouched trial fallback to Google once the connected account becomes available`, async () => {
        storage.clear();
        turnDefaults.provider.value = `gemini`;
        resetChat();
        const chat = useChat();

        // Account and trial reads land independently; the repoint pass waits for both (access.accessKnown).
        mockConnections();
        await refreshConnections(true);
        endpointProviders.value = [{ id: TRIAL_PROVIDER, label: `Free trial`, kind: `endpoint` }];
        endpointsLoaded.value = true;
        trialStatus.value = { available: true, allowance: 12, used: 0, remaining: 12, health: `healthy` };
        await nextTick();
        expect(chat.provider.value).toBe(TRIAL_PROVIDER);

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

    it(`seeds the usage map from the persisted snapshots on the account list`, async () => {
        mockConnections({
            accounts: (path) =>
                path.startsWith(`/accounts/claude`)
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
        // Absent, not zero: an account with no persisted reading has no entry at all.
        expect(usageByAccount.value[`claude:a2`]).toBeUndefined();
    });

    it(`keeps a live streamed reading when the persisted one is older`, async () => {
        usageByAccount.value = { "claude:a1": { windows: [{ kind: `seven_day`, utilization: 80, gates: `all` }], measuredAt: 9_000 } };
        mockConnections({
            accounts: (path) =>
                path.startsWith(`/accounts/claude`)
                    ? [
                          {
                              id: `a1`,
                              label: `Personal`,
                              connectedAt: 0,
                              usage: { windows: [{ kind: `seven_day`, utilization: 30, gates: `all` }], measuredAt: 500 },
                          },
                      ]
                    : [],
        });
        await loadAccountStatus();

        expect(usageByAccount.value[`claude:a1`]).toMatchObject({
            windows: [{ kind: `seven_day`, utilization: 80, gates: `all` }],
            measuredAt: 9_000,
        });
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

        expect(sandboxRequestMock).toHaveBeenCalledWith(`/accounts/cursor/login/start`, expect.objectContaining({ method: `POST` }));
        expect(chat.error.value).toBe(daemonMessage);
        expect(chat.accountBusy.value).toBeUndefined();
    });

    /* THE CARD FOLLOWS THE CHAT ONLY ONTO A PROVIDER IT CAN CONNECT, which a fresh sandbox is the whole reason
     * for: with nothing connected the first chat is parked on the free trial, and the card, pointed there on
     * open, drew an empty "endpoint/free-trial account · not connected" row with a Connect beside it. */
    it(`keeps the account card on a connectable provider while the chat runs on the free trial`, async () => {
        const chat = useChat();
        await refreshConnections(true);
        endpointProviders.value = [{ id: TRIAL_PROVIDER, label: `Free trial`, kind: `endpoint` }];
        endpointsLoaded.value = true;
        trialStatus.value = { available: true, allowance: 12, used: 0, remaining: 12, health: `healthy` };
        await nextTick();
        expect(chat.provider.value).toBe(TRIAL_PROVIDER);

        chat.showActiveProvider();

        expect(chat.managedProvider.value).toBe(turnDefaults.provider.value);
        expect(chat.managedProvider.value).not.toBe(TRIAL_PROVIDER);
    });

    // The other way in: the picker writes whatever provider was chosen, the trial included, and a sandbox
    // switch re-seeds the card from that pick.
    it(`does not seed the account card from a remembered pick that has no sign-in`, () => {
        const chat = useChat();
        chat.setManagedProvider(`cursor`);
        turnDefaults.provider.value = TRIAL_PROVIDER;

        resetChat();

        expect(chat.managedProvider.value).toBe(`cursor`);
    });

    /* AND A CALL THAT IS MADE STAYS ON ITS ROUTE. A provider id is an open vocabulary and some carry a slash;
     * interpolated raw, that id adds a path SEGMENT, `{provider}` matches exactly one, and the request matched
     * no route at all — a bare 404 the app could only report as "Request failed (404)", since there was no
     * daemon sentence in it to quote. Encoded, the same call is refused in the daemon's own words. */
    it(`keeps an account route on its route for a provider id carrying a slash`, () => {
        expect(providerBase(TRIAL_PROVIDER)).toBe(`/accounts/${encodeURIComponent(TRIAL_PROVIDER)}`);
        expect(sandboxRouteName(`POST`, `${providerBase(TRIAL_PROVIDER)}/login/start`)).toBe(`accounts.start`);
        // The ids that carry no slash are untouched, which is what the Cursor call above still asserts verbatim.
        expect(providerBase(`claude`)).toBe(`/accounts/claude`);
    });
});

// Account choice persists per sandbox (ids name credential files in one sandbox's store); an already-open chat keeps
// the account it ran on.
describe(`the remembered account`, () => {
    const TWO = (path: string): unknown[] =>
        path.startsWith(`/accounts/claude`)
            ? [
                  { id: `first`, label: `Claude`, connectedAt: 1 },
                  { id: `second`, label: `Claude`, connectedAt: 2 },
              ]
            : [];

    // A page load, as the singleton sees it: re-reads its own stores, then the daemon answers.
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

        newChat();
        expect(chat.account.value).toBe(`second`);
    });

    it(`holds the pick through the window where the daemon hasn't answered yet`, async () => {
        const chat = useChat();
        chat.selectAccount(`second`);
        await nextTick();

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

        await nextTick();
        mockConnections({ accounts: (path) => (path.startsWith(`/accounts/claude`) ? [{ id: `first`, label: `Claude`, connectedAt: 1 }] : []) });
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
        expect(chat.account.value).toBeUndefined();

        activeSandboxId.value = `sb1`;
        await reload();
        expect(chat.account.value).toBe(`second`);
    });

    it(`survives an account read that comes back EMPTY: a list is not a verdict on the user's choice`, async () => {
        const chat = useChat();
        chat.selectAccount(`second`);
        await nextTick();

        mockConnections({ accounts: () => [] });
        resetChat();
        await loadAccountStatus();
        expect(chat.account.value).toBe(`second`);

        mockConnections({ accounts: TWO });
        resetChat();
        await loadAccountStatus();
        expect(chat.account.value).toBe(`second`);
        chat.draft.value = `this tab is in use`;
        newChat();
        expect(chat.account.value).toBe(`second`);
    });

    it(`moves an open chat off a pick the list no longer has, and still remembers the pick`, async () => {
        const chat = useChat();
        chat.selectAccount(`second`);
        await nextTick();

        mockConnections({ accounts: (path) => (path.startsWith(`/accounts/claude`) ? [{ id: `first`, label: `Claude`, connectedAt: 1 }] : []) });
        resetChat();
        await loadAccountStatus();
        expect(chat.account.value).toBe(`first`);

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
        expect(chat.active.value).toBe(tabs[1]);
    });

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

    it(`stamps a composer the first time it holds something unsent, and clears it when that goes`, async () => {
        const clock = vi.spyOn(Date, `now`).mockReturnValue(1_000);
        try {
            const chat = useChat();
            expect(chat.active.value.draftAt.value).toBeUndefined();

            chat.draft.value = `half a sentence`;
            await nextTick();
            expect(chat.active.value.draftAt.value).toBe(1_000);

            // Stamp doesn't move as the draft grows; a moving stamp would also churn draftEcho's publish key.
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

// Composer pills (model/effort/thinking) belong to the chat they sit under. turnDefaults seeds a new conversation only;
// it never re-seeds an open one.
describe(`per-tab turn settings`, () => {
    beforeEach(() => {
        storage.clear();
        resetChat();
    });

    it(`gives each tab back the settings it was showing, not the last pick made anywhere`, async () => {
        const chat = useChat();
        chat.draft.value = `keep me`; // Content, so the focus-leave sweep doesn't reap this draft.
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

    // `max` effort requires thinking on; restore clamps invalid pairs the same way the constructor does.
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

// Tab set belongs to the window it's open in (the daemon multiplexes per connection). Last-writer-wins on a shared key
// would leak one window's tabs into another's.
describe(`tab snapshots across windows and sandboxes`, () => {
    // Simulates what another window would write: a snapshot naming conversations by id; each tab carries composer text
    // so it counts as real, not an untouched draft.
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
        chat.draft.value = `keep me`; // Content, so the sweep doesn't reap this tab when focus moves to `closed`.
        const closed = newChat().conversationId;
        await nextTick();

        chat.closeTabs(new Set([closed]));
        await nextTick();

        // The other window is still on the pre-close set and persists it on its next change.
        local.set(`intentic.chatTabs.sb1`, foreignSnapshot(closed, [kept, closed]));

        resetChat(); // A reload (live-reload's or the user's).
        expect(chat.conversations.value.map((conversation) => conversation.conversationId)).toEqual([kept]);
    });

    it(`seeds a window with no tabs of its own from the last session's snapshot`, () => {
        session.clear();
        local.set(`intentic.chatTabs.sb1`, foreignSnapshot(`conv-b`, [`conv-a`, `conv-b`]));

        resetChat();
        const chat = useChat();
        expect(chat.conversations.value.map((conversation) => conversation.conversationId)).toEqual([`conv-a`, `conv-b`]);
        expect(chat.activeId.value).toBe(`conv-b`);
    });

    // The one-untouched-draft rule holds across a restore too: an empty isolated tab not holding focus doesn't come
    // back.
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

    // activeSandboxId flips a beat before sandboxScope's watch re-scopes the chat; anything written in between must
    // persist under the outgoing sandbox's key.
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

// All strip close actions (the tab x, Close Others/Right/All) land here. Invariant: the strip is never empty, and focus
// moves only when the focused tab is among those closed.
describe(`closing tabs`, () => {
    beforeEach(() => {
        storage.clear();
        resetChat();
    });

    // Four tabs, third active, each holding text so an untouched draft doesn't collapse them into one (setConversations
    // allows only one).
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
        expect(chat.activeId.value).toBe(ids[2]);
    });

    it(`closes every other tab and moves focus to the survivor`, () => {
        const chat = useChat();
        const ids = openFour();
        // Simulates Close Others from a right-click on the first tab, not the active one.
        chat.closeTabs(new Set([ids[1]!, ids[2]!, ids[3]!]));

        expect(chat.conversations.value.map((c) => c.conversationId)).toEqual([ids[0]]);
        expect(chat.activeId.value).toBe(ids[0]);
    });

    it(`closes the tabs to the right of the right-clicked one`, () => {
        const chat = useChat();
        const ids = openFour();

        chat.closeTabs(new Set([ids[2]!, ids[3]!])); // to the right of the second tab

        expect(chat.conversations.value.map((c) => c.conversationId)).toEqual([ids[0], ids[1]]);
        expect(chat.activeId.value).toBe(ids[1]);
    });

    // Focus returns to the tab held before this one, not the last in strip order (the rail sorts by lane).
    it(`hands the focus back to the most recently focused survivor when the focused tab closes`, () => {
        const chat = useChat();
        const ids = openFour(); // Focus history: visited in order, ending on the third.
        chat.setActive(ids[0]!);
        chat.setActive(ids[3]!);

        chat.closeTabs(new Set([ids[3]!]));

        expect(chat.activeId.value).toBe(ids[0]);
    });

    it(`replaces the strip with one fresh conversation when everything closes`, () => {
        const chat = useChat();
        const ids = openFour();

        chat.closeTabs(new Set(ids));

        expect(chat.conversations.value).toHaveLength(1);
        expect(chat.conversations.value[0]!.conversationId).not.toBeOneOf([...ids]);
        expect(chat.activeId.value).toBe(chat.conversations.value[0]!.conversationId);
        expect(chat.draft.value).toBe(``);
    });

    // A closed tab's unsent text exists nowhere else, so it's set aside in closedDrafts; the board keeps a card for it
    // and reopening restores the words.
    it(`sets a closing chat's unsent message aside, and puts it back when the chat is opened again`, async () => {
        const chat = useChat();
        const ids = openFour();
        const closing = chat.conversations.value.find((c) => c.conversationId === ids[1]!)!;
        closing.draft.value = `the half-written message`;
        await nextTick(); // the stamp that dates the message (the unsent-edge watch)

        chat.closeTabs(new Set([ids[1]!]));

        expect(chat.conversations.value.map((c) => c.conversationId)).toEqual([ids[0], ids[2], ids[3]]);
        expect(closedDrafts.value.find((tab) => tab.conversationId === ids[1]!)?.draft).toBe(`the half-written message`);

        const back = openAgentConversation({ id: ids[1]!, provider: `claude`, harness: `native`, registered: false });

        expect(back.draft.value).toBe(`the half-written message`);
        expect(back.draftAt.value).toBeGreaterThan(0);
        // Removed, not copied: a leftover copy in closedDrafts would go stale on the board.
        expect(closedDrafts.value.some((tab) => tab.conversationId === ids[1]!)).toBe(false);
    });

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

    it(`ignores a click on a tab that is no longer open`, () => {
        const chat = useChat();
        const ids = openFour();
        chat.closeTabs(new Set([ids[0]!]));

        chat.setActive(ids[0]!);

        expect(chat.activeId.value).toBe(ids[2]);
        expect(chat.active.value.conversationId).toBe(ids[2]);
    });
});

// An untouched New agent tab (no text/attachment/queue/turn/name) exists only while focused; anything in it makes it
// real. Enforced synchronously in setConversations, not by a later reaper.
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

    // Caret still moves even though the tab is reused; startAgent asks for it regardless.
    it(`hands back the untouched draft already open instead of minting a second`, () => {
        const chat = useChat();
        chat.draft.value = `real work`;
        const first = newChat();

        const again = newChat();

        expect(again).toBe(first);
        expect(chat.conversations.value).toHaveLength(2);
        expect(chat.activeId.value).toBe(first.conversationId);
    });

    it(`focuses an untouched draft the press finds on another tab`, () => {
        const chat = useChat();
        const first = chat.active.value.conversationId;
        chat.draft.value = `real work`;
        const draft = newChat();
        // A conversation opened alongside it (fleet card, history row) takes focus but not the draft.
        const opened = openAgentConversation({ id: `agent-1`, provider: `claude`, harness: `native`, title: `Someone else's work` });
        expect(chat.conversations.value.map((c) => c.conversationId)).toEqual([first, opened.conversationId]);

        const pressed = newChat();

        expect(pressed).not.toBe(draft);
        expect(chat.activeId.value).toBe(pressed.conversationId);
    });

    // chatStrip answers from whichever window draws the chat: this window's own state while docked, the popped-out
    // window's echo while it isn't, never a blend.
    it(`answers for the strip from whichever window draws the chat`, async () => {
        const { chatStrip } = await import("../panel/useChat-strip");
        const { receiveChatNote } = await import("./chatChannel");
        const { receiveFloatingNote } = await import("../../../shell/window/floating");
        const chat = useChat();
        const own = chat.active.value.conversationId;
        chat.draft.value = `real work`;
        await nextTick();

        expect(chatStrip.value.active).toBe(own);
        expect(chatStrip.value.tabs.map((tab) => ({ id: tab.id, unsent: tab.unsent, preview: tab.preview }))).toEqual([
            { id: own, unsent: true, preview: `real work` },
        ]);

        receiveFloatingNote({ kind: `here`, panel: `chat`, id: `w1`, since: 1 });
        receiveChatNote({
            sandbox: `sb1`,
            note: {
                kind: `strip`,
                strip: {
                    active: `far`,
                    panes: [`far`],
                    tabs: [
                        {
                            id: `far`,
                            registered: false,
                            standing: `draft`,
                            peek: false,
                            standIn: false,
                            provider: `claude`,
                            harness: `native`,
                            model: ``,
                            unsent: true,
                            preview: `half a thought`,
                        },
                    ],
                },
            },
        });
        expect(chatStrip.value.active).toBe(`far`);
        expect(chatStrip.value.tabs.map((tab) => tab.id)).toEqual([`far`]);

        receiveFloatingNote({ kind: `gone`, panel: `chat`, id: `w1` });
        expect(chatStrip.value.active).toBe(own);
    });

    // A window not drawing the chat can't tell its shadow copy is empty vs. being typed into elsewhere, so it mints
    // fresh instead of reusing the shadow.
    it(`mints a fresh draft from a window that is not drawing the chat: its copy cannot tell empty from being typed into`, async () => {
        const { receiveFloatingNote } = await import("../../../shell/window/floating");
        const chat = useChat();
        chat.draft.value = `real work`;
        const shadow = newChat();
        expect(draftConversation()).toBe(shadow);

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

// Conversation.peek: a look opened by a plain click (fleet card/history row); swept when focus moves on unless the
// reader claims it.
describe(`chats opened for a look`, () => {
    beforeEach(async () => {
        storage.clear();
        resetChat();
        await nextTick();
    });

    // The board's plain click, as every window's summons applies it (useAgents.open with `peek`).
    const peekAgent = (id: string) =>
        reveal({
            verb: `show`,
            entries: [agentTabOf({ id, provider: `claude`, harness: `native`, title: `Agent ${id}` })],
            focus: id,
            caret: false,
            peek: true,
        })!;

    // First tab, holding text so the focus-leave sweep has no claim on it.
    const working = (): string => {
        const chat = useChat();
        chat.draft.value = `real work`;
        return chat.active.value.conversationId;
    };

    it(`sweeps the looked-at chat when the next card takes the focus`, () => {
        const chat = useChat();
        const first = working();
        peekAgent(`agent-a`);

        peekAgent(`agent-b`);

        expect(chat.conversations.value.map((conversation) => conversation.conversationId)).toEqual([first, `agent-b`]);
        expect(chat.activeId.value).toBe(`agent-b`);
    });

    it(`keeps it the moment words land in its composer`, async () => {
        const chat = useChat();
        const first = working();
        const looked = peekAgent(`agent-a`);

        looked.draft.value = `while I'm here`;
        await nextTick();

        expect(looked.peek.value).toBe(false);
        chat.setActive(first);
        expect(chat.conversations.value.map((conversation) => conversation.conversationId)).toEqual([first, `agent-a`]);
    });

    it(`keeps it when a pick is made in it: acting on a chat is not looking at one`, () => {
        const chat = useChat();
        const first = working();
        const looked = peekAgent(`agent-a`);

        looked.selectModel({ provider: `claude`, value: `claude-sonnet-4-5` });

        expect(looked.peek.value).toBe(false);
        chat.setActive(first);
        expect(chat.conversations.value.map((conversation) => conversation.conversationId)).toEqual([first, `agent-a`]);
    });

    // Same verb behind the card's pin and the right-click's Keep Open row (summon.ts's `keep`).
    it(`keeps it when the pin is pressed`, () => {
        const chat = useChat();
        const first = working();
        peekAgent(`agent-a`);

        chat.keepChat(`agent-a`);

        chat.setActive(first);
        expect(chat.conversations.value.map((conversation) => conversation.conversationId)).toEqual([first, `agent-a`]);
    });

    it(`keeps it when it is given a column of its own`, () => {
        const chat = useChat();
        const first = working();
        const looked = peekAgent(`agent-a`);

        chat.openBeside(`agent-a`);

        expect(looked.peek.value).toBe(false);
        chat.setActive(first);
        expect(chat.conversations.value.map((conversation) => conversation.conversationId)).toEqual([first, `agent-a`]);
    });

    it(`leaves a kept chat kept, however often it is looked at`, () => {
        const chat = useChat();
        const first = working();
        const opened = openAgentConversation({ id: `agent-a`, provider: `claude`, harness: `native`, title: `Someone's work` });

        peekAgent(`agent-a`);

        expect(opened.peek.value).toBe(false);
        chat.setActive(first);
        expect(chat.conversations.value.map((conversation) => conversation.conversationId)).toEqual([first, `agent-a`]);
    });

    // Same snapshot a reload uses (useChat-tabs): the peek flag rides along when the panel moves windows.
    it(`carries the mark through the snapshot the panel is handed off with`, async () => {
        const chat = useChat();
        const first = working();
        peekAgent(`agent-a`);
        await nextTick();

        resetChat();

        expect(chat.conversations.value.map((conversation) => conversation.conversationId)).toEqual([first, `agent-a`]);
        expect(chat.active.value.peek.value).toBe(true);
    });
});

// Conversation.standIn: the empty composer a panel always shows when nothing else is open.
describe(`the blank left when the last chat closes`, () => {
    beforeEach(async () => {
        storage.clear();
        resetChat();
        await nextTick();
    });

    it(`is what a window with no tabs to restore opens on`, () => {
        expect(unasked(tabFacts(useChat().active.value))).toBe(true);
    });

    it(`is what a close that takes the last card leaves behind`, () => {
        const chat = useChat();
        // Opens a kept chat first so the initial blank is swept, making this close genuinely the last card.
        const kept = openAgentConversation({ id: `agent-a`, provider: `claude`, harness: `native`, title: `Someone's work` });

        chat.closeTabs(new Set([kept.conversationId]));

        const left = chat.active.value;
        expect(chat.conversations.value.map((conversation) => conversation.conversationId)).toEqual([left.conversationId]);
        expect(left.conversationId).not.toBe(kept.conversationId);
        expect(unasked(tabFacts(left))).toBe(true);
    });

    it(`stops being one the moment something is typed in it`, async () => {
        const blank = useChat().active.value;

        blank.draft.value = `fix the login redirect`;
        await nextTick();

        expect(unasked(tabFacts(blank))).toBe(false);
    });

    it(`becomes a chat the user started when New agent is pressed on it`, () => {
        const blank = useChat().active.value;

        expect(draftConversation().conversationId).toBe(blank.conversationId);
        expect(unasked(tabFacts(blank))).toBe(false);
    });

    it(`comes back a blank through the snapshot the panel is handed off with`, async () => {
        const chat = useChat();
        const blank = chat.active.value.conversationId;
        await nextTick();

        resetChat();

        expect(chat.conversations.value.map((conversation) => conversation.conversationId)).toEqual([blank]);
        expect(unasked(tabFacts(chat.active.value))).toBe(true);
    });
});

// Opens by durable conversation/worktree identity, not session id. No provider gate: the daemon records what it
// streams, so every provider's session is readable the same way.
// What each fixture agent's session is bound to, keyed by conversation id to mirror the route.
const SESSION_BINDINGS: Record<string, { provider: string; harness: string; account?: string }> = {
    a1: { provider: `gemini`, harness: `native`, account: `acct-work` },
    a2: { provider: `codex`, harness: `claude-code`, account: `acct-work` },
    a3: { provider: `codex`, harness: `native`, account: `acct-work` },
    a4: { provider: `claude`, harness: `native`, account: `acct-work` },
    // The chat somebody switched accounts in: minted on `acct-work`, regardless of the tab's own pick.
    a6: { provider: `claude`, harness: `native`, account: `acct-work` },
};

describe(`opening a fleet agent`, () => {
    beforeEach(() => {
        storage.clear();
        resetChat();
        // No run in flight: the attach probe stands down and the stored transcript paints.
        sandboxRequestMock.mockImplementation((path: string) => {
            if (path.endsWith(`/transcript`)) {
                const agent = path.split(`/`)[2] ?? ``;
                return Promise.resolve({
                    ok: true,
                    json: () =>
                        Promise.resolve({
                            sessionId: `current-sdk-session`,
                            // Session binding rides with the id; taken as given, not filled from the tab.
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

    it(`opens on the settings the agent ran with, leaving the tab that made the picks alone`, () => {
        const chat = useChat();
        chat.draft.value = `mine`; // Content, so this tab survives losing the focus to the agent.
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

    it(`replays a NATIVE Codex agent: the daemon holds what it streamed, whatever ran the turn`, async () => {
        const conversation = openAgentConversation({ id: `a3`, sessionId: `sess-n`, provider: `codex`, harness: `native` });

        await vi.waitFor(() => expect(conversation.messages.value).toHaveLength(2));
        expect(sandboxRequestMock).toHaveBeenCalledWith(`/agents/a3/transcript`);
    });

    // A tab's account pick and its session's account can differ, most commonly after switching accounts mid-chat (e.g.
    // following a spent allowance).
    // An unpinned tab takes the account the daemon says served the session (Conversation.bindSession), so the picker
    // and the chip agree and the next send can resume.
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

        // Back onto the account that holds the session: nothing is retired, so there is nothing to announce.
        conversation.selectAccount(`acct-work`);
        expect(conversation.messages.value.some((message) => message.role === `notice`)).toBe(false);

        // Away from it again: that genuinely costs a fresh session, so it says so.
        conversation.selectAccount(`acct-personal`);
        expect(conversation.messages.value.some((message) => message.role === `notice` && message.text.startsWith(`Switched to Claude`))).toBe(true);
    });
});

// `registered` outlives an archive or a dropped roster; it must not outlive the daemon truly discarding the entry, or
// the tab becomes an unreachable ghost draft.
describe(`a tab whose agent the fleet no longer has`, () => {
    beforeEach(() => {
        storage.clear();
        resetChat();
        // 404 on this exact id, unlike an archive (entry kept) or an unreachable daemon (throw).
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
        // Simulates an older daemon lacking the route; must not be read as the agent being gone.
        setDaemonRoutes([`agents.list`]);
        const stale = openAgentConversation({ id: `still-there`, provider: `claude`, harness: `claude-code` });

        await vi.waitFor(() => expect(sandboxRequestMock).toHaveBeenCalledWith(`/agents/still-there/transcript`));
        await nextTick();

        expect(stale.registered.value).toBe(true);
        setDaemonRoutes(undefined);
    });
});

// Claude's API rejects `max` effort with thinking off (a 400 surfaced only as `unknown`). Both fields persist into
// turnDefaults, so the toggle is where the pair gets repaired.
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

// Which open chats are on screen, and in which columns (ChatPanel renders one pane per id). Switching is not opening:
// everything that moves focus swaps the focused column and leaves the rest.
describe(`chat panes`, () => {
    beforeEach(() => {
        storage.clear();
        resetChat();
    });

    // Three tabs with content, so none is the untouched draft the strip would reap; the first is focused.
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

        expect(chat.panes.value).toEqual([ids[0], ids[2]]);
        expect(chat.activeId.value).toBe(ids[2]);
    });

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
        expect(chat.conversations.value.map((c) => c.conversationId)).toEqual(ids);
        expect(chat.activeId.value).toBe(ids[0]);
    });

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

    // Keeps the focused chat, since the click already moved focus there; every other pane's column is given back,
    // nothing closed.
    it(`collapses to the focused chat alone`, () => {
        const chat = useChat();
        const ids = openThree();
        chat.openBeside(ids[1]!);
        chat.openBeside(ids[2]!); // panes [0, 1, 2], focus on 2

        chat.setActive(ids[0]!); // the plain click: focus moves, the columns are still up
        chat.collapsePanes();

        expect(chat.panes.value).toEqual([ids[0]]);
        expect(chat.activeId.value).toBe(ids[0]);
        expect(chat.conversations.value.map((c) => c.conversationId)).toEqual(ids);
    });

    it(`leaves a single pane alone`, () => {
        const chat = useChat();
        const ids = openThree();

        chat.collapsePanes();

        expect(chat.panes.value).toEqual([ids[0]]);
    });

    // A multi-selection is a set: chats already on screen keep their columns; pane order is insertion order, not the
    // rail's.
    it(`keeps existing columns and appends the newcomers when a selection lands`, () => {
        const chat = useChat();
        const ids = openThree();
        chat.openBeside(ids[2]!); // panes [0, 2]

        chat.setPanes([ids[2]!, ids[1]!, ids[0]!]); // the same three, named in a different order

        expect(chat.panes.value).toEqual([ids[0], ids[2], ids[1]]);
    });

    // Claim the column before opening the chat, or opening would take the focused pane's column first.
    it(`keeps the chat being read when a not-yet-open chat claims a column first`, () => {
        const chat = useChat();
        const ids = openThree();
        const arriving = `agent-from-the-board`;

        chat.openBeside(arriving);
        openAgentConversation({ id: arriving, provider: `claude`, harness: `native` });

        expect(chat.panes.value).toEqual([ids[0], arriving]);
        expect(chat.activeId.value).toBe(arriving);
    });

    it(`gives the whole panel to a new chat rather than one column of a split`, () => {
        const chat = useChat();
        const ids = openThree();
        chat.openBeside(ids[1]!);
        expect(chat.panes.value).toEqual([ids[0], ids[1]]);

        const fresh = newChat();

        expect(chat.panes.value).toEqual([fresh.conversationId]);
        expect(chat.activeId.value).toBe(fresh.conversationId);
        expect(chat.conversations.value.map((conversation) => conversation.conversationId)).toEqual([...ids, fresh.conversationId]);
    });

    it(`gives the whole panel back when New agent hands over the draft it already opened`, () => {
        const chat = useChat();
        const ids = openThree();
        const fresh = newChat();
        // Simulates a Shift-range on the rail, focus on the draft: its one way to survive a second pane.
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

// A running turn isn't in the daemon's record (only settled turns are); a record-based redraw must not overwrite it.
// Pinned below: hydration runs one pass at a time, and a replay stands down for a live turn.
describe(`hydrating a conversation whose turn is still running`, () => {
    const encoder = new TextEncoder();
    const sseFrame = (payload: unknown): Uint8Array => encoder.encode(`data: ${JSON.stringify(payload)}\n\n`);

    // The record: the turn before the live one, which is all a settling-time record can hold.
    const RECORDED = {
        sessionId: `sess-live`,
        messages: [
            { role: `user`, text: `reword the notice` },
            { role: `assistant`, text: `Reworded and verified.` },
        ],
    } as const;

    // A run parked on its plan card: head, one patch, no `end`; the stream stays open as long as the agent waits on the
    // user.
    const parkedRun = (): Response => {
        const body = new ReadableStream<Uint8Array>({
            start(controller) {
                controller.enqueue(
                    sseFrame({
                        kind: `attached`,
                        run: `r1`,
                        startedAt: 1000,
                        seq: 0,
                        rows: [{ role: `user`, text: `add the reconcile engine`, sentAt: 1000 }],
                    }),
                );
                controller.enqueue(
                    sseFrame({
                        kind: `patch`,
                        seq: 1,
                        patch: {
                            op: `append`,
                            row: { role: `assistant`, text: ``, plan: { requestId: `p1`, text: `# Reconcile engine\n\nStep 1`, status: `pending` } },
                        },
                    }),
                );
            },
        });
        return { ok: true, body } as Response;
    };

    // The typewriter and frame buffer drain via requestAnimationFrame; run it synchronously so a landed frame is
    // visible before an assertion reads the transcript.
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

    // A probe that finds the turn already owned elsewhere reports "not attached", not "nothing running"; the fallback
    // replay must not treat that as nothing running.
    it(`leaves a live turn alone when the stored replay lands after another stream engaged`, async () => {
        const conversation = useChat().active.value;
        // A tab with a transcript already on it: the record is only re-read on the fall-back path.
        conversation.registered.value = true;
        conversation.restoreMessages(RECORDED.messages);

        // Attaches first, resolves last: by then the stream below owns the turn, so this probe stands down.
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
        // Mock resolving isn't the redraw; that's a further microtask, so assert after both awaits.
        await new Promise((resolve) => setTimeout(resolve, 0));
        await nextTick();

        expect(conversation.streaming.value).toBe(true);
        expect(conversation.messages.value.map((message) => message.text)).toContain(`add the reconcile engine`);
        expect(conversation.messages.value.find((message) => message.plan !== undefined)?.plan?.status).toBe(`pending`);
    });
});

// pickUp used to arm only in the window that watched the turn stop; every other path got nothing. The daemon now
// records how the last turn ended (ending), and hydration adopts it.
describe(`opening a session whose last turn stopped short`, () => {
    const STOPPED = {
        sessionId: `sess-stopped`,
        ending: { reason: `stopped` },
        messages: [
            { role: `user`, text: `rewrite the reconcile engine` },
            { role: `assistant`, text: `Started on the reducer.` },
        ],
    } as const;

    // The record answers the transcript read; nothing is running, so the attach probe finds no turn.
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
        // `stopped` and nothing more: a bare record says the turn didn't finish and nothing else.
        await vi.waitFor(() => expect(conversation.pickUp.value).toEqual({ reason: `stopped` }));
    });

    // A spent-allowance ending is a wait, not a crash: the daemon holds the turn, so the offer must read as a held
    // re-run, not a fresh "Continue" message, and needs the reset instant.
    it(`offers the held re-run on a chat reopened after a spent allowance`, async () => {
        daemonReads({ ...STOPPED, ending: { reason: `limit`, resetsAt: 4_200, held: { ran: false } } });

        const conversation = openAgentConversation({ id: `spent-overnight`, provider: `claude`, harness: `native` });
        hydrateOnce(conversation);

        await vi.waitFor(() => expect(conversation.messages.value).toHaveLength(2));
        // Seconds on the wire, milliseconds here: pick-up compares every instant against Date.now().
        await vi.waitFor(() => expect(conversation.pickUp.value).toEqual({ reason: `limit`, readyAt: 4_200_000, held: { ran: false } }));
    });

    // An already-scheduled resume reads as a report, not an offer; `scheduled` without `resetsAt` must not become a
    // countdown to nothing.
    it(`counts down instead of offering when the daemon has already booked the resend`, async () => {
        daemonReads({ ...STOPPED, ending: { reason: `limit`, resetsAt: 9_000, held: { ran: true }, scheduled: true } });

        const conversation = openAgentConversation({ id: `booked-for-the-reset`, provider: `claude`, harness: `native` });
        hydrateOnce(conversation);

        await vi.waitFor(() => expect(conversation.messages.value).toHaveLength(2));
        await vi.waitFor(() =>
            expect(conversation.pickUp.value).toEqual({
                reason: `limit`,
                readyAt: 9_000_000,
                held: { ran: true },
                automatic: { at: 9_000_000 },
            }),
        );
    });

    it(`says nothing about a conversation whose last turn ended on its own`, async () => {
        daemonReads({ sessionId: `sess-done`, messages: STOPPED.messages });

        const conversation = openAgentConversation({ id: `finished-cleanly`, provider: `claude`, harness: `native` });
        hydrateOnce(conversation);

        await vi.waitFor(() => expect(conversation.messages.value).toHaveLength(2));
        expect(conversation.pickUp.value).toBeUndefined();
    });

    // A pickUp the stream already armed outranks the record: it knows the turn is held and the reset instant, which a
    // flattened `stopped` would lose.
    it(`keeps what the stream armed instead of flattening it to a bare stop`, async () => {
        daemonReads(STOPPED);

        const conversation = openAgentConversation({ id: `stopped-on-a-limit`, provider: `claude`, harness: `native` });
        const spent = { reason: `limit`, readyAt: 4_000, held: { ran: true } } as const;
        conversation.pickUp.value = spent;
        hydrateOnce(conversation);

        await vi.waitFor(() => expect(conversation.messages.value).toHaveLength(2));
        expect(conversation.pickUp.value).toEqual(spent);
    });

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

// The cut gesture is the transcript's; what tab the user lands in, what it holds, and whether anything ran live here.
describe(`forking at a cut`, () => {
    beforeEach(() => {
        storage.clear();
        resetChat();
        sandboxRequestMock.mockReset();
    });

    // Four bubbles, two of them prompts the daemon still holds a state for: a conversation reopened from history.
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

        expect(chat.conversations.value).toHaveLength(2);
        const fork = chat.active.value;
        expect(fork).not.toBe(source);
        expect(fork.messages.value.map((message) => message.text)).toEqual([`first`, `one`]);
        expect(fork.draft.value).toBe(`second`);
        expect(sandboxRequestMock).not.toHaveBeenCalled();
        expect(source.messages.value.map((message) => message.text)).toEqual([`first`, `one`, `second`, `two`]);
    });

    it(`forks the whole conversation with an empty composer`, () => {
        const chat = seed();

        chat.forkAt(4, `now`);

        const fork = chat.active.value;
        expect(fork.messages.value.map((message) => message.text)).toEqual([`first`, `one`, `second`, `two`]);
        expect(fork.draft.value).toBe(``);
    });

    it(`isolates a fork that asks for the files as they were`, () => {
        const chat = seed();
        chat.active.value.isolated.value = false;

        chat.forkAt(2, `then`);

        expect(chat.active.value.isolated.value).toBe(true);
    });

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

    it(`refuses a cut out of range`, () => {
        const chat = seed();

        chat.forkAt(9, `now`);
        expect(chat.conversations.value).toHaveLength(1);
    });

    // Turns above the cut are settled, so forking mid-turn is safe; moving files under a live agent is not, so that
    // combination is refused until the turn ends.
    it(`forks the chat while a turn runs, and refuses to move files under it`, () => {
        const chat = seed();
        chat.active.value.streaming.value = true;

        chat.forkAt(2, `then`);
        expect(chat.conversations.value).toHaveLength(1);

        chat.forkAt(2, `now`);
        expect(chat.conversations.value).toHaveLength(2);
    });
});

// Picking a model in one draft is a statement about that draft and the next new chat's default, never about other open
// drafts.
describe(`unsent drafts keep their own picks`, () => {
    beforeEach(() => {
        storage.clear();
        resetChat();
    });

    const bothConnected = (): void => {
        mockConnections({
            accounts: (path) =>
                path.startsWith(`/accounts/claude`) || path.startsWith(`/accounts/cursor`) ? [{ id: `a-${path.split(`/`)[2]}`, label: `Personal`, connectedAt: 0 }] : [],
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

        // A routine connection refresh (runs on a timer) must not drag the first draft onto the last pick.
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

    // Choosing a different model while staying on the same provider is still a pick; it must move the
    // remembered-provider pointer too, not just a provider switch.
    it(`opens a new agent on the last model picked, even when that pick kept the provider`, async () => {
        bothConnected();
        const chat = useChat();
        await loadAccountStatus();
        endpointsLoaded.value = true;
        await nextTick();

        const prepared = chat.active.value;
        prepared.draft.value = `first task`;
        prepared.selectModel({ provider: `cursor`, value: `composer-2.5` });

        // A second draft, switched to Claude: what leaves the remembered provider pointing elsewhere.
        const second = newChat();
        second.draft.value = `second task`;
        second.selectModel({ provider: `claude`, value: `claude-opus-5` });

        chat.setActive(prepared.conversationId);
        prepared.selectModel({ provider: `cursor`, value: `composer-2.5-fast` });
        await nextTick();

        const fresh = new Conversation();
        expect([fresh.provider.value, fresh.model.value]).toEqual([`cursor`, `composer-2.5-fast`]);
    });

    // A chat the app moved off an unreachable provider returns to its own provider once reachable again, not to
    // whatever was picked elsewhere meanwhile.
    it(`returns only the chat the app moved, and only to the provider it was moved off`, async () => {
        const chat = useChat();
        const stranded = chat.active.value;
        stranded.draft.value = `written while Claude was down`;
        stranded.selectModel({ provider: `claude`, value: `claude-opus-5` });

        const beside = newChat();
        beside.draft.value = `prepared on Cursor`;
        beside.selectModel({ provider: `cursor`, value: `composer-2.5` });

        // Only Cursor answers: the Claude draft cannot send, so the app parks it there.
        mockConnections({ accounts: (path) => (path.startsWith(`/accounts/cursor`) ? [{ id: `cur`, label: `Cursor`, connectedAt: 0 }] : []) });
        await loadAccountStatus();
        endpointsLoaded.value = true;
        await nextTick();
        expect(stranded.provider.value).toBe(`cursor`);
        expect([beside.provider.value, beside.model.value]).toEqual([`cursor`, `composer-2.5`]);

        bothConnected();
        await refreshConnections(true);
        await nextTick();
        expect([stranded.provider.value, stranded.model.value]).toEqual([`claude`, `claude-opus-5`]);
        expect([beside.provider.value, beside.model.value]).toEqual([`cursor`, `composer-2.5`]);
    });

    // New agent hands back an untouched draft rather than minting a twin, and re-seeds it from the latest pick so it
    // isn't stuck on stale defaults.
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

        // A pick made since, in the other chat; focus stays on the empty draft so it isn't swept meanwhile.
        prepared.selectModel({ provider: `cursor`, value: `composer-2.5` });

        const started = draftConversation();
        expect(started.conversationId).toBe(empty.conversationId);
        expect([started.provider.value, started.model.value]).toEqual([`cursor`, `composer-2.5`]);
    });

    // Two Claude drafts parked on Cursor by one outage each return to the model they were moved off, not the provider's
    // most-recently-picked one.
    it(`gives each displaced draft back the model it was moved off, not the provider's latest`, async () => {
        const chat = useChat();
        const opus = chat.active.value;
        opus.draft.value = `the opus task`;
        opus.selectModel({ provider: `claude`, value: `claude-opus-5` });

        const sonnet = newChat();
        sonnet.draft.value = `the sonnet task`;
        sonnet.selectModel({ provider: `claude`, value: `claude-sonnet-4-5-20250929` });

        mockConnections({ accounts: (path) => (path.startsWith(`/accounts/cursor`) ? [{ id: `cur`, label: `Cursor`, connectedAt: 0 }] : []) });
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

    // A chat opened while its own provider is down is born on a substitute (rememberedProviderFor); that's the same
    // displacement, owed the same return.
    it(`returns a chat that OPENED on a substitute once its own provider is back`, async () => {
        const chat = useChat();
        chat.active.value.selectModel({ provider: `claude`, value: `claude-opus-5` });
        mockConnections({ accounts: (path) => (path.startsWith(`/accounts/cursor`) ? [{ id: `cur`, label: `Cursor`, connectedAt: 0 }] : []) });
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
