import { DEFAULT_PRIVACY_SHIELD, PRIVACY_PATTERN_MAX, PrivacyShieldPolicySchema, patternProblem } from "./privacy.js";

// The owner's own patterns run on every string bound for an untrusted provider, in the daemon's one thread: one that
// cannot compile, matches empty text or nests a repeat inside a repeat is refused before it is saved.

describe(`patternProblem`, () => {
    it(`takes the patterns an ID or a customer number is written with`, () => {
        for (const pattern of [
            String.raw`EMP-\d{6}`,
            String.raw`\b[A-Z]{3}\d{6}\b`,
            String.raw`Customer:\s*(?<value>\d+)`,
            String.raw`(?:\d{3}-){2}\d{4}`,
            String.raw`[A-Z]{2}\d{2}(?:[ -]?\d{4}){3}`,
            String.raw`(?<=Ref\. )[A-Z0-9]+`,
            String.raw`(ab|cd)+`,
            String.raw`[(+*)]+x`,
        ]) {
            expect([pattern, patternProblem(pattern)]).toEqual([pattern, undefined]);
        }
    });

    it(`refuses one that does not compile, matches empty text or is too long`, () => {
        expect(patternProblem(`(unclosed`)).toBe(`invalid`);
        expect(patternProblem(String.raw`\p{Nope}`)).toBe(`invalid`);
        expect(patternProblem(String.raw`\d*`)).toBe(`empty`);
        expect(patternProblem(`a|`)).toBe(`empty`);
        expect(patternProblem(` `)).toBe(`empty`);
        expect(patternProblem(`a`.repeat(PRIVACY_PATTERN_MAX + 1))).toBe(`tooLong`);
    });

    it(`refuses a variable repeat inside a variable repeat, the shape that backtracks for minutes`, () => {
        expect(patternProblem(`(a+)+b`)).toBe(`nested`);
        expect(patternProblem(String.raw`(\w+\s?)*!`)).toBe(`nested`);
        expect(patternProblem(String.raw`(?:x(?:\d{2,})?)+y`)).toBe(`nested`);
        expect(patternProblem(String.raw`(?<id>\d+-?){2,}z`)).toBe(`nested`);
        // A fixed count is no variable repeat, inside or out.
        expect(patternProblem(String.raw`(\d{3}-?){3}`)).toBeUndefined();
        expect(patternProblem(String.raw`(\d{3}){2,}`)).toBeUndefined();
    });
});

describe(`PrivacyShieldPolicySchema`, () => {
    it(`reads a policy written before the owner's lists and rules as having none`, () => {
        expect(PrivacyShieldPolicySchema.parse({ mode: `on` })).toMatchObject({ dictionary: { off: [], lists: [] }, rules: [] });
        expect(DEFAULT_PRIVACY_SHIELD.rules).toEqual([]);
    });

    it(`fills a rule's defaults and keeps a stored pattern whatever a later build judges of it`, () => {
        const parsed = PrivacyShieldPolicySchema.parse({
            rules: [{ id: `r1`, title: `Nested`, class: `identity-document`, match: `pattern`, pattern: `(a+)+` }],
        });
        expect(parsed.rules[0]).toEqual({
            id: `r1`,
            title: `Nested`,
            on: true,
            class: `identity-document`,
            match: `pattern`,
            terms: [],
            pattern: `(a+)+`,
            matchCase: false,
        });
    });
});
