import { sandboxSummary } from "../../../testing/sandboxSummary";
import { touched } from "../setupArrival";

// A row's history is what was done with it, never that it was found again.
describe(`a row with history`, () => {
    it(`is one whose code was redeemed, whose machine reported, or that checked in`, () => {
        expect(touched(sandboxSummary({ id: `a`, lastSeenAt: null }))).toBe(false);
        expect(touched(sandboxSummary({ id: `b`, lastSeenAt: null, setupCodeClaimedAt: `2026-10-26T10:00:00Z` }))).toBe(true);
        expect(touched(sandboxSummary({ id: `c`, lastSeenAt: `2026-10-26T10:00:00Z` }))).toBe(true);
    });

    it(`reads an older row's missing fields as nothing done`, () => {
        const { setupCodeClaimedAt: _claimed, setupReport: _report, ...older } = sandboxSummary({ id: `d`, lastSeenAt: null });
        // SAFETY: an older platform's row, from before these two fields: the reader takes them as optional.
        expect(touched(older as Parameters<typeof touched>[0])).toBe(false);
    });
});
