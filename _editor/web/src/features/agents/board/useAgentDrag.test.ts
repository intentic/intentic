import { mocked } from "@intentic/testing/bun";
import type { ResolveAsk } from "../fleet/agentActions";

// The board's presses: which channel each outcome reports on, and a second press on a card while its first is out.
// Browser-needing modules and agentActions are stubbed; the per-card store is real, with an empty roster under it.
const stub = {
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
    // Cards the store answers `agentById` with, and what each press of the watch's Stop asked the store to do.
    agents: new Map<string, { watches?: { id: string }[]; jobs?: { id: string; watch?: string; endedAt?: number }[] }>(),
    unwatched: new Set<string>(),
    stoppedJobs: new Set<string>(),
};

jest.mock("../fleet/useAgents", () => ({
    useAgents: () => ({
        fleet: stub.fleet,
        refresh: async () => undefined,
        notice: stub.notice,
        stopWatching: async (id: string) => {
            stub.unwatched.add(id);
        },
        stopJob: async (id: string, jobId: string) => {
            stub.stoppedJobs.add(`${id}/${jobId}`);
        },
        agentById: (id: string) => stub.agents.get(id),
    }),
}));
jest.mock("../fleet/fleetScope", () => ({ otherFleet: { value: [] } }));
jest.mock("../../../shell/notifications/notifications", () => ({
    useNotifications: () => ({
        say: (message: string) => stub.said.push(message),
    }),
}));
jest.mock("../../sandbox/live/fleetAcross", () => ({ refreshAcross: () => undefined, otherBoxes: { value: [] } }));
jest.mock("../fleet/useAgents-registry", () => ({ registry: { value: [] } }));
jest.mock("../fleet/agentActions", () => ({
    askAgentToResolve: jest.fn(() => new Promise((settle) => stub.asks.push(settle))),
    landAgent: jest.fn(() => new Promise((settle) => stub.lands.push(settle))),
    discardAgent: jest.fn(async () => undefined),
    invalidateAgentAction: jest.fn(async () => undefined),
    stopAgent: jest.fn(async () => undefined),
    nothingLanded: () => stub.nothingLanded,
}));

const { askAgentToResolve, landAgent } = await import("../fleet/agentActions");
const { pendingOn } = await import("../fleet/useAgents-provisional");
const { useAgentDrag } = await import("./useAgentDrag");

afterEach(() => {
    stub.agents.clear();
    stub.unwatched.clear();
    stub.stoppedJobs.clear();
    stub.asks.length = 0;
    stub.lands.length = 0;
    stub.said.length = 0;
    stub.notice.value = undefined;
    mocked(askAgentToResolve).mockClear();
    mocked(landAgent).mockClear();
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
    const { resolveNow } = useAgentDrag();

    const first = resolveNow(`a`);
    await resolveNow(`a`);

    expect(askAgentToResolve).toHaveBeenCalledTimes(1);
    expect(pendingOn(`a`)).toBe(`resolve`);

    stub.asks[0]?.({ kind: `sent` });
    await first;
    expect(pendingOn(`a`)).toBeUndefined();
});

// On a phone a card's land asks first, naming what goes where; the press itself goes only once confirmed, and never
// after a cancel. A desktop press states itself and goes at once.
describe("a land pressed on a card", () => {
    const CARD = { id: `a`, sandboxId: undefined, title: `Lane E`, diff: { files: 12, insertions: 40, deletions: 3 } };

    it("on a phone waits for the confirm, naming the card and its files, then lands the way it was pressed", async () => {
        const { pressLand, pendingLand, confirmLand } = useAgentDrag();
        await pressLand(CARD, `reland`, true);
        expect(landAgent).not.toHaveBeenCalled();
        expect(pendingLand.value).toEqual({ id: `a`, at: undefined, chosen: `reland`, title: `Lane E`, files: 12 });
        confirmLand();
        expect(pendingLand.value).toBeUndefined();
        expect(landAgent).toHaveBeenCalledWith(`a`, `check`, `cumulative`, false, undefined);
        stub.lands[0]?.({ landed: true, changed: true });
    });

    it("on a phone lands nothing once cancelled", async () => {
        const { pressLand, pendingLand, cancelLand, confirmLand } = useAgentDrag();
        await pressLand(CARD, `land`, true);
        cancelLand();
        confirmLand();
        expect(pendingLand.value).toBeUndefined();
        expect(landAgent).not.toHaveBeenCalled();
    });

    it("elsewhere goes at once", async () => {
        const { pressLand, pendingLand } = useAgentDrag();
        const pressed = pressLand(CARD, `land`, false);
        expect(pendingLand.value).toBeUndefined();
        expect(landAgent).toHaveBeenCalledWith(`a`, `check`, `outstanding`, false, undefined);
        stub.lands[0]?.({ landed: true, changed: true });
        await pressed;
    });
});

// 2026-10-04: a card whose watch waited on an `npm exec` at its prompt was cleared, and the command sat on in its pane
// for hours. The watch's Stop ends what the watch waits on.
it("the watch's Stop ends the command a job's watch waits on, and only disarms a watch no job holds", async () => {
    const { unwatchNow } = useAgentDrag();
    stub.agents.set(`held`, { watches: [{ id: `watch-q9xp` }], jobs: [{ id: `job-9672`, watch: `watch-q9xp` }, { id: `job-old`, watch: `watch-gone`, endedAt: 1 }] });
    await unwatchNow(`held`);
    expect([...stub.stoppedJobs]).toEqual([`held/job-9672`]);
    expect([...stub.unwatched]).toEqual([]);

    stub.agents.set(`ci`, { watches: [{ id: `watch-ci` }], jobs: [] });
    await unwatchNow(`ci`);
    expect([...stub.stoppedJobs]).toEqual([`held/job-9672`]);
    expect([...stub.unwatched]).toEqual([`ci`]);
});
