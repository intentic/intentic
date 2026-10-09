import { type DraftPhase, draftPhase, draftReceipts } from "./draftingReceipts";

// A sandbox rebuild used to end in "Couldn't write a commit message for …": the daemon forgets drafts on restart, and a
// reload paints the roster saved before it, so a draft from that copy vanished under the first live frame and read as a
// failure. Only what this window watched happen on an agent it already knew is worth a receipt.

const frame = (...entries: [string, DraftPhase][]): ReadonlyMap<string, DraftPhase> => new Map(entries);

test("reads a draft's phase off the roster: none, still writing, or how it ended", () => {
    expect(draftPhase(undefined)).toBe(`none`);
    expect(draftPhase({ startedAt: 1, steps: [] })).toBe(`running`);
    expect(draftPhase({ startedAt: 1, steps: [], outcome: `written`, finishedAt: 2 })).toBe(`written`);
    expect(draftPhase({ startedAt: 1, steps: [], outcome: `failed`, reason: `no model`, finishedAt: 2 })).toBe(`failed`);
});

test("a land's draft is announced when it starts, and again when it is written or fails", () => {
    expect(draftReceipts(frame([`a`, `none`]), frame([`a`, `running`]))).toEqual([{ id: `a`, kind: `started` }]);
    expect(draftReceipts(frame([`a`, `running`]), frame([`a`, `written`]))).toEqual([{ id: `a`, kind: `written` }]);
    expect(draftReceipts(frame([`a`, `running`]), frame([`a`, `failed`]))).toEqual([{ id: `a`, kind: `failed` }]);
    // A second land of the same agent drafts again.
    expect(draftReceipts(frame([`a`, `written`]), frame([`a`, `running`]))).toEqual([{ id: `a`, kind: `started` }]);
});

test("a draft that vanishes with no outcome is not a failure: the daemon restarted, or withdrew it", () => {
    expect(draftReceipts(frame([`a`, `running`]), frame([`a`, `none`]))).toEqual([]);
    expect(draftReceipts(frame([`a`, `running`]), frame())).toEqual([]);
});

test("a roster painted whole is not news: nothing is announced for an agent the window had not seen", () => {
    // A reload painting the saved roster, or a reconnect re-reading the fleet into an empty frame.
    expect(draftReceipts(frame(), frame([`a`, `running`], [`b`, `failed`], [`c`, `written`]))).toEqual([]);
    // Nothing moved.
    expect(draftReceipts(frame([`a`, `failed`]), frame([`a`, `failed`]))).toEqual([]);
});
