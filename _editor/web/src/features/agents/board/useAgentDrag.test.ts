import { it, expect, afterEach, mock } from "bun:test";
import { mocked, hoisted } from "@intentic/testing/bun";
import type { ResolveAsk } from "../fleet/agentActions";

// The board's presses, one per card: asserts scoping only, that two in-flight actions are two states the board can
// show, not one slot the second overwrites. Browser-needing modules and agentActions are stubbed, since the whole
// question is what the board looks like while calls are held open.
const stub = hoisted(() => ({
    fleet: { value: [] as unknown[] },
    notice: { value: undefined as string | undefined },
    // The deferred halves of the two calls under test, so a test can leave one out and settle the other.
    asks: [] as ((answer: ResolveAsk) => void)[],
    lands: [] as ((answer: { landed: boolean; changed: boolean }) => void)[],
    // The app's one self-retiring receipt lane, so a test can tell an outcome from a failure by which channel it took.
    said: [] as string[],
    // The shared sentence both land presses take, held here so a test proves they pass the same one rather than each
    // inventing its own wording.
    nothingLanded: `Nothing to land: this conversation's branch holds no work your workspace doesn't already have.`,
}));

mock.module("../fleet/useAgents", () => ({
    useAgents: () => ({
        fleet: stub.fleet,
        refresh: async () => undefined,
        notice: stub.notice,
        stopWatching: async () => undefined,
    }),
}));
mock.module("../fleet/fleetScope", () => ({ otherFleet: { value: [] } }));
mock.module("../../../shell/notifications/notifications", () => ({
    useNotifications: () => ({
        say: (message: string) => stub.said.push(message),
    }),
}));
mock.module("../../sandbox/live/fleetAcross", () => ({ refreshAcross: () => undefined }));
mock.module("../fleet/agentActions", () => ({
    askAgentToResolve: mock(() => new Promise((settle) => stub.asks.push(settle))),
    landAgent: mock(() => new Promise((settle) => stub.lands.push(settle))),
    discardAgent: mock(async () => undefined),
    invalidateAgentAction: mock(async () => undefined),
    stopAgent: mock(async () => undefined),
    nothingLanded: () => stub.nothingLanded,
}));

const { askAgentToResolve } = await import("../fleet/agentActions");
const { useAgentDrag } = await import("./useAgentDrag");

afterEach(() => {
    stub.asks.length = 0;
    stub.lands.length = 0;
    stub.said.length = 0;
    stub.notice.value = undefined;
    mocked(askAgentToResolve).mockClear();
});

// TWO KINDS OF "the turn didn't go", ONE OF WHICH IS GOOD NEWS. The board's notice strip is a red bar that shifts the
// layout and waits to be dismissed, which is right for a refusal and wrong for a press that found nothing left to do and
// put the card right. That one takes the floating receipt instead, so the reader isn't warned about a repair.
it("reports a press that repaired the card as an outcome, and a refusal as a failure", async () => {
    const { resolveNow } = useAgentDrag();

    const repaired = resolveNow(`a`);
    stub.asks[0]?.({ kind: `settled`, why: `Nothing is blocking this any more: it's ready to land.` });
    await repaired;
    expect(stub.said).toEqual([`Nothing is blocking this any more: it's ready to land.`]);
    expect(stub.notice.value).toBeUndefined();

    const refused = resolveNow(`b`);
    stub.asks[1]?.({ kind: `refused`, why: `A rebase can't reach this.` });
    await refused;
    expect(stub.notice.value).toBe(`A rebase can't reach this.`);
    expect(stub.said).toHaveLength(1);
});

// The third kind: a turn opened in the chat and never taken (a Stop mid-read, a refusal at the door). The chat already
// said why, where it happened; a strip here would be the same sentence twice, and a receipt would call it news.
it("says nothing for a press the chat has already answered for", async () => {
    const { resolveNow } = useAgentDrag();

    const dropped = resolveNow(`a`);
    stub.asks[0]?.({ kind: `dropped` });
    await dropped;

    expect(stub.notice.value).toBeUndefined();
    expect(stub.said).toEqual([]);
});

// The board must not share one `{id, action}` slot across cards: a second press must not clear or override the first
// card's own pending state.
it("keeps each card spinning until ITS OWN action lands, not until the next press or the first answer", async () => {
    const { resolveNow, pendingOn } = useAgentDrag();

    const first = resolveNow(`a`);
    const second = resolveNow(`b`);

    expect(pendingOn(`a`)).toBe(`resolve`);
    expect(pendingOn(`b`)).toBe(`resolve`);

    stub.asks[0]?.({ kind: `sent` });
    await first;

    // The card that answered goes quiet; the one still waiting on the daemon does not.
    expect(pendingOn(`a`)).toBeUndefined();
    expect(pendingOn(`b`)).toBe(`resolve`);

    stub.asks[1]?.({ kind: `sent` });
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

    stub.asks[0]?.({ kind: `sent` });
    await here;
    expect(pendingOn(`a`)).toBeUndefined();
    expect(pendingOn(`a`, `box-2`)).toBe(`land`);

    stub.lands[0]?.({ landed: true, changed: true });
    await there;
    expect(pendingOn(`a`, `box-2`)).toBeUndefined();
});

// THE THIRD KIND OF "the press didn't do anything", and the one that used to pass for success. Merged-and-nothing-moved
// refuses nothing, so it takes neither the danger strip nor a throw — and the card carries no trace of it either way, so
// saying nothing left a press that did nothing looking exactly like one that worked.
it("gives a land that carried nothing the receipt, not silence and not the danger strip", async () => {
    const { landNow } = useAgentDrag();

    const carried = landNow(`a`);
    stub.lands[0]?.({ landed: true, changed: true });
    await carried;
    expect(stub.said).toEqual([]);
    expect(stub.notice.value).toBeUndefined();

    const empty = landNow(`b`);
    stub.lands[1]?.({ landed: true, changed: false });
    await empty;
    expect(stub.said).toEqual([stub.nothingLanded]);
    expect(stub.notice.value).toBeUndefined();
});

// Re-entry on one card stays a no-op: the card is dimmed and pointer-inert while its action is out, so a second press
// is a double-click.
it("refuses a second press on the same card while its action is still out", async () => {
    const { resolveNow, pendingOn } = useAgentDrag();

    const first = resolveNow(`a`);
    await resolveNow(`a`);

    expect(askAgentToResolve).toHaveBeenCalledTimes(1);
    expect(pendingOn(`a`)).toBe(`resolve`);

    stub.asks[0]?.({ kind: `sent` });
    await first;
    expect(pendingOn(`a`)).toBeUndefined();
});
