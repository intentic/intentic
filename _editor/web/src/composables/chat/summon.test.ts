// The summons channel's contract: a chat summoned ANYWHERE is on screen EVERYWHERE. The app runs as a full copy
// per browser window, the chat's own floating window included, so the guarantee under test is the receiving half
// (a window that never saw the click applies the identical reveal) plus the two rules the wire form carries:
// queued messages never ride it (another window would send them again), and a summons for another sandbox's
// chats is ignored whole.
import { nextTick } from "vue";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Summons } from "./summon";
import type { StoredTab } from "./tabSnapshot";

vi.mock("../sandbox/sandboxClient", () => {
    const sandboxRequest = vi.fn();
    const sandboxJson = vi.fn();
    // The reach-aimed pair: `undefined` is the active box, which is every call this suite makes.
    return {
        sandboxRequest,
        sandboxJson,
        sandboxRequestVia: (_at: string | undefined, path: string, init?: RequestInit) =>
            init === undefined ? sandboxRequest(path) : sandboxRequest(path, init),
        sandboxJsonVia: (_at: string | undefined, path: string, init?: RequestInit) => (init === undefined ? sandboxJson(path) : sandboxJson(path, init)),
    };
});
vi.mock("../analytics", () => ({ track: vi.fn() }));
vi.mock("../sandbox/useSandbox", async () => {
    const { ref } = await import("vue");
    const activeSandboxId = ref<string | undefined>(`sb1`);
    const reachable = ref(false);
    return { useSandbox: () => ({ activeSandboxId, reachable }), sandboxKey: (...parts: unknown[]) => [...parts, activeSandboxId] };
});

// The node test environment has neither storage; the tab snapshot writes on every list change.
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

const { sandboxRequest } = await import("../sandbox/sandboxClient");
const sandboxRequestMock = vi.mocked(sandboxRequest);
const { resetChat, useChat } = await import("./useChat");
const { Conversation } = await import("./conversation");
const { chatRun } = await import("./chatRun");
const { claimedSummons, relaySummons, summonChat, wireSummons } = await import("./summon");
const { receiveChatNote } = await import("./chatChannel");
const { closedDrafts, forgetClosedDraft, keepClosedDraft } = await import("./closedDrafts");
const { receiveFloatingNote } = await import("../floating");

// A summons arriving from another window, by the path the channel delivers it: on the chat's one channel, in an
// envelope naming the sandbox it is about (chatChannel.ts).
const deliver = (summons: Summons, sandbox: string | undefined = `sb1`): void => receiveChatNote({ sandbox, note: { kind: `summons`, summons } });

/* THE CHAT IN A WINDOW OF ITS OWN, as the rest of the app hears it: one beat from that window (floating.ts's
 * own seam), which is what makes this window stop drawing the panel — and its own copies of these chats shadows
 * of the ones on screen out there. */
const popOut = (): void => receiveFloatingNote({ kind: `here`, panel: `chat`, id: `w1`, since: 1 });
const dock = (): void => receiveFloatingNote({ kind: `gone`, panel: `chat`, id: `w1` });

// A chat that was closed with a message still in it, as the store holds it and as a board card would name it
// (agentTabOf builds the same shape from the registry).
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
    // A daemon with nothing to say unless a test says otherwise: reveal hydrates the tabs it opens.
    sandboxRequestMock.mockImplementation(() => Promise.resolve({ ok: false, status: 404, json: () => Promise.resolve({}) } as Response));
});

afterEach(() => {
    chatRun.value = undefined;
    // Whatever a case did with the panel, this window draws the chat again: ownership is app-wide state, and a
    // suite that left it popped out would run every later case as a window watching someone else's panel.
    dock();
    vi.clearAllMocks();
});

// What another window would receive for this summons: the poster and the receiver in one process, which is
// exactly what the channel does between two windows of the same origin.
it(`applies a broadcast reveal to a window that never saw the click`, () => {
    const chat = useChat();
    // Touched, so the one-draft sweep leaves it: what this asserts is that a summons ADDS, it never closes.
    chat.active.value.draft.value = `work in progress`;
    const first = chat.active.value.conversationId;
    const clicked = new Conversation();
    clicked.title.value = `Board card`;

    deliver(wireSummons({ kind: `reveal`, verb: `show`, entries: [clicked], focus: clicked.conversationId, caret: false }));

    // The receiving window rebuilt the tab from the snapshot (a different instance, the same identity) and
    // focused it: with `show` collapsing to it, exactly as the clicking window did.
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

/* THE QUEUE NEVER RIDES THE WIRE. Queued messages are user-written turns waiting to be SENT, and a window
 * restoring them would send them again when its own queue drains: one press, two identical turns. The summons
 * carries the tab without them; the turn the queue becomes reaches every window from the daemon. */
it(`strips queued messages from the wire form`, () => {
    const conversation = new Conversation();
    conversation.queued.value = [{ id: `q1`, text: `about to be sent`, attachments: [] }];
    const wire = wireSummons({ kind: `reveal`, verb: `show`, entries: [conversation], focus: conversation.conversationId, caret: false });
    expect(wire.kind === `reveal` && wire.entries[0]).toMatchObject({ conversationId: conversation.conversationId, queued: [] });
});

// A summons names one sandbox's conversations; a window looking at another sandbox has no such chats.
it(`ignores a summons for another sandbox's chats`, () => {
    const chat = useChat();
    const before = chat.activeId.value;
    const foreign = new Conversation();
    deliver(wireSummons({ kind: `reveal`, verb: `show`, entries: [foreign], focus: foreign.conversationId, caret: false }), `sb-other`);
    expect(chat.activeId.value).toBe(before);
    expect(chat.conversations.value.map((conversation) => conversation.conversationId)).not.toContain(foreign.conversationId);
});

// The same summons landing twice (a re-click, a replayed message) focuses the tab it already made: identity
// rides the wire, so no window can end up with twins.
it(`is idempotent: a summons repeated focuses the tab it opened rather than minting a twin`, () => {
    const chat = useChat();
    const clicked = new Conversation();
    const wire = wireSummons({ kind: `reveal`, verb: `show`, entries: [clicked], focus: clicked.conversationId, caret: false });
    deliver(wire);
    deliver(wire);
    expect(chat.conversations.value.filter((conversation) => conversation.conversationId === clicked.conversationId)).toHaveLength(1);
});

// A history row's summons carries the session and the tab identity the summoner minted, so every window
// agrees on the tab, and a window already showing that session under another tab keeps its own.
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

// The run summons carries the id alone: each window's panel follows the run from its own ledger reads.
it(`points every window's panel at a summoned run`, () => {
    deliver(wireSummons({ kind: `run`, runId: `run-7` }));
    expect(chatRun.value).toEqual({ runId: `run-7`, mode: `live` });
});

// summonChat with no channel (this environment) is still the whole local gesture: the single-window app.
it(`applies locally even where no channel exists`, () => {
    const chat = useChat();
    const clicked = new Conversation();
    summonChat({ kind: `reveal`, verb: `show`, entries: [clicked], focus: clicked.conversationId, caret: false });
    expect(chat.activeId.value).toBe(clicked.conversationId);
});

/* THE PANEL'S OWN GESTURES ARE TOLD, NOT PERFORMED TWICE. A click on a rail row has already moved the panel it
 * was made in, under rules only that surface knows (whether it offers panes at all, which row anchored a
 * range), so the relay exists to tell the OTHER windows, whose fleet boards ring whatever the chat is pointing
 * at. Re-running the reveal here would be a second answer to a question already answered. */
it(`relays a panel gesture without re-applying it in the window that made it`, () => {
    const chat = useChat();
    const held = chat.activeId.value;
    const other = new Conversation();

    relaySummons({ kind: `reveal`, verb: `show`, entries: [other], focus: other.conversationId, caret: false });

    expect(chat.activeId.value).toBe(held);
    expect(chat.conversations.value.map((conversation) => conversation.conversationId)).not.toContain(other.conversationId);
});

/* THE WORDS A CLOSE SET ASIDE RIDE THE SUMMONS (closedDrafts), claimed once by the window that was pressed.
 *
 * The store answers the first window to ask, and every window applies the same reveal, so a claim made while
 * applying is a race, one the surface the user is looking at has no reason to win: with the chat POPPED OUT the
 * click is on the BOARD, whose own copy of the conversation is on no screen at all. */
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
    // ...and taken, so the second window applying this reveal does not go looking for them in a store that
    // now has nothing, which is exactly the bug: it opened the chat with an empty composer.
    expect(closedDrafts.value).toEqual([]);
});

// The receiving half, and the case the user reported: the × was pressed in the popped-out window, the card was
// clicked on the board, and THIS window's store holds nothing. The message comes back all the same.
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
    // Dated from when it was written: the mark on the board says how long the message has been standing, and a
    // restore that re-stamped it would call a four-day-old sentence fresh work.
    expect(chat.active.value.draftAt.value).toBe(1_700);
});

/* CLOSING FROM THE BOARD IS A SUMMONS TOO, for the reason opening from it is: the card is the conversation seen
 * from the board, and the panel drawing that conversation may be another window's. */
it(`closes a chat in a window that never saw the click`, () => {
    const chat = useChat();
    const clicked = new Conversation();
    deliver(wireSummons({ kind: `reveal`, verb: `show`, entries: [clicked], focus: clicked.conversationId, caret: false }));
    expect(chat.conversations.value.map((conversation) => conversation.conversationId)).toContain(clicked.conversationId);

    deliver(wireSummons({ kind: `close`, conversationIds: [clicked.conversationId] }));

    expect(chat.conversations.value.map((conversation) => conversation.conversationId)).not.toContain(clicked.conversationId);
});

/* ...AND IT IS THE CONVERSATION THAT CLOSES, not a surface's view of it. The panel's own × narrows the panel and
 * sets the words aside for the card to keep (useChat.closeTabs); the board's × is the card itself going, so the
 * window drawing the chat drops the tab AND the words, in the one press. Setting them aside here read as a ×
 * that did nothing: the tab left the popped-out chat while the card stayed for a second press to take. */
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

// The same press on a card that stands for set-aside words alone: no window has a tab for it, and every window
// forgets the words, which is what closing that card means.
it(`forgets words already set aside when the board closes the card standing for them`, () => {
    keepClosedDraft(setAside(`cnv-parked`, `the half-written message`));

    deliver(wireSummons({ kind: `close`, conversationIds: [`cnv-parked`] }));

    expect(closedDrafts.value).toEqual([]);
});

/* ...and a window that is NOT drawing the chat has nothing to say about what was in its composer either way
 * (useChat.closing's rule). Its tab is frozen at whatever it last heard, so a close that set THAT aside would
 * keep a message the user has since sent out in the floating window. */
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

// The queue rule applies to the carried words too, and for the same reason it applies to the entries: a queued
// turn restored in two windows is one press and two identical sends.
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
