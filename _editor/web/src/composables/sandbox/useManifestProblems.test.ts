import { ManifestProblemsSchema } from "@intentic/sandbox-contract";
import { describe, expect, it } from "vitest";

/* The wire shape the notice is built from. Parsed rather than asserted structurally, because the browser's
 * whole claim here is that it renders what the daemon actually said — a report that does not survive the
 * contract's own schema is one the card would paint wrong. */

describe(`ManifestProblemsSchema`, () => {
    it(`accepts the three kinds the daemon reports`, () => {
        const parsed = ManifestProblemsSchema.parse([
            { path: `.intentic/config/settings.json`, problems: [{ kind: `unreadable`, detail: `the file is not valid JSON` }] },
            { path: `.intentic/config/capabilities.json`, problems: [{ kind: `invalidEntry`, detail: `gh — kind: required` }] },
        ]);
        expect(parsed.map((report) => report.path)).toEqual([`.intentic/config/settings.json`, `.intentic/config/capabilities.json`]);
    });

    it(`carries a suggestion when the daemon could name one, and tolerates its absence`, () => {
        const [guessed, unguessed] = ManifestProblemsSchema.parse([
            { path: `a.json`, problems: [{ kind: `unknownKey`, detail: `terseOutpt`, suggestion: `terseOutput` }] },
            { path: `b.json`, problems: [{ kind: `unknownKey`, detail: `somethingNew` }] },
        ]);
        expect(guessed?.problems[0]?.suggestion).toBe(`terseOutput`);
        expect(unguessed?.problems[0]?.suggestion).toBeUndefined();
    });

    it(`refuses a kind the card has no wording for`, () => {
        // The card switches on `kind`. A daemon inventing a fourth one must fail here rather than fall through
        // to the "one entry was skipped" branch and describe the wrong thing.
        expect(ManifestProblemsSchema.safeParse([{ path: `a.json`, problems: [{ kind: `something-else`, detail: `x` }] }]).success).toBe(false);
    });

    it(`reads an empty list as a healthy sandbox`, () => {
        expect(ManifestProblemsSchema.parse([])).toEqual([]);
    });
});
