import { describe, expect, it } from "vitest";
import { factsOf, type NoteFile, parseNote, relationsOf, titleFromSlug } from "./note.js";

const file = (path: string, content: string): NoteFile => ({ path, content, modifiedAt: 1_700_000_000_000, sizeBytes: content.length });

const note = (content: string, path = `people/ada-lovelace.md`) => parseNote(file(path, content));

describe(`parseNote`, () => {
    it(`takes its title from the header, then a heading, then the filename`, () => {
        expect(note(`---\ntitle: Ada Lovelace\n---\n# Something else`).title).toBe(`Ada Lovelace`);
        expect(note(`---\ntype: person\n---\n# Ada Lovelace\n`).title).toBe(`Ada Lovelace`);
        expect(note(`no header at all`).title).toBe(`Ada lovelace`);
    });

    /* THE ONTOLOGY, READ OUT OF THE FORMAT THE VAULT ALREADY HAD. A link in a header field is a typed edge; the
     * same link in the prose is an untyped one. Nothing else distinguishes them, which is why no sidecar and no
     * schema is needed to have a graph. */
    it(`reads a link in a header field as a relationship named by that field`, () => {
        expect(note(`---\ntype: person\nworks_on: ["[[Intentic]]", "[[iq]]"]\n---\n`).links).toEqual([
            { target: `Intentic`, label: undefined, relation: `works_on` },
            { target: `iq`, label: undefined, relation: `works_on` },
        ]);
    });

    it(`reads a link in the prose as a connection with no relationship`, () => {
        expect(note(`---\ntype: person\n---\nWorks with [[Charles Babbage|Charles]] most days.`).links).toEqual([
            { target: `Charles Babbage`, label: `Charles`, relation: undefined },
        ]);
    });

    it(`does not read the reserved header keys as relationships`, () => {
        expect(note(`---\ntitle: "[[not a link]]"\ntags: ["[[nor this]]"]\n---\n`).links).toEqual([]);
    });

    it(`ignores links and tags shown as examples in code, so the vault can document its own format`, () => {
        const parsed = note(`---\ntype: term\n---\nWrite it as \`[[Intentic]]\` or:\n\n\`\`\`\n[[Example]] #demo\n\`\`\`\n`);
        expect(parsed.links).toEqual([]);
        expect(parsed.tags).toEqual([]);
    });

    it(`collects tags from the header and the prose, deduped and lowercased`, () => {
        expect(note(`---\ntags: [Colleague, "#math"]\n---\nSaw her at #math and #standup.`).tags).toEqual([`colleague`, `math`, `standup`]);
    });

    it(`does not read a markdown heading as a tag`, () => {
        expect(note(`---\ntype: person\n---\n# Ada\n\n## Notes\n`).tags).toEqual([]);
    });

    it(`carries the unreadable keys through so the vault can report them`, () => {
        expect(note(`---\ntype: person\nemployment:\n  company: Acme\n---\n`).unreadable).toEqual([`employment`]);
    });

    it(`survives an empty file`, () => {
        const parsed = note(``, `stub.md`);
        expect(parsed.title).toBe(`Stub`);
        expect(parsed.type).toBeUndefined();
        expect(parsed.links).toEqual([]);
    });
});

describe(`relationsOf and factsOf`, () => {
    const parsed = note(`---
type: person
title: Ada Lovelace
tags: [colleague]
employer: Analytical Engines Ltd
works_on: ["[[Intentic]]"]
knows: ["[[Charles Babbage]]"]
---
`);

    it(`names the relationships a note holds, once each`, () => {
        expect(relationsOf(parsed)).toEqual([`works_on`, `knows`]);
    });

    it(`keeps a header field that is not a link as a plain fact, and leaves the reserved ones out`, () => {
        expect(factsOf(parsed)).toEqual([[`employer`, [`Analytical Engines Ltd`]]]);
    });
});

describe(`titleFromSlug`, () => {
    it(`makes a filename legible without title-casing it into a product name`, () => {
        expect(titleFromSlug(`iq-failure-analysis`)).toBe(`Iq failure analysis`);
        expect(titleFromSlug(`ada_lovelace`)).toBe(`Ada lovelace`);
    });
});
