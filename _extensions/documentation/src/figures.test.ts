import { describe, expect, it } from "vitest";
import type { DocIndex, RepoDoc } from "./docModel.js";
import { packageFigures } from "./figures.js";

/* The figures a page never writes. What matters here is not how they look — the app draws them — but that they
 * are built from the index and therefore cannot disagree with it, and that each one declines to render when it
 * would say nothing. */

const provenance = { sourceRev: `abc123`, generatedAt: 1_785_000_000_000 };

const entry = (dir: string, loc: number, extra: Record<string, unknown> = {}) => ({
    dir,
    oneLiner: `${dir}.`,
    anchors: [],
    files: 3,
    loc,
    hasTests: true,
    readmeRev: `r`,
    updatedAt: 1,
    stale: false,
    behind: 0,
    ...extra,
});

const index = {
    repo: `intentic`,
    generatedAt: 1,
    entries: [entry(`_deploy/graph`, 563), entry(`_deploy/engine`, 1539), entry(`_deploy/cli`, 6201)],
    edges: [
        { from: `_deploy/cli`, to: `_deploy/graph`, dev: false },
        { from: `_deploy/engine`, to: `_deploy/graph`, dev: false },
        { from: `_deploy/graph`, to: `_tools/tsconfig`, dev: true },
    ],
    orphans: [],
    undocumented: [],
} as DocIndex;

const repoDoc = {
    repo: `intentic`,
    components: [
        { id: `deploy`, name: `Deployment engine`, oneLiner: `x`, packages: [`_deploy/graph`, `_deploy/engine`, `_deploy/cli`], accent: `5` },
    ],
    glossary: [],
    reading: [],
    provenance,
} as RepoDoc;

// Each figure is a fence whose body is JSON; the renderer degrades a fence that does not parse to a code block,
// so "it parses" is the contract every one of them has to meet.
const bodies = (markdown: string): Record<string, unknown>[] =>
    [...markdown.matchAll(/```(?:dag|bars|stats)\n([\s\S]*?)\n```/g)].map((match) => JSON.parse(match[1] ?? ``) as Record<string, unknown>);

describe(`packageFigures`, () => {
    it(`emits valid JSON in every fence`, () => {
        const markdown = packageFigures(`_deploy/graph`, index, repoDoc);
        expect(() => bodies(markdown)).not.toThrow();
        expect(bodies(markdown)).toHaveLength(3);
    });

    it(`takes its measures from the index rather than from anything authored`, () => {
        const markdown = packageFigures(`_deploy/graph`, index, repoDoc);
        const stats = bodies(markdown)[0] as { items: { label: string; value: string }[] };
        expect(stats.items).toEqual([
            { label: `Lines`, value: `563` },
            { label: `Files`, value: `3` },
            // Two edges point AT this package; the third points away from it and must not be counted here.
            { label: `Used by`, value: `2 packages` },
            { label: `Tests`, value: `yes` },
        ]);
    });

    it(`draws dependents and dependencies in one direction, and marks a dev edge weaker`, () => {
        const dag = bodies(packageFigures(`_deploy/graph`, index, repoDoc))[1] as {
            edges: { from: string; to: string; dashed?: boolean }[];
        };
        // An arrow always points at what a package depends on, whichever side of this package the edge is on.
        expect(dag.edges).toContainEqual({ from: `_deploy/cli`, to: `_deploy/graph` });
        expect(dag.edges).toContainEqual({ from: `_deploy/graph`, to: `_tools/tsconfig`, dashed: true });
    });

    it(`gives every node its component's accent, so diagrams across the set agree`, () => {
        const dag = bodies(packageFigures(`_deploy/graph`, index, repoDoc))[1] as { nodes: { id: string; accent: string }[] };
        expect(dag.nodes.find((node) => node.id === `_deploy/graph`)?.accent).toBe(`5`);
        // A package the map never placed still draws, in the neutral slot, rather than borrowing someone's colour.
        expect(dag.nodes.find((node) => node.id === `_tools/tsconfig`)?.accent).toBe(`neutral`);
    });

    it(`omits the size comparison when there is nothing to compare against`, () => {
        // A component of one draws a bar chart with one bar, which is a number wearing a costume.
        const alone = { ...repoDoc, components: [{ id: `c`, name: `C`, oneLiner: `x`, packages: [`_deploy/graph`], accent: `1` }] } as RepoDoc;
        expect(bodies(packageFigures(`_deploy/graph`, index, alone))).toHaveLength(2);
    });

    it(`says nothing at all about a directory the index does not know`, () => {
        // The ordinary state of a page whose index has not been regenerated yet — it must cost the figures, not
        // the page.
        expect(packageFigures(`_libs/unknown`, index, repoDoc)).toBe(``);
        expect(packageFigures(`_deploy/graph`, undefined, repoDoc)).toBe(``);
    });
});
