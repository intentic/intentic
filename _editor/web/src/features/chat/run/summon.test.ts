// Pins the summons channel's contract: a chat summoned anywhere is on screen everywhere. Queued messages never ride the
// wire, and a summons for another sandbox's chats is ignored whole.
import { nextTick } from "vue";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Summons } from "./summon";
import type { StoredTab } from "../tabs/tabSnapshot";

vi.mock("../../sandbox/client/sandboxClient", () => {
    const sandboxRequest = vi.fn();
    const sandboxJson = vi.fn();
    // `undefined` is the active box; every call this suite makes targets it.
    return {
        sandboxRequest,
        sandboxJson,
        sandboxRequestVia: (_at: string | undefined, path: string, init?: RequestInit) =>
            init === undefined ? sandboxRequest(path) : sandboxRequest(path, init),
        sandboxJsonVia: (_at: string | undefined, path: string, init?: RequestInit) => (init === undefined ? sandboxJson(path) : sandboxJson(path, init)),
    };
});
vi.mock("../../../app/analytics", () => ({ track: vi.fn() }));
vi.mock("../../sandbox/client/useSandbox", async () => {
    const { ref } = await import("vue");
    const activeSandboxId = ref<string | undefined>(`sb1`);
    const reachable = ref(false);
    return { useSandbox: () => ({ activeSandboxId, reachable }), sandboxKey: (...parts: unknown[]) => [...parts, activeSandboxId] };
});

// Node has neither storage; the tab snapshot writes to both on every list change.
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

const { sandboxRequest } = await import("../../sandbox/client/sandboxClient");
const sandboxRequestMock = vi.mocked(sandboxRequest);
const { resetChat, useChat } = await import("./useChat");
const { Conversation } = await import("../session/conversation");
const { chatRun } = await import("./chatRun");
const { claimedSummons, relaySummons, summonChat, wireSummons } = await import("./summon");
const { receiveChatNote } = await import("./chatChannel");
const { closedDrafts, forgetClosedDraft, keepClosedDraft } = await import("../drafts/closedDrafts");
const { receiveFloatingNote } = await import("../../../shell/window/floating");

// A summons as another window's channel would deliver it: an envelope naming its sandbox.
const deliver = (summons: Summons, sandbox: string | undefined = `sb1`): void => receiveChatNote({ sandbox, note: { kind: `summons`, summons } });

// One heartbeat from the floating window flips this window from drawing the panel to shadowing it.
const popOut = (): void => receiveFloatingNote({ kind: `here`, panel: `chat`, id: `w1`, since: 1 });
const dock = (): void => receiveFloatingNote({ kind: `gone`, panel: `chat`, id: `w1` });

// A chat closed with a message still in it, in the same shape agentTabOf builds from the registry.
const setAside = (conversationId: string, draft: string): StoredTab => ({
    conversationId,
    isolated: true,
    registered: false,
    provider: `claude`,
    harness: `native`,
    draft,
    draftAt: 1_700,
    attachments: [],
    queued: [],
});

beforeEach(() => {
    local.clear();
    session.clear();
    resetChat();
    for (const entry of closedDrafts.value) {
        forgetClosedDraft(entry.conversationId);
    }
    // A daemon with nothing to say by default; reveal hydrates whatever tab it opens.
    sandboxRequestMock.mockImplementation(() => Promise.resolve({ ok: false, status: 404, json: () => Promise.resolve({}) } as Response));
});

afterEach(() => {
    chatRun.value = undefined;
    // Resets ownership, or a popped-out case would leave every later test watching someone else's panel.
    dock();
    vi.clearAllMocks();
});

it(`applies a broadcast reveal to a window that never saw the click`, () => {
    const chat = useChat();
    // Touched, so the one-draft sweep leaves it alone; this asserts that a summons adds a tab, it never closes one.
    chat.active.value.draft.value = `work in progress`;
    const first = chat.active.value.conversationId;
    const clicked = new Conversation();
    clicked.title.value = `Board card`;

    deliver(wireSummons({ kind: `reveal`, verb: `show`, entries: [clicked], focus: clicked.conversationId, caret: false }));

    expect(chat.activeId.value).toBe(clicked.conversationId);
    expect(chat.active.value.title.value).toBe(`Board card`);
    expect(chat.panes.value).toEqual([clicked.conversationId]);
    expect(chat.conversations.value.map((conversation) => conversation.conversationId)).toContain(first);
});

it(`carries the caret with a New agent summons, so every window's composer is ready to type into`, () => {
    const chat = useChat();
    const requests = chat.composerFocus.value;
    const draft = new Conversation();
    deliver(wireSummons({ kind: `reveal`, verb: `show`, entries: [draft], focus: draft.conversationId, caret: true }));
    expect(chat.composerFocus.value).toBe(requests + 1);
});

// Queued messages are about to be sent; restoring them in another window would send them twice.
it(`strips queued messages from the wire form`, () => {
    const conversation = new Conversation();
    conversation.queued.value = [{ id: `q1`, text: `about to be sent`, attachments: [] }];
    const wire = wireSummons({ kind: `reveal`, verb: `show`, entries: [conversation], focus: conversation.conversationId, caret: false });
    expect(wire.kind === `reveal` && wire.entries[0]).toMatchObject({ conversationId: conversation.conversationId, queued: [] });
});

it(`ignores a summons for another sandbox's chats`, () => {
    const chat = useChat();
    const before = chat.activeId.value;
    const foreign = new Conversation();
    deliver(wireSummons({ kind: `reveal`, verb: `show`, entries: [foreign], focus: foreign.conversationId, caret: false }), `sb-other`);
    expect(chat.activeId.value).toBe(before);
    expect(chat.conversations.value.map((conversation) => conversation.conversationId)).not.toContain(foreign.conversationId);
});

it(`is idempotent: a summons repeated focuses the tab it opened rather than minting a twin`, () => {
    const chat = useChat();
    const clicked = new Conversation();
    const wire = wireSummons({ kind: `reveal`, verb: `show`, entries: [clicked], focus: clicked.conversationId, caret: false });
    deliver(wire);
    deliver(wire);
    expect(chat.conversations.value.filter((conversation) => conversation.conversationId === clicked.conversationId)).toHaveLength(1);
});

it(`resolves a session summons onto the tab already showing that session`, () => {
    const chat = useChat();
    const showing = chat.active.value;
    showing.session.value = { id: `sess-9`, provider: `claude`, account: `acc-1`, harness: `native` };
    deliver(
        wireSummons({
            kind: `reveal`,
            verb: `show`,
            entries: [{ conversationId: `minted-elsewhere`, sessionRef: `sess-9` }],
            focus: `minted-elsewhere`,
            caret: false,
        }),
    );
    expect(chat.activeId.value).toBe(showing.conversationId);
    expect(chat.conversations.value.map((conversation) => conversation.conversationId)).not.toContain(`minted-elsewhere`);
});

// Carries only the run id; each window's panel follows it from its own ledger reads.
it(`points every window's panel at a summoned run`, () => {
    deliver(wireSummons({ kind: `run`, runId: `run-7` }));
    expect(chatRun.value).toEqual({ runId: `run-7`, mode: `live` });
});

it(`applies locally even where no channel exists`, () => {
    const chat = useChat();
    const clicked = new Conversation();
    summonChat({ kind: `reveal`, verb: `show`, entries: [clicked], focus: clicked.conversationId, caret: false });
    expect(chat.activeId.value).toBe(clicked.conversationId);
});

it(`relays a panel gesture without re-applying it in the window that made it`, () => {
    const chat = useChat();
    const held = chat.activeId.value;
    const other = new Conversation();

    relaySummons({ kind: `reveal`, verb: `show`, entries: [other], focus: other.conversationId, caret: false });

    expect(chat.activeId.value).toBe(held);
    expect(chat.conversations.value.map((conversation) => conversation.conversationId)).not.toContain(other.conversationId);
});

// The store answers whichever window asks first; with the chat popped out that's the board, which has no live copy of
// its own.
it(`claims a closed chat's words once, and sends them with the summons`, () => {
    keepClosedDraft(setAside(`cnv-parked`, `the half-written message`));

    const carrying = claimedSummons({
        kind: `reveal`,
        verb: `show`,
        entries: [setAside(`cnv-parked`, ``)],
        focus: `cnv-parked`,
        caret: false,
    });

    expect(carrying.kind === `reveal` && carrying.unsent).toMatchObject([{ conversationId: `cnv-parked`, draft: `the half-written message` }]);
    expect(closedDrafts.value).toEqual([]);
});

it(`restores a summoned chat's message from what the summons carries, with an empty store`, () => {
    const chat = useChat();
    const wire = wireSummons({
        kind: `reveal`,
        verb: `show`,
        entries: [setAside(`cnv-parked`, ``)],
        focus: `cnv-parked`,
        caret: false,
        unsent: [setAside(`cnv-parked`, `the half-written message`)],
    });

    deliver(wire);

    expect(chat.activeId.value).toBe(`cnv-parked`);
    expect(chat.active.value.draft.value).toBe(`the half-written message`);
    // Dated from when it was written, not restored, so the board's age mark doesn't call old work fresh.
    expect(chat.active.value.draftAt.value).toBe(1_700);
});

it(`closes a chat in a window that never saw the click`, () => {
    const chat = useChat();
    const clicked = new Conversation();
    deliver(wireSummons({ kind: `reveal`, verb: `show`, entries: [clicked], focus: clicked.conversationId, caret: false }));
    expect(chat.conversations.value.map((conversation) => conversation.conversationId)).toContain(clicked.conversationId);

    deliver(wireSummons({ kind: `close`, conversationIds: [clicked.conversationId] }));

    expect(chat.conversations.value.map((conversation) => conversation.conversationId)).not.toContain(clicked.conversationId);
});

// The board's × takes the whole card, tab and words together; the panel's own × (which only narrows a pane) is what
// sets words aside instead.
it(`drops the words with the tab when the board closes a chat, in the window drawing it`, async () => {
    const chat = useChat();
    const clicked = new Conversation();
    deliver(wireSummons({ kind: `reveal`, verb: `show`, entries: [clicked], focus: clicked.conversationId, caret: false }));
    chat.active.value.draft.value = `half a thought`;
    await nextTick();

    deliver(wireSummons({ kind: `close`, conversationIds: [clicked.conversationId] }));

    expect(chat.conversations.value.map((conversation) => conversation.conversationId)).not.toContain(clicked.conversationId);
    expect(closedDrafts.value).toEqual([]);
});

it(`forgets words already set aside when the board closes the card standing for them`, () => {
    keepClosedDraft(setAside(`cnv-parked`, `the half-written message`));

    deliver(wireSummons({ kind: `close`, conversationIds: [`cnv-parked`] }));

    expect(closedDrafts.value).toEqual([]);
});

it(`sets no words aside for a chat this window is only shadowing`, async () => {
    const chat = useChat();
    const clicked = new Conversation();
    deliver(wireSummons({ kind: `reveal`, verb: `show`, entries: [clicked], focus: clicked.conversationId, caret: false }));
    chat.active.value.draft.value = `what the composer out there held a moment ago`;
    await nextTick();
    popOut();

    deliver(wireSummons({ kind: `close`, conversationIds: [clicked.conversationId] }));

    expect(chat.conversations.value.map((conversation) => conversation.conversationId)).not.toContain(clicked.conversationId);
    expect(closedDrafts.value).toEqual([]);
});

it(`strips queued turns from the words a summons carries`, () => {
    const wire = wireSummons({
        kind: `reveal`,
        verb: `show`,
        entries: [setAside(`cnv-parked`, ``)],
        focus: `cnv-parked`,
        caret: false,
        unsent: [{ ...setAside(`cnv-parked`, `still typing`), queued: [{ text: `about to be sent`, attachments: [] }] }],
    });

    expect(wire.kind === `reveal` && wire.unsent).toMatchObject([{ draft: `still typing`, queued: [] }]);
});
