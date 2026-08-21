import { describe, expect, it } from "vitest";
import { componentOfPackage, parseDocIndex, parseRepoDoc, type RepoDoc } from "./docModel.js";

/* A document set is written by a model into a repository the owner then reads, so every parser here is total: a
 * field that arrives malformed must cost that field, never the page. The exception, and the only one: is
 * provenance, which is required, because a document nobody can date is a document nobody can trust. */

const provenance = { sourceRev: `abc123`, generatedAt: 1_785_000_000_000 };
const withProvenance = (body: Record<string, unknown>): string => JSON.stringify({ ...body, provenance });

describe(`parseRepoDoc`, () => {
    it(`reads the map`, () => {
        const doc = parseRepoDoc(
            withProvenance({
                repo: `intentic`,
                components: [{ id: `wire`, name: `The wire`, oneLiner: `One sentence.`, packages: [`_sandbox/sandbox-contract`], accent: `1` }],
                glossary: [{ term: `panel`, means: `A repo's dev server.` }],
                reading: [`_sandbox/sandbox-contract`, `_sandbox/sandbox`],
            }),
        );
        expect(doc?.components[0]).toEqual({
            id: `wire`,
            name: `The wire`,
            oneLiner: `One sentence.`,
            packages: [`_sandbox/sandbox-contract`],
            accent: `1`,
        });
        expect(doc?.glossary).toEqual([{ term: `panel`, means: `A repo's dev server.` }]);
        expect(doc?.reading).toEqual([`_sandbox/sandbox-contract`, `_sandbox/sandbox`]);
    });

    it(`accepts the workspace root repo, whose name is legitimately empty`, () => {
        // `repo: ""` is the /work repo itself. Checking truthiness rather than presence would reject it.
        expect(parseRepoDoc(withProvenance({ repo: `` }))?.repo).toBe(``);
    });

    it(`refuses a document with no provenance`, () => {
        expect(parseRepoDoc(JSON.stringify({ repo: `x`, components: [] }))).toBeUndefined();
        expect(parseRepoDoc(JSON.stringify({ repo: `x`, provenance: { generatedAt: 1 } }))).toBeUndefined();
        expect(parseRepoDoc(JSON.stringify({ repo: `x`, provenance: { sourceRev: `a` } }))).toBeUndefined();
    });

    it(`drops unusable components and glossary terms without losing the rest`, () => {
        const doc = parseRepoDoc(
            withProvenance({
                repo: `r`,
                components: [{ id: `a`, oneLiner: `Kept.` }, { oneLiner: `No id.` }, `nonsense`],
                glossary: [{ term: `t`, means: `m` }, { term: `no means` }],
            }),
        );
        expect(doc?.components).toHaveLength(1);
        // A component with no `name` is named by its id rather than dropped: the id is authored and readable.
        expect(doc?.components[0]).toMatchObject({ id: `a`, name: `a` });
        expect(doc?.glossary).toHaveLength(1);
    });

    it(`ignores an accent outside the palette's slots`, () => {
        const doc = parseRepoDoc(withProvenance({ repo: `r`, components: [{ id: `a`, oneLiner: `x`, accent: `9` }] }));
        expect(doc?.components[0]?.accent).toBeUndefined();
    });

    it(`returns undefined for malformed JSON and for non-objects`, () => {
        expect(parseRepoDoc(`{ nope`)).toBeUndefined();
        expect(parseRepoDoc(`[]`)).toBeUndefined();
        expect(parseRepoDoc(``)).toBeUndefined();
    });
});

/* There is no `parsePackageDoc`: a package has no JSON document. Everything the app knows about one that is not
 * its README's prose arrives in the generated index, which is what these cover. */
describe(`parseDocIndex`, () => {
    it(`reads the generated index, including a package's derived anchors and measures`, () => {
        const index = parseDocIndex(
            JSON.stringify({
                repo: `r`,
                generatedAt: 5,
                entries: [
                    {
                        dir: `_deploy/graph`,
                        name: `@intentic/graph`,
                        oneLiner: `The desired-state IR.`,
                        anchors: [{ path: `_deploy/graph/src/compile.ts`, line: 42, what: `RawNode map → graph.` }],
                        files: 11,
                        loc: 563,
                        hasTests: true,
                        readmeRev: `abc`,
                        updatedAt: 7,
                        stale: true,
                        reason: `it points at a file that is gone`,
                        behind: 0,
                    },
                ],
                edges: [{ from: `_deploy/cli`, to: `_deploy/graph`, dev: false }],
                orphans: [`gone`],
                undocumented: [`b`],
            }),
        );
        expect(index?.entries[0]).toMatchObject({ dir: `_deploy/graph`, name: `@intentic/graph`, loc: 563, hasTests: true, stale: true });
        expect(index?.entries[0]?.anchors[0]).toEqual({ path: `_deploy/graph/src/compile.ts`, line: 42, what: `RawNode map → graph.` });
        expect(index?.edges).toEqual([{ from: `_deploy/cli`, to: `_deploy/graph`, dev: false }]);
        expect(index?.orphans).toEqual([`gone`]);
        expect(index?.undocumented).toEqual([`b`]);
    });

    it(`drops an anchor with no reason, because the reason is the point of an anchor`, () => {
        const index = parseDocIndex(
            JSON.stringify({ repo: `r`, entries: [{ dir: `d`, anchors: [{ path: `a.ts`, what: `Kept.` }, { path: `b.ts` }] }] }),
        );
        expect(index?.entries[0]?.anchors).toEqual([{ path: `a.ts`, what: `Kept.`, line: undefined }]);
    });

    it(`rejects a line number of zero rather than rendering a link to line 0`, () => {
        // Anchors are 1-indexed like every other path:line in this workspace.
        const index = parseDocIndex(JSON.stringify({ repo: `r`, entries: [{ dir: `d`, anchors: [{ path: `a.ts`, what: `w`, line: 0 }] }] }));
        expect(index?.entries[0]?.anchors[0]?.line).toBeUndefined();
    });

    it(`treats a missing stale flag as not stale rather than as unknown`, () => {
        const index = parseDocIndex(JSON.stringify({ repo: `r`, entries: [{ dir: `a` }] }));
        expect(index?.entries[0]).toMatchObject({ dir: `a`, stale: false, behind: 0, oneLiner: ``, loc: 0, files: 0, hasTests: false });
    });

    it(`answers an empty edge list rather than undefined, so a figure can always iterate it`, () => {
        expect(parseDocIndex(JSON.stringify({ repo: `r` }))?.edges).toEqual([]);
    });
});

describe(`componentOfPackage`, () => {
    const doc: RepoDoc = {
        repo: `r`,
        components: [
            { id: `wire`, name: `The wire`, oneLiner: `x`, packages: [`_libs/contract`] },
            { id: `app`, name: `The app`, oneLiner: `y`, packages: [`_editor/web`, `_platform/api`] },
        ],
        glossary: [],
        reading: [],
        provenance,
    };

    it(`inverts the map's component → packages relation`, () => {
        // The file declares one direction (the direction a human authors in); every reader wants the other. It is
        // derived so the file never holds the same fact twice.
        expect(componentOfPackage(doc, `_platform/api`)?.id).toBe(`app`);
        expect(componentOfPackage(doc, `_libs/contract`)?.id).toBe(`wire`);
    });

    it(`answers undefined for a package the map never placed`, () => {
        expect(componentOfPackage(doc, `_tools/nope`)).toBeUndefined();
    });
});
