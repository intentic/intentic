import type { CheckMarker } from "../freshSession";
import { foldStamps, type Stamp, stampMark, stampsOf, stampTone } from "./stamps";

// No mocks: stamps are a pure projection of the card's own proof and the checks the fleet ran on its work.

const review = (marker: Partial<CheckMarker> = {}): CheckMarker => ({ kind: `review`, by: `r1`, own: false, state: `clean`, stale: false, ...marker });
const test = (marker: Partial<CheckMarker> = {}): CheckMarker => ({ kind: `test`, by: `t1`, own: false, state: `done`, stale: false, ...marker });

describe(`stampsOf`, () => {
    it(`stamps only what ran: nothing for a turn that proved nothing, and no check nobody started`, () => {
        expect(stampsOf(undefined, [])).toEqual([]);
        expect(stampsOf({ verification: `unproven` }, [])).toEqual([]);
        expect(stampsOf({ unviewed: 2 }, [])).toEqual([]);
    });

    it(`stamps the agent's own check with the command that spoke and what it changed unseen`, () => {
        expect(stampsOf({ verification: `verified`, check: `pnpm test`, unviewed: 1 }, [])).toEqual([
            { kind: `self`, outcome: `passed`, stale: false, check: `pnpm test`, unviewed: 1 },
        ]);
        expect(stampsOf({ verification: `failing` }, [])).toEqual([{ kind: `self`, outcome: `failed`, stale: false }]);
    });

    it(`keeps one order on every card: the agent's own check, then each kind in the contract's order`, () => {
        const kinds = stampsOf({ verification: `verified` }, [test(), review()]).map((stamp) => stamp.kind);
        expect(kinds).toEqual([`self`, `review`, `test`]);
    });

    it(`reads a review's tally as open findings, or as passed once none is left open`, () => {
        const [open] = stampsOf(undefined, [review({ state: `findings`, findings: 3, open: 1 })]);
        expect(open).toMatchObject({ outcome: `findings`, findings: 3, open: 1 });
        const [handled] = stampsOf(undefined, [review({ state: `findings`, findings: 3, open: 0 })]);
        expect(handled).toMatchObject({ outcome: `passed`, findings: 3 });
        expect(stampsOf(undefined, [review()])[0]?.outcome).toBe(`passed`);
    });

    it(`carries where a check ran, so its card can open that chat`, () => {
        expect(stampsOf(undefined, [review({ by: `self-id`, own: true })])[0]).toMatchObject({ by: `self-id`, own: true });
    });
});

const stamp = (fields: Partial<Stamp>): Stamp => ({ kind: `review`, outcome: `passed`, stale: false, ...fields });

describe(`stampMark`, () => {
    // Nothing beside a glyph means nothing needs you.
    it(`marks only what needs the reader: open findings by count, a failure by !`, () => {
        expect(stampMark(stamp({}))).toBeUndefined();
        expect(stampMark(stamp({ outcome: `done` }))).toBeUndefined();
        expect(stampMark(stamp({ outcome: `running` }))).toBeUndefined();
        expect(stampMark(stamp({ outcome: `findings`, findings: 3, open: 2 }))).toBe(`2`);
        expect(stampMark(stamp({ outcome: `findings`, findings: 14, open: 12 }))).toBe(`9+`);
        expect(stampMark(stamp({ kind: `self`, outcome: `failed` }))).toBe(`!`);
    });

    it(`marks nothing on a stale stamp, whose work has moved on`, () => {
        expect(stampMark(stamp({ outcome: `findings`, findings: 3, open: 3, stale: true }))).toBeUndefined();
        expect(stampMark(stamp({ outcome: `failed`, stale: true }))).toBeUndefined();
    });
});

describe(`stampTone`, () => {
    it(`greens a pass on a live card and quiets it on a receipt`, () => {
        expect(stampTone(stamp({}), false)).toBe(`text-success`);
        expect(stampTone(stamp({}), true)).toBe(`text-faint`);
    });

    it(`keeps a failure and open findings in their tone on a receipt too`, () => {
        expect(stampTone(stamp({ outcome: `failed` }), true)).toBe(`text-danger`);
        expect(stampTone(stamp({ outcome: `findings`, open: 1 }), true)).toBe(`text-warning`);
    });

    // An answer in prose ran but gave no verdict: green would claim one.
    it(`draws a prose answer in plain ink, and a stale stamp faint`, () => {
        expect(stampTone(stamp({ kind: `test`, outcome: `done` }), false)).toBe(`text-muted`);
        expect(stampTone(stamp({ outcome: `failed`, stale: true }), false)).toBe(`text-faint`);
        expect(stampTone(stamp({ outcome: `running` }), true)).toBe(`text-link`);
    });
});

describe(`foldStamps`, () => {
    it(`draws every stamp that fits`, () => {
        const stamps = [stamp({ kind: `self` }), stamp({})];
        expect(foldStamps(stamps, 3)).toEqual({ shown: stamps, folded: 0 });
    });

    it(`keeps the stamps that need you when it folds, in their own order`, () => {
        const self = stamp({ kind: `self` });
        const reviewed = stamp({ kind: `review`, outcome: `findings`, findings: 1, open: 1 });
        const tested = stamp({ kind: `test`, outcome: `failed` });
        expect(foldStamps([self, reviewed, tested], 2)).toEqual({ shown: [reviewed, tested], folded: 1 });
        expect(foldStamps([self, reviewed, tested], 1)).toEqual({ shown: [reviewed], folded: 2 });
    });
});
