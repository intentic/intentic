import {
    CANARY_PATIENCE_MS,
    capForRoom,
    createFanOutGovernor,
    type HeldStart,
    type Lane,
    PROVEN_FOR_MS,
    siblingNewsWords,
} from "../fan-out-governor.js";

/* 2026-10-17: three children went onto a Cursor nothing had proven that day and all three were refused, the parent
   hearing of the first only after its whole fan-out was out. One goes first now; the rest wait on its answer. */

const OPUS: Lane = { provider: "cursor", model: "claude-opus-5-5" };
let clock = 1_000_000;
const now = (): number => clock;

const settle = async (): Promise<void> => {
    for (let index = 0; index < 5; index += 1) {
        await Promise.resolve();
    }
};

// A held start that records what became of it; `spent` makes its own preflight refuse it, as the records would.
const held = (governor: ReturnType<typeof createFanOutGovernor>, childId: string, spent = false) => {
    const fate: string[] = [];
    const start: HeldStart = {
        childId,
        lane: OPUS,
        start: async () => {
            if (spent) {
                fate.push("abandoned");
                return false;
            }
            fate.push("started");
            return true;
        },
        abandon: async (why) => void fate.push(`abandoned: ${why}`),
        cancel: () => void fate.push("seat given back"),
    };
    governor.hold(start);
    return fate;
};

beforeEach(() => {
    clock = 1_000_000;
});

test("a lane nothing has proven takes one child, and its siblings start once it is answered", async () => {
    const governor = createFanOutGovernor(now);
    expect(governor.admit("sub-1", OPUS, undefined)).toEqual({ go: true });
    const second = governor.admit("sub-2", OPUS, undefined);
    expect(second).toMatchObject({ go: false, reason: expect.stringContaining("`sub-1`") });
    const fate = held(governor, "sub-2");
    governor.answered("sub-1");
    await settle();
    expect(fate).toEqual(["started"]);
    // Proven now: the next one goes at once.
    expect(governor.admit("sub-3", OPUS, undefined)).toEqual({ go: true });
    governor.reset();
});

test("a canary refused before answering hands its siblings to the records: the next goes first, a spent one is handed back", async () => {
    const governor = createFanOutGovernor(now);
    governor.admit("sub-1", OPUS, undefined);
    governor.admit("sub-2", OPUS, undefined);
    governor.admit("sub-3", OPUS, undefined);
    const two = held(governor, "sub-2", true);
    const three = held(governor, "sub-3");
    governor.ended("sub-1", { answered: false, failure: "You're out of usage." });
    await settle();
    // sub-2's records said spent, so it was handed back; sub-3 went as the next canary.
    expect(two).toEqual(["abandoned"]);
    expect(three).toEqual(["started"]);
    expect(governor.news("cursor")).toMatchObject([{ childId: "sub-1", failure: "You're out of usage." }]);
    governor.reset();
});

test("a slow canary does not hold its siblings past its patience", async () => {
    jest.useFakeTimers();
    try {
        const governor = createFanOutGovernor(now);
        governor.admit("sub-1", OPUS, undefined);
        governor.admit("sub-2", OPUS, undefined);
        const fate = held(governor, "sub-2");
        jest.advanceTimersByTime(CANARY_PATIENCE_MS + 1);
        await settle();
        expect(fate).toEqual(["started"]);
        governor.reset();
    } finally {
        jest.useRealTimers();
    }
});

test("a lane proven long ago is probed again", () => {
    const governor = createFanOutGovernor(now);
    governor.admit("sub-1", OPUS, undefined);
    governor.answered("sub-1");
    governor.ended("sub-1", { answered: true, failure: undefined });
    clock += PROVEN_FOR_MS + 1;
    governor.admit("sub-2", OPUS, undefined);
    expect(governor.admit("sub-3", OPUS, undefined)).toMatchObject({ go: false });
    governor.reset();
});

test("a provider with little room left takes few children at once, and the rest start as one ends", async () => {
    const governor = createFanOutGovernor(now);
    const CODEX: Lane = { provider: "codex", model: "gpt-6.1-sol" };
    governor.admit("sub-0", CODEX, undefined);
    governor.answered("sub-0");
    governor.ended("sub-0", { answered: true, failure: undefined });
    expect(capForRoom(25)).toBe(2);
    expect(capForRoom(9)).toBe(1);
    expect(capForRoom(57)).toBeUndefined();
    expect(governor.admit("sub-1", CODEX, 2)).toEqual({ go: true });
    expect(governor.admit("sub-2", CODEX, 2)).toEqual({ go: true });
    expect(governor.admit("sub-3", CODEX, 2)).toMatchObject({ go: false, reason: expect.stringContaining("codex") });
    const fate: string[] = [];
    governor.hold({ childId: "sub-3", lane: CODEX, start: async () => fate.push("started") > 0, abandon: async () => undefined, cancel: () => undefined });
    governor.ended("sub-1", { answered: true, failure: undefined });
    await settle();
    expect(fate).toEqual(["started"]);
    governor.reset();
});

test("a held start withdrawn by a cancel never starts", async () => {
    const governor = createFanOutGovernor(now);
    governor.admit("sub-1", OPUS, undefined);
    governor.admit("sub-2", OPUS, undefined);
    const fate = held(governor, "sub-2");
    expect(governor.withdraw("sub-2")).toBe(true);
    governor.answered("sub-1");
    await settle();
    expect(fate).toEqual(["seat given back"]);
    governor.reset();
});

test("a spawn result names what its siblings just ran into", () => {
    const words = siblingNewsWords(
        [{ childId: "sub-1", lane: OPUS, at: clock - 120_000, failure: "[role_forbidden] Cloud Agent is not available." }],
        clock,
    );
    expect(words).toContain("`sub-1` on cursor/claude-opus-5-5, 2 min ago");
    expect(siblingNewsWords([], clock)).toBeUndefined();
});

test("a lane a canary's patience let go is suspect again once a start on it is refused before answering", () => {
    const governor = createFanOutGovernor(now);
    governor.admit("sub-1", OPUS, undefined);
    governor.answered("sub-1");
    governor.admit("sub-2", OPUS, undefined);
    governor.ended("sub-2", { answered: false, failure: "out of usage" });
    governor.admit("sub-3", OPUS, undefined);
    expect(governor.admit("sub-4", OPUS, undefined)).toMatchObject({ go: false });
    governor.reset();
});

test("a lane any turn was just answered on needs no canary", () => {
    const governor = createFanOutGovernor(now);
    governor.served(OPUS);
    expect(governor.admit("sub-1", OPUS, undefined)).toEqual({ go: true });
    expect(governor.admit("sub-2", OPUS, undefined)).toEqual({ go: true });
    governor.reset();
});
