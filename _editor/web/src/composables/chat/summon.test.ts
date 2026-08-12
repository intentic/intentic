// The summons channel's contract: a chat summoned ANYWHERE is on screen EVERYWHERE. The app runs as a full
// copy per browser window and a popped-out chat is drawn by whichever window opened it, so the guarantee under
// test is the receiving half — a window that never saw the click applies the identical reveal — plus the two
// rules the wire form carries: queued messages never ride it (another window would send them again), and a
// summons for another sandbox's chats is ignored whole.
import { afterEach, beforeEach, expect, it, vi } from "vitest";

vi.mock("../sandbox/sandboxClient", () => ({ sandboxRequest: vi.fn(), sandboxJson: vi.fn() }));
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
const { receiveSummons, summonChat, wireSummons } = await import("./summon");

beforeEach(() => {
    local.clear();
    session.clear();
    resetChat();
    // A daemon with nothing to say unless a test says otherwise — reveal hydrates the tabs it opens.
    sandboxRequestMock.mockImplementation(() => Promise.resolve({ ok: false, status: 404, json: () => Promise.resolve({}) } as Response));
});

afterEach(() => {
    chatRun.value = undefined;
    vi.clearAllMocks();
});

// What another window would receive for this summons — the poster and the receiver in one process, which is
// exactly what the channel does between two windows of the same origin.
it(`applies a broadcast reveal to a window that never saw the click`, () => {
    const chat = useChat();
    // Touched, so the one-draft sweep leaves it: what this asserts is that a summons ADDS, it never closes.
    chat.active.value.draft.value = `work in progress`;
    const first = chat.active.value.conversationId;
    const clicked = new Conversation();
    clicked.title.value = `Board card`;

    receiveSummons(wireSummons({ kind: `reveal`, verb: `show`, entries: [clicked], focus: clicked.conversationId, caret: false }));

    // The receiving window rebuilt the tab from the snapshot (a different instance, the same identity) and
    // focused it — with `show` collapsing to it, exactly as the clicking window did.
    expect(chat.activeId.value).toBe(clicked.conversationId);
    expect(chat.active.value.title.value).toBe(`Board card`);
    expect(chat.panes.value).toEqual([clicked.conversationId]);
    expect(chat.conversations.value.map((conversation) => conversation.conversationId)).toContain(first);
});

it(`carries the caret with a New agent summons, so every window's composer is ready to type into`, () => {
    const chat = useChat();
    const requests = chat.composerFocus.value;
    const draft = new Conversation();
    receiveSummons(wireSummons({ kind: `reveal`, verb: `show`, entries: [draft], focus: draft.conversationId, caret: true }));
    expect(chat.composerFocus.value).toBe(requests + 1);
});

/* THE QUEUE NEVER RIDES THE WIRE. Queued messages are user-written turns waiting to be SENT, and a window
 * restoring them would send them again when its own queue drains — one press, two identical turns. The summons
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
    receiveSummons({
        ...wireSummons({ kind: `reveal`, verb: `show`, entries: [foreign], focus: foreign.conversationId, caret: false }),
        sandbox: `sb-other`,
    });
    expect(chat.activeId.value).toBe(before);
    expect(chat.conversations.value.map((conversation) => conversation.conversationId)).not.toContain(foreign.conversationId);
});

// The same summons landing twice (a re-click, a replayed message) focuses the tab it already made — identity
// rides the wire, so no window can end up with twins.
it(`is idempotent: a summons repeated focuses the tab it opened rather than minting a twin`, () => {
    const chat = useChat();
    const clicked = new Conversation();
    const wire = wireSummons({ kind: `reveal`, verb: `show`, entries: [clicked], focus: clicked.conversationId, caret: false });
    receiveSummons(wire);
    receiveSummons(wire);
    expect(chat.conversations.value.filter((conversation) => conversation.conversationId === clicked.conversationId)).toHaveLength(1);
});

// A history row's summons carries the session and the tab identity the summoner minted, so every window
// agrees on the tab — and a window already showing that session under another tab keeps its own.
it(`resolves a session summons onto the tab already showing that session`, () => {
    const chat = useChat();
    const showing = chat.active.value;
    showing.session.value = { id: `sess-9`, provider: `claude`, account: `acc-1`, harness: `native` };
    receiveSummons(
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
    receiveSummons(wireSummons({ kind: `run`, runId: `run-7` }));
    expect(chatRun.value).toEqual({ runId: `run-7`, mode: `live` });
});

// summonChat with no channel (this environment) is still the whole local gesture — the single-window app.
it(`applies locally even where no channel exists`, () => {
    const chat = useChat();
    const clicked = new Conversation();
    summonChat({ kind: `reveal`, verb: `show`, entries: [clicked], focus: clicked.conversationId, caret: false });
    expect(chat.activeId.value).toBe(clicked.conversationId);
});
