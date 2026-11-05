import { type NamedSandbox, sandboxOfSegment, sandboxSegment, sandboxSlug } from "./sandbox-segment.js";

/* An address names its sandbox by name and the tail of its id; these pin that the segment written is read back to the
   same sandbox among the reader's, whatever the name says. */

const INTENTIC: NamedSandbox = { id: `cmtu1eqyv0001dawma7zi4n3i`, name: `Intentic` };
const API: NamedSandbox = { id: `cmtu1f0aa0002dawmk82p1q7`, name: `My API` };
const LISTED = [INTENTIC, API];

describe(`a sandbox's name as words`, () => {
    it(`lowercases it, drops accents and joins the words with dashes`, () => {
        expect(sandboxSlug(`My API`)).toBe(`my-api`);
        expect(sandboxSlug(`  Café — Ünïcode!! `)).toBe(`cafe-unicode`);
        expect(sandboxSlug(`🚀`)).toBe(``);
    });

    it(`cuts a long name back to a whole word`, () => {
        const slug = sandboxSlug(`the quick brown fox jumps over the lazy dog and keeps on running`);
        expect(slug).toBe(`the-quick-brown-fox-jumps-over-the-lazy`);
        expect(slug.length).toBeLessThanOrEqual(40);
        expect(sandboxSlug(`a`.repeat(60))).toBe(`a`.repeat(40));
    });
});

describe(`a sandbox's segment`, () => {
    it(`is its name's words and the last six characters of its id`, () => {
        expect(sandboxSegment(INTENTIC, LISTED)).toBe(`intentic-zi4n3i`);
        expect(sandboxSegment(API, LISTED)).toBe(`my-api-82p1q7`);
    });

    it(`is the key alone for a name with no words`, () => {
        expect(sandboxSegment({ ...INTENTIC, name: `🚀` }, LISTED)).toBe(`zi4n3i`);
    });

    it(`carries more of the id while another listed one ends the same way`, () => {
        const twin: NamedSandbox = { id: `cmtu9zzzz0009xxxxq7zi4n3i`, name: `Twin` };
        expect(sandboxSegment(INTENTIC, [...LISTED, twin])).toBe(`intentic-a7zi4n3i`);
        expect(sandboxSegment(twin, [...LISTED, twin])).toBe(`twin-q7zi4n3i`);
    });

    it(`is the whole id for one with no tail to stand for it`, () => {
        expect(sandboxSegment({ id: `e2e-sandbox`, name: `E2E` }, [])).toBe(`e2e-sandbox`);
        expect(sandboxSegment({ id: `sb2`, name: `Two` }, [])).toBe(`sb2`);
    });
});

describe(`the sandbox a segment names`, () => {
    it(`reads back every segment written, for every listed sandbox`, () => {
        for (const sandbox of LISTED) {
            expect(sandboxOfSegment(sandboxSegment(sandbox, LISTED), LISTED)).toBe(sandbox);
        }
    });

    it(`reads a whole id, as addresses from before named it`, () => {
        expect(sandboxOfSegment(INTENTIC.id, LISTED)).toBe(INTENTIC);
        const odd = { id: `e2e-sandbox`, name: `E2E` };
        expect(sandboxOfSegment(`e2e-sandbox`, [odd])).toBe(odd);
    });

    it(`ignores the name, so an address from before a rename still opens the sandbox`, () => {
        expect(sandboxOfSegment(`old-name-zi4n3i`, LISTED)).toBe(INTENTIC);
        expect(sandboxOfSegment(`zi4n3i`, LISTED)).toBe(INTENTIC);
    });

    it(`lets the name decide between two whose ids end alike, and names none when it cannot`, () => {
        const twin: NamedSandbox = { id: `cmtu9zzzz0009xxxxq7zi4n3i`, name: `Twin` };
        const both = [...LISTED, twin];
        expect(sandboxOfSegment(`twin-zi4n3i`, both)).toBe(twin);
        expect(sandboxOfSegment(`other-zi4n3i`, both)).toBeUndefined();
    });

    it(`names none for a key too short, or one no listed id ends with`, () => {
        expect(sandboxOfSegment(`intentic-n3i`, LISTED)).toBeUndefined();
        expect(sandboxOfSegment(`intentic-abcdef`, LISTED)).toBeUndefined();
        expect(sandboxOfSegment(`intentic-zi4n3i`, [])).toBeUndefined();
    });
});
