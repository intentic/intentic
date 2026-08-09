import { describe, expect, it } from "vitest";
import { buildIndex, overviewOf } from "./index-vault.js";
import type { NoteFile } from "./note.js";

const file = (path: string, content: string): NoteFile => ({ path, content, modifiedAt: 1_700_000_000_000, sizeBytes: content.length });

const VAULT: NoteFile[] = [
    file(
        `_vocabulary.md`,
        `---
type: vocabulary
types: [person, project, decision]
relations: [works_on, knows, about]
---
What the words mean.`,
    ),
    file(
        `people/ada-lovelace.md`,
        `---
type: person
aliases: [Ada]
tags: [colleague]
works_on: ["[[Intentic]]"]
knows: ["[[Charles Babbage]]"]
---
Wrote the first program. See [[decisions/why-extensions]].`,
    ),
    file(`people/charles-babbage.md`, `---\ntype: person\n---\nBuilt the engine.`),
    file(`projects/intentic.md`, `---\ntype: project\ntitle: Intentic\n---\nThe workspace.`),
    file(
        `decisions/why-extensions.md`,
        `---
type: decision
about: ["[[Intentic]]"]
supersedes: ["[[decisions/why-plugins]]"]
---
Lean core, everything else an extension.`,
    ),
    file(`stray-thought.md`, `Nothing links here and it links nowhere.`),
];

const index = buildIndex(VAULT);

describe(`buildIndex`, () => {
    it(`resolves a link by filename, by title, by alias and by full path`, () => {
        expect(index.resolve(`ada-lovelace`)?.path).toBe(`people/ada-lovelace.md`);
        expect(index.resolve(`Ada`)?.path).toBe(`people/ada-lovelace.md`);
        expect(index.resolve(`Intentic`)?.path).toBe(`projects/intentic.md`);
        expect(index.resolve(`projects/intentic.md`)?.path).toBe(`projects/intentic.md`);
        expect(index.resolve(`decisions/why-extensions`)?.path).toBe(`decisions/why-extensions.md`);
    });

    it(`resolves case-insensitively, the way every vault does`, () => {
        expect(index.resolve(`CHARLES BABBAGE`)?.path).toBe(`people/charles-babbage.md`);
    });

    it(`keeps a link to a note nobody has written, rather than dropping it`, () => {
        const broken = index.edges.filter((edge) => edge.to === undefined);
        expect(broken).toEqual([{ from: `decisions/why-extensions.md`, to: undefined, target: `decisions/why-plugins`, relation: `supersedes` }]);
    });

    it(`answers what links HERE, with the relationship that carried each link`, () => {
        expect(index.backlinks.get(`projects/intentic.md`)?.map((edge) => [edge.from, edge.relation])).toEqual([
            [`decisions/why-extensions.md`, `about`],
            [`people/ada-lovelace.md`, `works_on`],
        ]);
    });

    it(`does not count a note linking to itself as a backlink`, () => {
        const selfish = buildIndex([file(`a.md`, `---\ntype: person\nknows: ["[[a]]"]\n---\n`)]);
        expect(selfish.backlinks.get(`a.md`)).toBeUndefined();
        expect(selfish.outgoing.get(`a.md`)).toHaveLength(1);
    });

    it(`prefers a note NAMED something over one that merely lists it as an alias, whatever the file order`, () => {
        const files = [file(`zz-decoy.md`, `---\naliases: [Ada]\n---\n`), file(`ada.md`, `---\ntype: person\n---\n`)];
        expect(buildIndex(files).resolve(`Ada`)?.path).toBe(`ada.md`);
        expect(buildIndex(files.toReversed()).resolve(`Ada`)?.path).toBe(`ada.md`);
    });

    it(`records an ambiguous name and still resolves it deterministically`, () => {
        const twins = buildIndex([file(`b/ada.md`, `---\ntype: person\n---\n`), file(`a/ada.md`, `---\ntype: person\n---\n`)]);
        expect(twins.ambiguous.get(`ada`)).toEqual([`a/ada.md`, `b/ada.md`]);
        expect(twins.resolve(`ada`)?.path).toBe(`a/ada.md`);
    });

    it(`reads the vocabulary off the note that declares it`, () => {
        expect(index.vocabulary).toEqual({
            types: [`person`, `project`, `decision`],
            relations: [`works_on`, `knows`, `about`],
            path: `_vocabulary.md`,
        });
    });
});

describe(`overviewOf`, () => {
    const overview = overviewOf(index);

    it(`counts the kinds of thing in the vault, commonest first`, () => {
        expect(overview.types).toEqual([
            { name: `person`, count: 2 },
            { name: `decision`, count: 1 },
            { name: `project`, count: 1 },
            { name: `vocabulary`, count: 1 },
        ]);
    });

    it(`lists the links pointing at notes nobody has written`, () => {
        expect(overview.broken).toEqual([{ from: `decisions/why-extensions.md`, target: `decisions/why-plugins`, relation: `supersedes` }]);
    });

    it(`finds the note that fell out of the graph entirely`, () => {
        expect(overview.orphans).toEqual([`stray-thought.md`]);
    });

    it(`names the notes with no kind, which no typed question can ever reach`, () => {
        expect(overview.untyped).toEqual([`stray-thought.md`]);
    });

    /* The vocabulary is a habit, not a gate: an undeclared word is REPORTED and the note holding it is still
     * perfectly readable. This is what lets an agent capture something new mid-task without stalling. */
    it(`reports a kind and a relationship the vocabulary has not adopted`, () => {
        const drifted = buildIndex([...VAULT, file(`vendors/acme.md`, `---\ntype: vendor\ninvoices: ["[[Intentic]]"]\n---\n`)]);
        const report = overviewOf(drifted);
        expect(report.typeDrift).toEqual([{ word: `vendor`, uses: 1, notes: [`vendors/acme.md`] }]);
        expect(report.relationDrift).toEqual([
            { word: `invoices`, uses: 1, notes: [`vendors/acme.md`] },
            { word: `supersedes`, uses: 1, notes: [`decisions/why-extensions.md`] },
        ]);
    });

    it(`reports nothing as drift in a vault that has declared no vocabulary`, () => {
        const undeclared = overviewOf(buildIndex([file(`a.md`, `---\ntype: whatever\nlinks_to: ["[[b]]"]\n---\n`)]));
        expect(undeclared.typeDrift).toEqual([]);
        expect(undeclared.relationDrift).toEqual([]);
    });

    it(`announces a header it could not read, so a mangled note is never silently half-indexed`, () => {
        const mangled = overviewOf(buildIndex([file(`a.md`, `---\ntype: person\nemployment:\n  company: Acme\n---\n`)]));
        expect(mangled.unreadable).toEqual([{ path: `a.md`, keys: [`employment`] }]);
    });

    it(`handles an empty vault without inventing anything`, () => {
        expect(overviewOf(buildIndex([]))).toMatchObject({ noteCount: 0, linkCount: 0, types: [], orphans: [], broken: [] });
    });
});
