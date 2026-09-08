import { afterEach, expect, it, vi } from "vitest";

// The board's presses, one per card: asserts scoping only, that two in-flight actions are two states the board can
// show, not one slot the second overwrites. Browser-needing modules and agentActions are stubbed, since the whole
// question is what the board looks like while calls are held open.
const stub = vi.hoisted(() => ({
    fleet: { value: [] as unknown[] },
    notice: { value: undefined as string | undefined },
    // The deferred halves of the two calls under test, so a test can leave one out and settle the other.
    asks: [] as ((answer: { sent: boolean; why?: string }) => void)[],
    lands: [] as ((answer: { landed: boolean }) => void)[],
}));

vi.mock("../fleet/useAgents", () => ({
    useAgents: () => ({
        fleet: stub.fleet,
        refresh: async () => undefined,
        notice: stub.notice,
        stopWatching: async () => undefined,
    }),
}));
vi.mock("../fleet/fleetScope", () => ({ otherFleet: { value: [] } }));
vi.mock("../../sandbox/live/fleetAcross", () => ({ refreshAcross: () => undefined }));
vi.mock("../fleet/agentActions", () => ({
    askAgentToResolve: vi.fn(() => new Promise((settle) => stub.asks.push(settle))),
    landAgent: vi.fn(() => new Promise((settle) => stub.lands.push(settle))),
    discardAgent: vi.fn(async () => undefined),
    invalidateAgentAction: vi.fn(async () => undefined),
    stopAgent: vi.fn(async () => undefined),
}));

const { askAgentToResolve } = await import("../fleet/agentActions");
const { useAgentDrag } = await import("./useAgentDrag");

afterEach(() => {
    stub.asks.length = 0;
    stub.lands.length = 0;
    stub.notice.value = undefined;
    vi.mocked(askAgentToResolve).mockClear();
});

// The board must not share one `{id, action}` slot across cards: a second press must not clear or override the first
// card's own pending state.
it("keeps each card spinning until ITS OWN action lands, not until the next press or the first answer", async () => {
    const { resolveNow, pendingOn } = useAgentDrag();

    const first = resolveNow(`a`);
    const second = resolveNow(`b`);

    expect(pendingOn(`a`)).toBe(`resolve`);
    expect(pendingOn(`b`)).toBe(`resolve`);

    stub.asks[0]?.({ sent: true });
    await first;

    // The card that answered goes quiet; the one still waiting on the daemon does not.
    expect(pendingOn(`a`)).toBeUndefined();
    expect(pendingOn(`b`)).toBe(`resolve`);

    stub.asks[1]?.({ sent: true });
    await second;
    expect(pendingOn(`b`)).toBeUndefined();
});

// Agent ids are minted per daemon, so the same id can appear on two cards from two boxes; keying in-flight by id alone
// would spin both from one press.
it("tells two boxes' cards with the same id apart", async () => {
    const { resolveNow, landNow, pendingOn } = useAgentDrag();

    const here = resolveNow(`a`);
    const there = landNow(`a`, `box-2`);

    expect(pendingOn(`a`)).toBe(`resolve`);
    expect(pendingOn(`a`, `box-2`)).toBe(`land`);

    stub.asks[0]?.({ sent: true });
    await here;
    expect(pendingOn(`a`)).toBeUndefined();
    expect(pendingOn(`a`, `box-2`)).toBe(`land`);

    stub.lands[0]?.({ landed: true });
    await there;
    expect(pendingOn(`a`, `box-2`)).toBeUndefined();
});

// Re-entry on one card stays a no-op: the card is dimmed and pointer-inert while its action is out, so a second press
// is a double-click.
it("refuses a second press on the same card while its action is still out", async () => {
    const { resolveNow, pendingOn } = useAgentDrag();

    const first = resolveNow(`a`);
    await resolveNow(`a`);

    expect(askAgentToResolve).toHaveBeenCalledTimes(1);
    expect(pendingOn(`a`)).toBe(`resolve`);

    stub.asks[0]?.({ sent: true });
    await first;
    expect(pendingOn(`a`)).toBeUndefined();
});
