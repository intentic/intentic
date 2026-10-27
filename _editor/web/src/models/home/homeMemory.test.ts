// How full a home's memory reads against the sandbox's budget, whose home the presses may act on, and what each press
// leaves behind: a session let go, or a transcript emptied with every copy a later read would paint from.
import type { SessionRef } from "../conversations/run/turnRequest";
import { ref } from "vue";
import * as actualSandboxRpc from "../../client/sandbox/sandboxRpc";
import { SandboxHttpError } from "../../client/sandbox/sandboxHttpError";
import { fakeSandboxRpc } from "../../testing/sandboxRpcFake";

const startFreshHome = jest.fn<() => Promise<{ ok: true }>>();
const clearHomeHistory = jest.fn<() => Promise<{ dropped: number }>>();
// Snapshotted before the mock replaces the module: a namespace is a live binding.
const realSandboxRpc = { ...actualSandboxRpc };
jest.mock(`../../client/sandbox/sandboxRpc`, () => ({
    ...realSandboxRpc,
    sandboxRpc: fakeSandboxRpc({ agents: { startFreshHome, clearHomeHistory } }),
}));

const homeMemory = await import("./homeMemory");
type HomeChat = import("./homeMemory").HomeChat;
const { FRESH_SOON_PERCENT, homeMemoryReading, ownHome } = homeMemory;

// The parts of a conversation each press touches, as the real one holds them.
const SESSION: SessionRef = { id: `s1`, provider: `claude`, account: undefined, harness: `claude-code` };
const conversationOf = () => {
    const clearRecord = jest.fn(async () => {});
    const chat: HomeChat = { box: ref<string | undefined>(undefined), session: ref<SessionRef | undefined>(SESSION), transcript: { clearRecord } };
    return { chat, clearRecord };
};

beforeEach(() => {
    startFreshHome.mockReset();
    clearHomeHistory.mockReset();
});

describe(`a home's memory readout`, () => {
    it(`reads the context against the budget, capped, and near the fresh start from ${FRESH_SOON_PERCENT}%`, () => {
        expect(homeMemoryReading({ contextTokens: 60_000 }, 150_000)).toEqual({ kind: `fill`, percent: 40, soon: false });
        expect(homeMemoryReading({ contextTokens: 120_000 }, 150_000)).toEqual({ kind: `fill`, percent: 80, soon: true });
        expect(homeMemoryReading({ contextTokens: 400_000 }, 150_000)).toEqual({ kind: `fill`, percent: 100, soon: true });
    });

    it(`says a fresh start already asked for over any figure`, () => {
        expect(homeMemoryReading({ contextTokens: 140_000, freshPending: `asked` }, 150_000)).toEqual({ kind: `pending`, why: `asked` });
        expect(homeMemoryReading({ freshPending: `cleared` }, 0)).toEqual({ kind: `pending`, why: `cleared` });
    });

    it(`draws no figure under a budget that never starts fresh, and nothing with nothing to measure`, () => {
        expect(homeMemoryReading({ contextTokens: 60_000 }, 0)).toEqual({ kind: `unbudgeted` });
        expect(homeMemoryReading({}, 150_000)).toBeUndefined();
        expect(homeMemoryReading(undefined, 150_000)).toBeUndefined();
        // A sandbox that names no budget is older than fresh starts, and has neither press.
        expect(homeMemoryReading({ contextTokens: 60_000 }, undefined)).toBeUndefined();
    });
});

it(`offers the presses on the reader's own home only`, () => {
    expect(ownHome({ home: true, startedBy: `Ada@example.com` }, `ada@example.com`)).toBe(true);
    expect(ownHome({ home: true, startedBy: `bo@example.com` }, `ada@example.com`)).toBe(false);
    expect(ownHome({ home: true }, `ada@example.com`)).toBe(true);
    expect(ownHome({ home: true, startedBy: `bo@example.com` }, undefined)).toBe(true);
    expect(ownHome({ startedBy: `ada@example.com` }, `ada@example.com`)).toBe(false);
});

describe(`the two presses`, () => {
    it(`starts fresh and lets the old session go`, async () => {
        startFreshHome.mockResolvedValue({ ok: true });
        const { chat, clearRecord } = conversationOf();
        expect(await homeMemory.startFreshHome(chat)).toBeUndefined();
        expect(chat.session.value).toBeUndefined();
        expect(clearRecord).not.toHaveBeenCalled();
    });

    it(`clears the history and empties this window's copy of it`, async () => {
        clearHomeHistory.mockResolvedValue({ dropped: 42 });
        const { chat, clearRecord } = conversationOf();
        expect(await homeMemory.clearHomeHistory(chat)).toBeUndefined();
        expect(clearRecord).toHaveBeenCalledTimes(1);
    });

    it(`says a turn holds the home in the reader's words, and leaves everything as it was`, async () => {
        clearHomeHistory.mockRejectedValue(new SandboxHttpError(409, `Your home conversation is working right now.`));
        startFreshHome.mockRejectedValue(new SandboxHttpError(500, `disk full`));
        const { chat, clearRecord } = conversationOf();
        expect(await homeMemory.clearHomeHistory(chat)).toBe(`Your home conversation is working right now: wait for it to finish, or stop it first.`);
        expect(await homeMemory.startFreshHome(chat)).toBe(`disk full`);
        expect(clearRecord).not.toHaveBeenCalled();
        expect(chat.session.value).toEqual(SESSION);
    });
});
