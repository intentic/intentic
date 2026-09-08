import type { DocIndex, DocIndexEntry, RepoDoc } from "./docModel.js";

// Every figure on a package page is computed here from the derived index, never authored, so it cannot go stale like a
// hand-written number would. Output is markdown text, not components, so a malformed fence fails as an isolated code
// block, not a page crash.

// Enough neighbours to show the shape without drawing an unreadable diagram for a package everything depends on.
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

// Last segment of a package dir, for node labels; the shared prefix within a group spends width saying nothing.
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

// What this package uses and what uses it; an arrow always points at what is depended on, the one rule every diagram
// obeys.
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

// Size next to siblings in its component; skipped when the component is unknown or has nothing to compare against.
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

// Everything drawn above a package's prose, as markdown, or "" when the index says nothing about this directory yet.
// Rendered as its own `<Markdown>`, so a bad fence can't disturb the README below it.
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
