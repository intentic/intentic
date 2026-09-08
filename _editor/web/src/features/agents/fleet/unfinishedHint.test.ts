// The hover for work a session's last turn left open; load-bearing, like the unsent chip's, since the glyph's dot only
// says something was left.
// Two independent evidence halves (steps left, and the workspace's own check); each must read as a sentence alone and
// both together.
import { describe, expect, it } from "vitest";
import { unfinishedHint } from "./unfinishedHint";

const HOUR = 3_600_000;

describe(`unfinishedHint`, () => {
    // Count and next step are the hover's whole job: "3 of 7" says how far the session got, and the step names the work
    // in the agent's own words.
    it(`counts what was left and names what came next`, () => {
        expect(unfinishedHint({ at: 1_000, steps: { open: 3, total: 7, next: `Wire the badge into the card` } }, 1_000 + 2 * HOUR)).toBe(
            `Stopped with 3 of 7 steps unfinished, 2h: Wire the badge into the card`,
        );
    });

    // A list with one thing left is not "1 steps".
    it(`says one step in the singular`, () => {
        expect(unfinishedHint({ at: 1_000, steps: { open: 1, total: 1, next: `Run the suite` } }, 1_000)).toBe(
            `Stopped with 1 of 1 step unfinished, just now: Run the suite`,
        );
    });

    // An agent that kept no checklist leaves the check to speak alone: a failing gate is a fact about the tree, needing
    // no list behind it.
    it(`reports a red check on its own when there was no list`, () => {
        expect(unfinishedHint({ at: 1_000, check: `Verify before you finish` }, 1_000 + HOUR)).toBe(
            `Its own check was still failing, 1h: Verify before you finish`,
        );
    });

    // Both halves share one hover with the age said once: they're separate evidence (what the agent said it would do,
    // what the workspace measured), so separate sentences, but repeating the age would read as two different moments.
    it(`says both without repeating the age`, () => {
        expect(
            unfinishedHint(
                { at: 1_000, steps: { open: 2, total: 5, next: `Cover it with tests` }, check: `Verify before you finish` },
                1_000 + 2 * HOUR,
            ),
        ).toBe(`Stopped with 2 of 5 steps unfinished, 2h: Cover it with tests. Its own check was still failing too: Verify before you finish`);
    });

    // A step the daemon couldn't name (a harness whose frames carry no content) still reports the count, rather than
    // trailing a colon into nothing.
    it(`drops the step rather than rendering a hole when there is none to name`, () => {
        expect(unfinishedHint({ at: 1_000, steps: { open: 2, total: 5 } }, 1_000)).toBe(`Stopped with 2 of 5 steps unfinished, just now`);
    });

    // Age comes from the host's own tick, not the wall clock, since a settled card's props never change and a
    // self-reading clock would freeze at build time.
    it(`ages against the tick it is given rather than the wall clock`, () => {
        expect(unfinishedHint({ at: 1_000, steps: { open: 1, total: 2 } }, 1_000 + 3 * HOUR)).toContain(`unfinished, 3h`);
    });
});
