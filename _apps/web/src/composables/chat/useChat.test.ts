import { nextTick } from "vue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../sandbox/sandboxClient", () => ({ sandboxRequest: vi.fn(), sandboxJson: vi.fn() }));
// The real router pulls the auth/environment chain, which needs window.env; the plan-preview watch only pushes.
vi.mock("../../router", () => ({ router: { push: vi.fn() } }));
// Same window.env chain via analytics; send() only fires a milestone event through track.
vi.mock("../analytics", () => ({ track: vi.fn() }));
// Same window.env chain via useApi; the tab persistence only reads activeSandboxId + reachable.
vi.mock("../sandbox/useSandbox", async () => {
    const { ref } = await import("vue");
    const activeSandboxId = ref<string | undefined>(`sb1`);
    const reachable = ref(false);
    return { useSandbox: () => ({ activeSandboxId, reachable }) };
});

// The node test environment has neither storage; the tab snapshot round-trips need both — sessionStorage is
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
const sandboxRequestMock = vi.mocked(sandboxRequest);
const sandboxJsonMock = vi.mocked(sandboxJson);
const { useSandbox } = await import("../sandbox/useSandbox");
const { loadAccountStatus, openAgentConversation, resetChat, useChat } = await import("./useChat");
const { usageStatusByAccount } = await import("./usageStatus");

afterEach(() => {
    vi.clearAllMocks();
});

describe(`useChat provider reconciliation`, () => {
    it(`points a GPT-only user's chat at Codex (served by the translator subscription) instead of gating on Claude`, async () => {
        const chat = useChat();
        // A fresh conversation defaults to Claude and reads as disconnected (the gate would show).
        expect(chat.provider.value).toBe(`claude`);
        expect(chat.connected.value).toBe(false);

        // No native accounts anywhere; only the ChatGPT subscription is connected in the translator.
        sandboxRequestMock.mockImplementation(() => Promise.resolve({ ok: true, json: () => Promise.resolve({ accounts: [] }) } as Response));
        sandboxJsonMock.mockResolvedValue({ codex: [{ name: `codex-user.json`, label: `user@example.com` }], grok: [], gemini: [] });
        await loadAccountStatus();
        await nextTick();

        // The untouched fresh conversation follows Codex (subscription-connected), so the composer is reachable —
        // no Claude wall, and no separate ChatGPT account was ever needed.
        expect(chat.provider.value).toBe(`codex`);
        expect(chat.connected.value).toBe(true);
    });

    it(`gates a routed (claude-code harness) chat on the translator subscription, not the native account`, async () => {
        storage.clear();
        resetChat();
        const chat = useChat();
        // Grok's native account is connected, but the translator holds no SuperGrok subscription yet.
        sandboxRequestMock.mockImplementation((path: string) =>
            Promise.resolve({
                ok: true,
                json: () => Promise.resolve({ accounts: path.startsWith(`/grok`) ? [{ id: `xai`, label: `Grok`, connectedAt: 0 }] : [] }),
            } as Response),
        );
        sandboxJsonMock.mockResolvedValue({ codex: [], grok: [], gemini: [] });
        await loadAccountStatus();
        await nextTick();

        chat.selectProvider(`grok`);
        expect(chat.connected.value).toBe(true); // the native harness is served by the account
        chat.active.value.selectHarness(`claude-code`);
        expect(chat.connected.value).toBe(false); // routed: only the translator subscription serves the turn

        // The subscription connects (via the Agent tab's "Under Claude Code" row) — the same gate opens.
        sandboxJsonMock.mockResolvedValue({ codex: [], grok: [{ name: `xai-user.json`, label: `user@x.ai` }], gemini: [] });
        await loadAccountStatus();
        expect(chat.connected.value).toBe(true);
    });
});

describe(`account usage hydration`, () => {
    beforeEach(() => {
        storage.clear();
        resetChat();
        usageStatusByAccount.value = {};
        sandboxJsonMock.mockResolvedValue({ codex: [], grok: [], gemini: [] });
    });

    // The daemon persists each account's usage window; without this the picker stays blank on a fresh load
    // until that account happens to run a turn — which is exactly the turn the user wanted to spend wisely.
    it(`seeds the usage map from the persisted snapshots on the account list`, async () => {
        sandboxRequestMock.mockImplementation((path: string) =>
            Promise.resolve({
                ok: true,
                json: () =>
                    Promise.resolve({
                        accounts: path.startsWith(`/claude`)
                            ? [
                                  {
                                      id: `a1`,
                                      label: `Personal`,
                                      connectedAt: 0,
                                      usage: { windows: [{ kind: `seven_day`, utilization: 12 }], measuredAt: 500 },
                                  },
                                  { id: `a2`, label: `Work`, connectedAt: 1 },
                              ]
                            : [],
                    }),
            } as Response),
        );
        await loadAccountStatus();

        expect(usageStatusByAccount.value[`a1`]).toMatchObject({ windows: [{ kind: `seven_day`, utilization: 12 }], measuredAt: 500 });
        // An account the daemon has no reading for stays absent — unknown, not 0%.
        expect(usageStatusByAccount.value[`a2`]).toBeUndefined();
    });

    it(`keeps a live streamed reading when the persisted one is older`, async () => {
        usageStatusByAccount.value = { a1: { windows: [{ kind: `seven_day`, utilization: 80 }], measuredAt: 9_000 } };
        sandboxRequestMock.mockImplementation((path: string) =>
            Promise.resolve({
                ok: true,
                json: () =>
                    Promise.resolve({
                        accounts: path.startsWith(`/claude`)
                            ? [
                                  {
                                      id: `a1`,
                                      label: `Personal`,
                                      connectedAt: 0,
                                      usage: { windows: [{ kind: `seven_day`, utilization: 30 }], measuredAt: 500 },
                                  },
                              ]
                            : [],
                    }),
            } as Response),
        );
        await loadAccountStatus();

        // The daemon's write is fire-and-forget, so a refresh can land between a frame and its persist —
        // the newer reading must win, or the chip would flicker backwards mid-session.
        expect(usageStatusByAccount.value[`a1`]).toMatchObject({ windows: [{ kind: `seven_day`, utilization: 80 }], measuredAt: 9_000 });
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

        chat.newChat();
        expect(chat.draft.value).toBe(``);

        chat.setActive(first);
        expect(chat.draft.value).toBe(`hello A`);
    });

    it(`restores tabs, drafts, attachment metadata, and the active tab from the persisted snapshot`, async () => {
        const chat = useChat();
        chat.draft.value = `draft one`;
        chat.attachments.value = [{ id: `a1`, name: `pic.png`, path: `.intentic/attachments/u1/pic.png`, status: `done`, progress: 1 }];
        chat.newChat();
        chat.draft.value = `draft two`;
        await nextTick(); // flush the persistence watch

        resetChat(); // same restore path as a page refresh / sandbox switch-back
        const tabs = chat.conversations.value;
        expect(tabs).toHaveLength(2);
        expect(tabs[0]!.draft.value).toBe(`draft one`);
        expect(tabs[0]!.attachments.value).toMatchObject([{ name: `pic.png`, path: `.intentic/attachments/u1/pic.png`, status: `done` }]);
        expect(tabs[1]!.draft.value).toBe(`draft two`);
        expect(chat.active.value).toBe(tabs[1]); // the second tab was active when persisted
    });

    // A queued message is text the user wrote and nobody has answered yet — a refresh mid-turn must not eat it.
    it(`restores messages queued behind a running turn, with their attachments`, async () => {
        const chat = useChat();
        chat.active.value.queued.value = [
            { id: `q1`, text: `also update the tests`, attachments: [{ name: `spec.md`, path: `.intentic/attachments/u1/spec.md` }] },
        ];
        await nextTick();

        resetChat();
        expect(chat.queued.value).toMatchObject([
            { text: `also update the tests`, attachments: [{ name: `spec.md`, path: `.intentic/attachments/u1/spec.md` }] },
        ]);
    });

    it(`degrades a corrupt snapshot to a single fresh tab`, () => {
        storage.set(`intentic.chatTabs.sb1`, `not json`);
        resetChat();
        expect(useChat().conversations.value).toHaveLength(1);
        expect(useChat().draft.value).toBe(``);
    });
});

/* A tab set belongs to the WINDOW it is open in, and the app is used in several at once — the daemon
 * multiplexes attach streams and the presence roster counts viewers per connection precisely so it can be.
 * While every window rewrote one shared key on every keystroke and streamed title, the last writer won: after
 * a reload (the dev server's live-reload reloads them all at once) a window came back wearing another
 * window's tabs — unfamiliar names, transcripts it had never cached, and a tab it had just closed back on the
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
        const closed = chat.newChat().conversationId;
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
     * back as a permanent "New agent" tab — one no focus change could ever take, because the focus had already
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
     * changes a tab inside that window — a keystroke, a streamed title landing on a background tab — used to
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

    /* Four tabs, the third active — the shape every case below closes a different slice out of. Each one gets
     * composer text as it opens: an untouched "New agent" tab is not a tab the strip can hold alongside another
     * (setConversations enforces one at most, and only as the focused one), so four EMPTY presses would collapse
     * into a single reused draft. */
    const openFour = (): readonly string[] => {
        const chat = useChat();
        const ids: string[] = [];
        for (let at = 0; at < 4; at++) {
            const conversation = at === 0 ? chat.active.value : chat.newChat();
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
        expect(chat.activeId.value).toBe(ids[2]); // untouched — it wasn't in the set
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
        expect(chat.activeId.value).toBe(ids[1]); // the active tab went; focus falls to the last remaining one
    });

    // "Close All" can't leave the panel with nothing to render — the composer needs a conversation to write into.
    it(`replaces the strip with one fresh conversation when everything closes`, () => {
        const chat = useChat();
        const ids = openFour();

        chat.closeTabs(new Set(ids));

        expect(chat.conversations.value).toHaveLength(1);
        expect(chat.conversations.value[0]!.conversationId).not.toBeOneOf([...ids]);
        expect(chat.activeId.value).toBe(chat.conversations.value[0]!.conversationId);
        expect(chat.draft.value).toBe(``);
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
 * focus — not a watcher reaping afterwards, which is what it was. Every case here therefore asserts
 * SYNCHRONOUSLY: the list a caller reads back is already the list the user sees, so no surface can render or
 * persist the doomed in-between, and an explicit action can't be quietly cancelled out by a reaper racing it. */
describe(`abandoned drafts`, () => {
    beforeEach(async () => {
        storage.clear();
        resetChat();
        await nextTick();
    });

    it(`closes an untouched New agent tab when focus leaves it — whitespace alone isn't text`, () => {
        const chat = useChat();
        const first = chat.active.value.conversationId;
        chat.draft.value = `real work`;
        const abandoned = chat.newChat();
        abandoned.draft.value = `   `;

        chat.setActive(first);

        expect(chat.conversations.value.map((c) => c.conversationId)).toEqual([first]);
        expect(chat.activeId.value).toBe(first);
    });

    it(`keeps the tab once anything is in it — a half-typed draft is not abandoned`, async () => {
        const chat = useChat();
        const first = chat.active.value.conversationId;
        chat.draft.value = `real work`;
        const kept = chat.newChat();
        kept.draft.value = `half a thought`;
        await nextTick();

        chat.setActive(first);
        await nextTick();

        expect(chat.conversations.value.map((c) => c.conversationId)).toEqual([first, kept.conversationId]);
    });

    /* "New agent" pressed while an untouched one is already open hands THAT tab back. It used to append a
     * second and let the reaper close the first, which came to the same list one flush later — and so read as a
     * press that did nothing at all, because the two drafts were indistinguishable: same name, same emptiness,
     * same board card. There is nothing for a second one to be, so the press is about the caret (startAgent
     * asks for it either way) and the tab count is deliberately unchanged. */
    it(`hands back the untouched draft already open instead of minting a second`, () => {
        const chat = useChat();
        chat.draft.value = `real work`;
        const first = chat.newChat();

        const again = chat.newChat();

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
        const draft = chat.newChat();
        // A conversation that opened alongside it (a fleet card, a history row) takes the focus but not the draft.
        const opened = openAgentConversation({ id: `agent-1`, provider: `claude`, harness: `native`, title: `Someone else's work` });
        expect(chat.conversations.value.map((c) => c.conversationId)).toEqual([first, opened.conversationId]);

        const pressed = chat.newChat();

        expect(pressed).not.toBe(draft); // that one went with the focus it lost
        expect(chat.activeId.value).toBe(pressed.conversationId);
    });

    it(`leaves a draft the fleet has registered alone — that tab is a real agent now`, async () => {
        const chat = useChat();
        const first = chat.active.value.conversationId;
        chat.draft.value = `real work`;
        const registered = chat.newChat();
        registered.registered.value = true;
        await nextTick();

        chat.setActive(first);
        await nextTick();

        expect(chat.conversations.value.map((c) => c.conversationId)).toEqual([first, registered.conversationId]);
    });
});

/* Opening a card on the fleet board resolves the agent's current transcript by durable conversation/worktree
 * identity — the Claude Code Agent SDK store may hold several runtime sessions for it. Gating replay on `provider ===
 * 'claude'` opened a finished Gemini (or Kimi) agent as an empty "start a conversation with Google" panel while
 * its whole transcript sat readable on the daemon: neither provider has a native runtime, so both ALWAYS run the
 * Claude Code loop whatever harness the registry recorded. */
describe(`opening a fleet agent`, () => {
    beforeEach(() => {
        storage.clear();
        resetChat();
        // Nothing is running for the agent, so the attach probe stands down and the stored transcript is what
        // paints — the finished-lane case the board's cards are mostly made of.
        sandboxRequestMock.mockImplementation((path: string) => {
            if (path.endsWith(`/transcript`)) {
                return Promise.resolve({
                    ok: true,
                    json: () =>
                        Promise.resolve({
                            sessionId: `current-sdk-session`,
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

    it(`replays a finished Gemini agent's transcript — no native runtime means its session is the SDK store's`, async () => {
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

    it(`leaves a NATIVE Codex agent alone — its thread lives in Codex's own rollout store, not the SDK's`, async () => {
        const conversation = openAgentConversation({ id: `a3`, sessionId: `sess-n`, provider: `codex`, harness: `native` });

        await vi.waitFor(() => expect(sandboxRequestMock).toHaveBeenCalledWith(`/agent/attach`, expect.anything()));
        expect(sandboxRequestMock).not.toHaveBeenCalledWith(`/agents/a3/transcript`);
        expect(conversation.messages.value).toHaveLength(0);
    });
});

/* Claude's API rejects effort 'max' with extended thinking disabled — a 400 that kills the turn before the
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
        chat.newChat();
        expect(chat.effort.value).toBe(`xhigh`);
    });

    it(`leaves 'max' alone while thinking stays on`, () => {
        const chat = useChat();
        chat.effort.value = `max`;
        chat.thinking.value = true;
        expect(chat.effort.value).toBe(`max`);
    });
});
