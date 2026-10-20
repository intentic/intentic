// Pins the summons channel's contract: a chat summoned anywhere is on screen everywhere. Queued messages never ride the
// wire, and a summons for another sandbox's chats is ignored whole.
import { resetSandboxScope } from "@intentic/extension-api";
import { effectScope, nextTick, ref } from "vue";
import type { Summons } from "./summon";
import type { StoredTab } from "../tabs/tabSnapshot";
import { SandboxHttpError } from "../../../client/sandbox/sandboxHttpError";
import type { ProcedureInput } from "../../../client/sandbox/sandboxRpc";
import { fakeSandboxRpc } from "../../../testing/sandboxRpcFake";

// A daemon with nothing to say: every turn is refused at the door. A send is the one call only a turn makes.
const run = jest.fn(async (_turn: ProcedureInput<`agent.run`>) => {
    throw new SandboxHttpError(404, `Request failed (404).`);
});
jest.mock("../../../client/sandbox/sandboxRpc", () => ({ sandboxRpc: fakeSandboxRpc({ agent: { run } }) }));
jest.mock("../../../app/analytics", () => ({ track: jest.fn(), replaySessionId: () => undefined, noteTurnCompleted: jest.fn() }));
jest.mock("../../../client/sandbox/useSandbox", () => {
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

const { useChat } = await import("./useChat");
const { Conversation } = await import("../session/conversation");
const { chatRun } = await import("./chatRun");
const { relaySummons, summonChat, summonTurn, wireSummons } = await import("./summon");
const { snapshotTab } = await import("../tabs/tabSnapshot");
const { receiveChatNote } = await import("./chatChannel");
const { discardDraft, draftOf, heldDrafts, writeDraft } = await import("../drafts/composerDrafts");
const { claimFloating, receiveFloatingNote } = await import("../../../workbench/window/floating");

// A summons as another window's channel would deliver it: an envelope naming its sandbox.
const deliver = (summons: Summons, sandbox: string | undefined = `sb1`): void => receiveChatNote({ sandbox, note: { kind: `summons`, summons } });

// One heartbeat from the floating window flips this window from drawing the panel to shadowing it.
const popOut = (): void => receiveFloatingNote({ kind: `here`, panel: `chat`, id: `w1`, since: 1 });
const dock = (): void => receiveFloatingNote({ kind: `gone`, panel: `chat`, id: `w1` });

// A chat nobody has started, in the same shape agentTabOf builds from a card.
const setAside = (conversationId: string): StoredTab => ({
    conversationId,
    isolated: true,
    registered: false,
    provider: `claude`,
    harness: `native`,
});

// Words waiting in a conversation's draft, as a chat closed with them, or another window or device, left them.
const drafted = (conversationId: string, text: string): void => writeDraft(conversationId, { text, attachments: [] }, { since: 1_700 });

beforeEach(() => {
    local.clear();
    session.clear();
    resetSandboxScope();
    for (const draft of heldDrafts.value) {
        discardDraft(draft.conversationId);
    }
});

afterEach(() => {
    chatRun.value = undefined;
    // Resets ownership, or a popped-out case would leave every later test watching someone else's panel.
    dock();
    jest.clearAllMocks();
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

// A live chat crosses windows as the plain snapshot every window restores tabs from; what waits to be sent is the
// daemon's, so no window carries a copy of it.
it(`carries a live chat as its portable snapshot`, () => {
    const conversation = new Conversation();
    conversation.draft.value = `half a thought`;
    const wire = wireSummons({ kind: `reveal`, verb: `show`, entries: [conversation], focus: conversation.conversationId, caret: false });
    expect(wire.kind === `reveal` ? wire.entries[0] : undefined).toEqual(snapshotTab(conversation));
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

// A reopened chat's words are its draft's: no window claims them, and no summons carries them, so a popped-out chat and
// the board can never each hold a copy, or neither.
it(`reopens a chat on the words its draft holds, and leaves exactly that one draft`, () => {
    const chat = useChat();
    drafted(`cnv-parked`, `the half-written message`);

    deliver(wireSummons({ kind: `reveal`, verb: `show`, entries: [setAside(`cnv-parked`)], focus: `cnv-parked`, caret: false }));

    expect(chat.activeId.value).toBe(`cnv-parked`);
    expect(chat.active.value.draft.value).toBe(`the half-written message`);
    // Dated from when it was written, not reopened, so the board's age mark doesn't call old work fresh.
    expect(chat.active.value.draftAt.value).toBe(1_700);
    expect(heldDrafts.value.map((draft) => [draft.conversationId, draft.text])).toEqual([[`cnv-parked`, `the half-written message`]]);
});

it(`closes a chat in a window that never saw the click`, () => {
    const chat = useChat();
    const clicked = new Conversation();
    deliver(wireSummons({ kind: `reveal`, verb: `show`, entries: [clicked], focus: clicked.conversationId, caret: false }));
    expect(chat.conversations.value.map((conversation) => conversation.conversationId)).toContain(clicked.conversationId);

    deliver(wireSummons({ kind: `close`, conversationIds: [clicked.conversationId] }));

    expect(chat.conversations.value.map((conversation) => conversation.conversationId)).not.toContain(clicked.conversationId);
});

// The board's × takes the whole card, tab and words together; the panel's own × (which only narrows a pane) leaves the
// words their draft.
it(`drops the words with the tab when the board closes a chat, in the window drawing it`, async () => {
    const chat = useChat();
    const clicked = new Conversation();
    deliver(wireSummons({ kind: `reveal`, verb: `show`, entries: [clicked], focus: clicked.conversationId, caret: false }));
    chat.active.value.draft.value = `half a thought`;
    await nextTick();
    expect(draftOf(clicked.conversationId)?.text).toBe(`half a thought`);

    deliver(wireSummons({ kind: `close`, conversationIds: [clicked.conversationId] }));

    expect(chat.conversations.value.map((conversation) => conversation.conversationId)).not.toContain(clicked.conversationId);
    expect(draftOf(clicked.conversationId)).toBeUndefined();
});

it(`drops a draft no chat is open for when the board closes the card standing for it`, () => {
    drafted(`cnv-parked`, `the half-written message`);

    deliver(wireSummons({ kind: `close`, conversationIds: [`cnv-parked`] }));

    expect(draftOf(`cnv-parked`)).toBeUndefined();
});

it(`drops the draft from a window only shadowing the chat, as from the one drawing it`, async () => {
    const chat = useChat();
    const clicked = new Conversation();
    deliver(wireSummons({ kind: `reveal`, verb: `show`, entries: [clicked], focus: clicked.conversationId, caret: false }));
    chat.active.value.draft.value = `what the composer out there held a moment ago`;
    await nextTick();
    popOut();

    deliver(wireSummons({ kind: `close`, conversationIds: [clicked.conversationId] }));

    expect(chat.conversations.value.map((conversation) => conversation.conversationId)).not.toContain(clicked.conversationId);
    expect(draftOf(clicked.conversationId)).toBeUndefined();
});

// An archive files the card away and takes its chat off every window's panel, the floating one included: a chat window
// that only heard of it from the roster kept the chat it was showing, and kept it in the lane it was opened in.
it(`takes an archived chat off a window that never saw the press, even the chat it is showing`, () => {
    const chat = useChat();
    const filed = new Conversation();
    deliver(wireSummons({ kind: `reveal`, verb: `show`, entries: [filed], focus: filed.conversationId, caret: false }));
    expect(chat.activeId.value).toBe(filed.conversationId);

    deliver(wireSummons({ kind: `retire`, conversationIds: [filed.conversationId] }));

    expect(chat.conversations.value.map((conversation) => conversation.conversationId)).not.toContain(filed.conversationId);
});

// Unlike the board's ×, the conversation survives in the archive, so its unsent words stay its draft to come back with it.
it(`keeps an archived chat's unsent words as its draft`, async () => {
    const chat = useChat();
    const filed = new Conversation();
    deliver(wireSummons({ kind: `reveal`, verb: `show`, entries: [filed], focus: filed.conversationId, caret: false }));
    chat.active.value.draft.value = `half a thought`;
    await nextTick();

    deliver(wireSummons({ kind: `retire`, conversationIds: [filed.conversationId] }));

    expect(chat.conversations.value.map((conversation) => conversation.conversationId)).not.toContain(filed.conversationId);
    expect(draftOf(filed.conversationId)?.text).toBe(`half a thought`);
});

// A chat the roster knows, with nothing waiting to be sent: what a landed card's tab looks like. `box` names the sandbox
// it lives in, absent for this browser's own.
const knownTab = (conversationId: string, box?: string): StoredTab => ({
    ...setAside(conversationId),
    registered: true,
    ...(box === undefined ? {} : { box }),
});
const show = (tab: StoredTab): void =>
    deliver(wireSummons({ kind: `reveal`, verb: `show`, entries: [tab], focus: tab.conversationId, caret: false }));
const openIds = (): string[] => useChat().conversations.value.map((conversation) => conversation.conversationId);
const tabOf = (conversationId: string) => useChat().conversations.value.find((conversation) => conversation.conversationId === conversationId);

// A land pressed in any window lets its chat go in every one: at once in the background, and for the chat on screen,
// once the reader moves on, since the sweep never takes the focused tab out from under them.
it(`lets a landed chat go from a window that never saw the press`, () => {
    show(knownTab(`cnv-landed`));
    show(knownTab(`cnv-reading`));

    deliver(wireSummons({ kind: `release`, conversationIds: [`cnv-landed`] }));

    expect(openIds()).not.toContain(`cnv-landed`);
    expect(openIds()).toContain(`cnv-reading`);
});

it(`keeps the landed chat the reader is looking at until they move on`, () => {
    show(knownTab(`cnv-elsewhere`));
    show(knownTab(`cnv-landed`));

    deliver(wireSummons({ kind: `release`, conversationIds: [`cnv-landed`] }));

    expect(useChat().activeId.value).toBe(`cnv-landed`);
    expect(tabOf(`cnv-landed`)?.peek.value).toBe(true);

    useChat().setActive(`cnv-elsewhere`);

    expect(openIds()).not.toContain(`cnv-landed`);
});

// The same exceptions the roster's own release keeps: held on purpose, or words that would be stranded.
it(`keeps a landed chat that is pinned, or holds words not yet sent`, async () => {
    show(knownTab(`cnv-pinned`));
    show(knownTab(`cnv-typing`));
    show(knownTab(`cnv-reading`));
    useChat().setPinned(`cnv-pinned`, true);
    tabOf(`cnv-typing`)!.draft.value = `one more thing`;
    await nextTick();

    deliver(wireSummons({ kind: `release`, conversationIds: [`cnv-pinned`, `cnv-typing`] }));

    expect(openIds()).toEqual(expect.arrayContaining([`cnv-pinned`, `cnv-typing`]));
    expect(tabOf(`cnv-pinned`)?.peek.value).toBe(false);
    expect(tabOf(`cnv-typing`)?.peek.value).toBe(false);
});

// An id repeats across boxes: a land aimed at another sandbox says nothing about this box's chat of the same id.
it(`leaves a chat alone when the land was aimed at another box`, () => {
    show(knownTab(`cnv-landed`));
    show(knownTab(`cnv-reading`));

    deliver(wireSummons({ kind: `release`, conversationIds: [`cnv-landed`], box: `sb-other` }));

    expect(openIds()).toContain(`cnv-landed`);
    expect(tabOf(`cnv-landed`)?.peek.value).toBe(false);
});

// Which window ran a turn, by the words of the one call only a send makes; an attach is hydration, not a send.
const turnsSentHere = (): string[] => run.mock.calls.map(([turn]) => turn.prompt);

// A card's "start an agent for me" press: the turn belongs to the window drawing the chat, not to whichever window was
// clicked. A turn run in a window with no chat on screen is invisible while it works, keeps its refusal where nobody
// reads it, and dies with that window — a reload between the press and the daemon's ack leaves nothing anywhere.
it(`sends a summoned turn itself while it draws the chat`, () => {
    const conversation = new Conversation();

    summonTurn(conversation, `the check failed, fix it`);

    expect(turnsSentHere()).toEqual([`the check failed, fix it`]);
    expect(useChat().activeId.value).toBe(conversation.conversationId);
});

it(`hands a summoned turn over rather than running it where no chat is drawn`, () => {
    popOut();
    const conversation = new Conversation();

    summonTurn(conversation, `the check failed, fix it`);

    expect(turnsSentHere()).toEqual([]);
});

// The chat's own window claims the panel for as long as it is that window; node has none of the browser it polls for,
// so the claim gets the frame and listeners it reads and nothing else.
const asChatWindow = (act: () => void): void => {
    Object.defineProperty(globalThis, `window`, {
        configurable: true,
        value: { screenX: 0, screenY: 0, outerWidth: 1024, outerHeight: 768, addEventListener: () => {}, removeEventListener: () => {} },
    });
    const scope = effectScope();
    try {
        scope.run(() => claimFloating(`chat`, () => undefined));
        act();
    } finally {
        scope.stop();
        Reflect.deleteProperty(globalThis, `window`);
    }
};

it(`runs a carried turn in the window holding the chat's own window`, () => {
    const clicked = new Conversation();

    asChatWindow(() => {
        deliver(wireSummons({ kind: `reveal`, verb: `show`, entries: [clicked], focus: clicked.conversationId, caret: true, deliver: `fix it` }));
    });

    expect(turnsSentHere()).toEqual([`fix it`]);
});

// Every window applies the summons; a second sender would start the same fix twice.
it(`leaves a carried turn alone in a window only shadowing the chat`, () => {
    popOut();
    const clicked = new Conversation();

    deliver(wireSummons({ kind: `reveal`, verb: `show`, entries: [clicked], focus: clicked.conversationId, caret: true, deliver: `fix it` }));

    expect(turnsSentHere()).toEqual([]);
});
