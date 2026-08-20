import type { DocIndex, DocIndexEntry, RepoDoc } from "./docModel.js";

/* THE FIGURES NOBODY WRITES.
 *
 * Every figure on a package page is built here, from the derived index, and rendered above the prose. None of it
 * is authored, and that is the point: the layout this replaced had agents hand-writing line counts, file counts
 * and neighbour lists into `doc.md` as JSON fences. Those were 62% of the bytes in the document tree and the
 * single largest source of rot in it, a number typed into a page is wrong the next time anyone commits, and
 * nothing about reviewing a page catches it.
 *
 * So the split the rest of this extension already draws, a script computes facts, a model authors judgement,
 * finally reaches the figures too. An author writes a `dag` fence only for something the dependency graph cannot
 * say (a request's path, a state machine, an ordering), and those still render inline exactly where they are
 * written. Everything measurable is drawn from here and cannot go stale.
 *
 * The output is markdown, not components, because the page is already a <Markdown> render and the figure fences
 * are already a thing that renderer knows how to draw. Emitting text keeps this module pure and testable and
 * lets a figure fail the way any other fence does, as a code block, costing itself and not the page. */

// Enough neighbours to show the shape, few enough to stay readable. A package everything depends on would
// otherwise draw a diagram nobody can follow, and the title says exactly what was left out.
const MAX_NEIGHBOURS = 5;

const compact = (value: number): string => (value >= 1000 ? `${(value / 1000).toFixed(1)}k` : `${value}`);

const accents = (repoDoc: RepoDoc | undefined): ReadonlyMap<string, string> => {
    const byDir = new Map<string, string>();
    for (const component of repoDoc?.components ?? []) {
        for (const dir of component.packages) {
            byDir.set(dir, component.accent ?? `neutral`);
        }
    }
    return byDir;
};

// The last segment of a package dir. `_deploy/graph` is "graph" on a node label, the prefix is the same for every
// package in the group and spends width saying nothing.
const leaf = (dir: string): string => dir.slice(dir.lastIndexOf(`/`) + 1);

const statsFigure = (entry: DocIndexEntry, usedBy: number): string =>
    [
        "```stats",
        JSON.stringify({
            items: [
                { label: `Lines`, value: compact(entry.loc) },
                { label: `Files`, value: `${entry.files}` },
                { label: `Used by`, value: usedBy === 1 ? `1 package` : `${usedBy} packages` },
                { label: `Tests`, value: entry.hasTests ? `yes` : `none` },
            ],
        }),
        "```",
    ].join(`\n`);

/* The neighbourhood: what this package uses, and what uses it. Direction is always "an arrow points at what a
 * package depends on", so the reader learns one rule and every diagram in the set obeys it. */
const neighbourFigure = (dir: string, index: DocIndex, repoDoc: RepoDoc | undefined): string | undefined => {
    const accentOf = accents(repoDoc);
    const uses = index.edges.filter((edge) => edge.from === dir);
    const usedBy = index.edges.filter((edge) => edge.to === dir);
    if (uses.length === 0 && usedBy.length === 0) {
        return undefined;
    }
    const shownUses = uses.slice(0, MAX_NEIGHBOURS);
    const shownUsedBy = usedBy.slice(0, MAX_NEIGHBOURS);
    const nodes = [
        { id: dir, label: leaf(dir), note: `this package`, accent: accentOf.get(dir) ?? `neutral` },
        ...shownUses.map((edge) => ({ id: edge.to, label: leaf(edge.to), note: `it uses`, accent: accentOf.get(edge.to) ?? `neutral` })),
        ...shownUsedBy.map((edge) => ({ id: edge.from, label: leaf(edge.from), note: `uses it`, accent: accentOf.get(edge.from) ?? `neutral` })),
    ];
    const edges = [
        ...shownUses.map((edge) => ({ from: dir, to: edge.to, ...(edge.dev ? { dashed: true } : {}) })),
        ...shownUsedBy.map((edge) => ({ from: edge.from, to: dir, ...(edge.dev ? { dashed: true } : {}) })),
    ];
    const title = `Its neighbours (showing ${shownUses.length} of ${uses.length} it uses, ${shownUsedBy.length} of ${usedBy.length} that use it)`;
    return ["```dag", JSON.stringify({ title, direction: `LR`, nodes, edges }), "```"].join(`\n`);
};

// How big this package is next to the others in its component. Skipped when the component is unknown or has
// nothing to compare against, a bar chart of one bar is a number wearing a costume.
const sizeFigure = (entry: DocIndexEntry, index: DocIndex, repoDoc: RepoDoc | undefined): string | undefined => {
    const component = repoDoc?.components.find((candidate) => candidate.packages.includes(entry.dir));
    if (component === undefined) {
        return undefined;
    }
    const siblings = index.entries.filter((candidate) => component.packages.includes(candidate.dir) && candidate.loc > 0);
    if (siblings.length < 2) {
        return undefined;
    }
    return [
        "```bars",
        JSON.stringify({
            title: `Size within ${component.name}`,
            items: siblings
                .toSorted((left, right) => right.loc - left.loc)
                .map((sibling) => ({
                    label: sibling.dir === entry.dir ? `${leaf(sibling.dir)} (this one)` : leaf(sibling.dir),
                    value: sibling.loc,
                    display: compact(sibling.loc),
                    accent: component.accent ?? `neutral`,
                })),
        }),
        "```",
    ].join(`\n`);
};

/* Everything drawn above a package's prose, as one markdown string, or "" when the index has nothing to say
 * about this directory, which is the ordinary state of a page whose index has not been regenerated yet. The view
 * renders it as its own <Markdown>, so a malformed fence here cannot disturb the README below it. */
export const packageFigures = (dir: string, index: DocIndex | undefined, repoDoc: RepoDoc | undefined): string => {
    const entry = index?.entries.find((candidate) => candidate.dir === dir);
    if (index === undefined || entry === undefined) {
        return ``;
    }
    const usedBy = index.edges.filter((edge) => edge.to === dir).length;
    return [statsFigure(entry, usedBy), neighbourFigure(dir, index, repoDoc), sizeFigure(entry, index, repoDoc)]
        .filter((figure) => figure !== undefined)
        .join(`\n\n`);
};
