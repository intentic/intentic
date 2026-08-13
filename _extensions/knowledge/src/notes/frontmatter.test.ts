import { describe, expect, it } from "vitest";
import { formatFrontmatter, parseFrontmatter } from "./frontmatter.js";

const fields = (content: string): Record<string, readonly string[]> => Object.fromEntries(parseFrontmatter(content).fields);

describe(`parseFrontmatter`, () => {
    it(`reads scalars, flow lists and block lists into one shape`, () => {
        expect(
            fields(`---
type: person
title: "Ada Lovelace"
aliases: [Ada, "Countess Lovelace"]
tags:
  - colleague
  - math
---
body`),
        ).toEqual({
            type: [`person`],
            title: [`Ada Lovelace`],
            aliases: [`Ada`, `Countess Lovelace`],
            tags: [`colleague`, `math`],
        });
    });

    it(`keeps the body byte-for-byte, so an edit to one field never reflows the prose`, () => {
        const body = `# Ada\n\nMet at the review.\n\n  indented line\n`;
        expect(parseFrontmatter(`---\ntype: person\n---\n${body}`).body).toBe(body);
    });

    it(`treats a file with no header as all body — the common case for a note somebody just started`, () => {
        const parsed = parseFrontmatter(`Just a thought.`);
        expect(parsed.present).toBe(false);
        expect(parsed.body).toBe(`Just a thought.`);
        expect([...parsed.fields]).toEqual([]);
    });

    /* The whole reason this is not a YAML parser. Every one of these is a fact about the world that YAML would
     * silently convert into something else, and a knowledge base exists to not lose facts. */
    it(`leaves values that YAML would coerce exactly as written`, () => {
        expect(
            fields(`---
answer: no
version: 1.0
released: 2026-08-09
country: NO
---
`),
        ).toEqual({ answer: [`no`], version: [`1.0`], released: [`2026-08-09`], country: [`NO`] });
    });

    it(`splits a flow list on commas outside quotes only`, () => {
        expect(fields(`---\naliases: ["Lovelace, Ada", Ada]\n---\n`)).toEqual({ aliases: [`Lovelace, Ada`, `Ada`] });
    });

    it(`keeps a # inside a value — tags are written with one, and this is not a comment introducer`, () => {
        expect(fields(`---\ntags: [#colleague]\nnote: red # not a comment\n---\n`)).toEqual({ tags: [`#colleague`], note: [`red # not a comment`] });
    });

    it(`skips a full-line comment`, () => {
        expect(fields(`---\n# who this is\ntype: person\n---\n`)).toEqual({ type: [`person`] });
    });

    it(`reports a key it cannot read instead of guessing at it`, () => {
        const parsed = parseFrontmatter(`---\ntype: person\nemployment:\n  company: Acme\n  since: 2020\n---\n`);
        expect(parsed.unreadable).toEqual([`employment`]);
        expect([...parsed.fields]).toEqual([[`type`, [`person`]]]);
    });

    it(`survives a mangled header with the note intact rather than throwing`, () => {
        expect(() => parseFrontmatter(`---\n: : :\n[[[\n---\nbody`)).not.toThrow();
        expect(parseFrontmatter(`---\n: : :\n---\nbody`).body).toBe(`body`);
    });

    it(`tolerates windows line endings, which a synced knowledge base will have`, () => {
        expect(fields(`---\r\ntype: person\r\n---\r\nbody`)).toEqual({ type: [`person`] });
    });
});

describe(`formatFrontmatter`, () => {
    it(`round-trips through the parser unchanged`, () => {
        const written = new Map([
            [`type`, [`person`]],
            [`aliases`, [`Ada`, `Countess Lovelace`]],
            [`works_on`, [`[[Intentic]]`]],
        ]);
        const parsed = parseFrontmatter(formatFrontmatter(written, `Met at the review.`));
        expect(Object.fromEntries(parsed.fields)).toEqual({
            type: [`person`],
            aliases: [`Ada`, `Countess Lovelace`],
            works_on: [`[[Intentic]]`],
        });
        expect(parsed.body).toBe(`Met at the review.`);
    });

    it(`writes a single value as a scalar, the way a person would`, () => {
        expect(formatFrontmatter(new Map([[`type`, [`person`]]]), ``)).toContain(`type: person`);
    });

    it(`quotes only what would otherwise change meaning`, () => {
        const out = formatFrontmatter(
            new Map([
                [`plain`, [`Ada Lovelace`]],
                [`link`, [`[[Intentic]]`]],
            ]),
            ``,
        );
        expect(out).toContain(`plain: Ada Lovelace`);
        expect(out).toContain(`link: "[[Intentic]]"`);
    });

    it(`drops a key with no values rather than writing an empty one`, () => {
        expect(formatFrontmatter(new Map([[`tags`, []]]), `body`)).toBe(`---\n\n---\nbody`);
    });
});
