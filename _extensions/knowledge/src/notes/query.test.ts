import { describe, expect, it } from "vitest";
import { buildIndex } from "./index-notes.js";
import type { NoteFile } from "./note.js";
import { neighbourhood, search } from "./query.js";

const file = (path: string, content: string, modifiedAt = 1_700_000_000_000): NoteFile => ({
    path,
    content,
    modifiedAt,
    sizeBytes: content.length,
});

const index = buildIndex([
    file(`people/ada-lovelace.md`, `---\ntype: person\naliases: [Ada]\ntags: [colleague]\nworks_on: ["[[Intentic]]"]\n---\nWrote the first program.`),
    file(`people/charles-babbage.md`, `---\ntype: person\ntags: [colleague]\nknows: ["[[Ada]]"]\n---\nBuilt the engine Ada wrote for.`),
    file(`projects/intentic.md`, `---\ntype: project\ntitle: Intentic\ntags: [work]\n---\nThe workspace. Ada works on it.`),
    file(`projects/intentic-rollout.md`, `---\ntype: project\n---\nRolling Intentic out.`),
    file(`decisions/why-extensions.md`, `---\ntype: decision\nabout: ["[[Intentic]]"]\n---\nLean core.`),
]);

const paths = (hits: readonly { path: string }[]): string[] => hits.map((hit) => hit.path);

describe(`search`, () => {
    it(`puts the note actually called that first, ahead of every note that mentions it`, () => {
        expect(paths(search(index, { query: `Intentic` }))[0]).toBe(`projects/intentic.md`);
    });

    it(`finds a note by an alias it goes by`, () => {
        const hit = search(index, { query: `Ada` })[0];
        expect(hit?.path).toBe(`people/ada-lovelace.md`);
        expect(hit?.matched).toBe(`alias`);
    });

    it(`ranks a name match over a body match, and says which it was`, () => {
        const hits = search(index, { query: `Ada` });
        expect(hits[0]).toMatchObject({ path: `people/ada-lovelace.md`, matched: `alias` });
        expect(hits.slice(1).map((hit) => hit.matched)).toEqual([`body`, `body`]);
    });

    /* A knowledge note keeps its most lookup-worthy facts in the header, where the prose never repeats them. */
    it(`finds a note by a fact in its header, and shows the fact as the evidence`, () => {
        const withFacts = buildIndex([file(`people/ada.md`, `---\ntype: person\nemployer: Analytical Engines Ltd\n---\nWrote the first program.`)]);
        expect(search(withFacts, { query: `analytical engines` })[0]).toMatchObject({
            path: `people/ada.md`,
            matched: `field`,
            snippet: `employer: Analytical Engines Ltd`,
        });
    });

    it(`carries the line a body match was found on, so a hit explains itself`, () => {
        const hit = search(index, { query: `engine` })[0];
        expect(hit?.path).toBe(`people/charles-babbage.md`);
        expect(hit?.snippet).toBe(`Built the engine Ada wrote for.`);
    });

    /* A snippet is shown as evidence under a title, not rendered — so the markers that only mean something to a
     * renderer read as damage. The words themselves are never touched. */
    it(`shows a matched line as words rather than as markup`, () => {
        const marked = buildIndex([
            file(`a.md`, `---\ntype: term\n---\n- The **client-generated** UUID sent to [[Checkout API|the API]], not \`stripe.key\`.`),
        ]);
        expect(search(marked, { query: `uuid` })[0]?.snippet).toBe(`The client-generated UUID sent to the API, not stripe.key.`);
    });

    it(`leaves a long unfinished wiki link intact without regex backtracking`, () => {
        const line = `needle ${"[[Z|\\".repeat(20_000)}`;
        const malformed = buildIndex([file(`a.md`, `---\ntype: term\n---\n${line}`)]);
        const snippet = search(malformed, { query: `needle` })[0]?.snippet;
        expect(snippet?.length).toBe(line.length);
        expect(snippet?.startsWith("needle [[Z|\\")).toBe(true);
    });

    it(`filters by kind and by tag`, () => {
        expect(paths(search(index, { type: `person` }))).toEqual([`people/ada-lovelace.md`, `people/charles-babbage.md`]);
        expect(paths(search(index, { tag: `work` }))).toEqual([`projects/intentic.md`]);
    });

    it(`answers "everything about this note" from the links pointing at it`, () => {
        expect(paths(search(index, { linkedTo: `Intentic` })).toSorted()).toEqual([`decisions/why-extensions.md`, `people/ada-lovelace.md`]);
    });

    it(`combines a filter with words`, () => {
        expect(paths(search(index, { query: `intentic`, type: `project` }))).toEqual([`projects/intentic.md`, `projects/intentic-rollout.md`]);
    });

    it(`treats an empty query as "everything the filters allow", newest first`, () => {
        const dated = buildIndex([file(`a.md`, `---\ntype: person\n---\n`, 1_000), file(`b.md`, `---\ntype: person\n---\n`, 2_000)]);
        expect(paths(search(dated, {}))).toEqual([`b.md`, `a.md`]);
    });

    it(`returns nothing rather than everything when a word matches nothing`, () => {
        expect(search(index, { query: `zzz-not-here` })).toEqual([]);
    });

    it(`honours a limit`, () => {
        expect(search(index, { limit: 2 })).toHaveLength(2);
    });
});

describe(`neighbourhood`, () => {
    it(`gathers everything one step out, following links in both directions`, () => {
        const view = neighbourhood(index, `Intentic`, 1);
        expect(view.focus).toBe(`projects/intentic.md`);
        expect(paths(view.nodes).toSorted()).toEqual([`decisions/why-extensions.md`, `people/ada-lovelace.md`, `projects/intentic.md`]);
    });

    it(`reaches further at depth 2, and marks how far out each note sits`, () => {
        const view = neighbourhood(index, `Intentic`, 2);
        expect(view.nodes.find((node) => node.path === `people/charles-babbage.md`)?.depth).toBe(2);
    });

    it(`draws no edge to a note it did not draw`, () => {
        const view = neighbourhood(index, `Intentic`, 1);
        const drawn = new Set(paths(view.nodes));
        expect(view.edges.every((edge) => drawn.has(edge.from) && edge.to !== undefined && drawn.has(edge.to))).toBe(true);
    });

    it(`answers empty for a note that is not there, rather than guessing`, () => {
        expect(neighbourhood(index, `nobody`, 2)).toEqual({ focus: undefined, nodes: [], edges: [], omitted: 0 });
    });

    it(`says out loud how many neighbours did not fit rather than silently dropping them`, () => {
        const hub = buildIndex([
            file(`hub.md`, `---\ntype: project\n---\n${Array.from({ length: 80 }, (_, i) => `[[n${i}]]`).join(` `)}`),
            ...Array.from({ length: 80 }, (_, i) => file(`n${i}.md`, `---\ntype: term\n---\n`)),
        ]);
        const view = neighbourhood(hub, `hub`, 1);
        expect(view.nodes).toHaveLength(60);
        expect(view.omitted).toBe(21);
    });
});
