// Pins that one chat has one set of picks across windows: a pick made in one window reaches every other window's copy of
// the chat, written outright and never told on again, and a pick cleared there is cleared here too.
import { resetSandboxScope } from "@intentic/extension-api";
import { ref } from "vue";
import type { Summons } from "./summon";
import type { StoredTab } from "../tabs/tabSnapshot";
import { SandboxHttpError } from "../../../client/sandbox/sandboxHttpError";
import { fakeSandboxRpc } from "../../../testing/sandboxRpcFake";

const run = jest.fn(async () => {
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
const { receiveChatNote } = await import("./chatChannel");
// Its summons reader is how a window not drawing the chat comes to hold a copy of it at all.
await import("./summon");
const { receivedPicks, wirePicks } = await import("./pickEcho");
const { sharedPicksOf } = await import("../session/selectionReducer");
const { receiveFloatingNote } = await import("../../../workbench/window/floating");

const deliver = (summons: Summons): void => receiveChatNote({ sandbox: `sb1`, note: { kind: `summons`, summons } });
// One heartbeat from the floating window turns this one into a window holding the chat without drawing it.
const popOut = (): void => receiveFloatingNote({ kind: `here`, panel: `chat`, id: `w1`, since: 1 });
const dock = (): void => receiveFloatingNote({ kind: `gone`, panel: `chat`, id: `w1` });

// A new chat as the floating window summoned it: on the seed that window opened it on.
const summoned = (conversationId: string): StoredTab => ({
    conversationId,
    isolated: true,
    registered: true,
    provider: `codex`,
    harness: `native`,
    model: `gpt-5`,
});

beforeEach(() => {
    local.clear();
    session.clear();
    resetSandboxScope();
});

afterEach(() => {
    dock();
    jest.clearAllMocks();
});

it(`moves a window's copy of a chat onto the picks made for it in the window drawing it`, () => {
    const chat = useChat();
    popOut();
    deliver({ kind: `reveal`, verb: `show`, entries: [summoned(`c1`)], focus: `c1`, caret: false });
    const copy = chat.conversations.value.find((conversation) => conversation.conversationId === `c1`)!;
    expect(copy.selection.provider.value).toBe(`codex`);

    // The person moved it to Claude over there, where the chat is drawn.
    const there = new Conversation(`c1`);
    there.selection.apply({ kind: `selectModel`, pick: { provider: `claude`, value: `claude-opus-5-5` } });
    receiveChatNote({ sandbox: `sb1`, note: { kind: `picks`, conversationId: `c1`, picks: wirePicks(there.selection.echoed.value!) } });

    expect(copy.selection.provider.value).toBe(`claude`);
    expect(copy.selection.model.value).toBe(`claude-opus-5-5`);
    // Written, not picked: this window tells nobody again.
    expect(copy.selection.echoed.value).toBeUndefined();
});

it(`leaves another sandbox's chat of the same id alone`, () => {
    const chat = useChat();
    popOut();
    deliver({ kind: `reveal`, verb: `show`, entries: [summoned(`c2`)], focus: `c2`, caret: false });
    const copy = chat.conversations.value.find((conversation) => conversation.conversationId === `c2`)!;
    const there = new Conversation(`c2`);
    there.selection.apply({ kind: `selectProvider`, provider: `grok` });

    receiveChatNote({ sandbox: `sb1`, note: { kind: `picks`, conversationId: `c2`, box: `sb-other`, picks: wirePicks(there.selection.echoed.value!) } });

    expect(copy.selection.provider.value).toBe(`codex`);
});

it(`echoes the picks a person makes, never the ones written into the chat`, () => {
    const conversation = new Conversation(`c3`);
    conversation.selection.apply({ kind: `set`, picks: { provider: `codex`, model: `gpt-5` } });
    expect(conversation.selection.echoed.value).toBeUndefined();

    conversation.selection.apply({ kind: `setEffort`, effort: `high` });
    expect(conversation.selection.echoed.value?.effortPick).toBe(`high`);
    const told = conversation.selection.echoed.value;
    // A pick that changes nothing tells nothing new.
    conversation.selection.apply({ kind: `selectProvider`, provider: `codex` });
    expect(conversation.selection.echoed.value).toBe(told);
});

it(`clears on the receiving side what the sender cleared, though JSON drops an unset key`, () => {
    const conversation = new Conversation(`c4`);
    conversation.selection.apply({ kind: `set`, picks: { account: `acct-1` } });
    const sent = sharedPicksOf({ ...conversation.selection.state.value, account: undefined });

    // SAFETY: the value is wirePicks' own output through a JSON round trip, which is exactly what the channel does to it.
    const overTheWire = JSON.parse(JSON.stringify(wirePicks(sent))) as ReturnType<typeof wirePicks>;
    const received = receivedPicks(overTheWire);

    expect(`account` in received).toBe(true);
    expect(received.account).toBeUndefined();
    conversation.selection.apply({ kind: `set`, picks: received });
    expect(conversation.selection.account.value).toBeUndefined();
});
