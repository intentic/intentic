import type { WorkspaceLink, WorkspaceTreeEntry } from "@intentic/api-contract";
import { parentDir } from "@intentic/ui/path";
import { opensAsFolder } from "../../files/archiveEntries";
import type { Provisional } from "../../files/provisionalEntries";
import type { BarrenChain } from "../emptyDirs";
import { type ExplorerFilters, explorerShows } from "../explorerFilter";
import { nestSiblings, type NestedEntry } from "../fileNesting";

// The explorer tree as rows: the listing flattened into visible order in one pass, with the filters, nesting, barren
// chains and "N more" markers applied, and what a row says about itself. Pure: every source of state is handed in.

export interface Row {
    readonly entry: WorkspaceTreeEntry;
    readonly depth: number;
    readonly isExpanded: boolean;
    // Folds sibling files under it like a dir (fileNesting.ts); the row still opens the file itself on click.
    readonly nest?: boolean;
    // A barren branch collapses into one row keyed at its root; `chainTail` is absent once the chain outruns the listing.
    readonly barren?: boolean;
    readonly chain?: readonly string[];
    readonly chainTail?: WorkspaceTreeEntry;
}
// "N more" marker only for a dir (or root) with a real server-side cut; excluded from selection and keyboard nav.
export interface MoreRow {
    readonly more: number;
    readonly depth: number;
    readonly key: string;
}

// What draws rows under it: a directory, and an archive, which is a file the daemon lists as if it were one.
export const holdsRows = (entry: WorkspaceTreeEntry): boolean => entry.type === `dir` || opensAsFolder(entry);

// No `children` means never listed (ignored, or beyond budget) and fetches on expand; `children: []` is a genuinely
// empty dir. An archive counts: it has no inline children either, and expanding one asks the daemon what is inside it.
export const isUnlisted = (entry: WorkspaceTreeEntry): boolean => holdsRows(entry) && entry.children === undefined;

// Flattens the tree into a path→entry map, covering lazy subtrees too, so a lazy row is selectable like any other.
export const indexEntries = (
    tree: readonly WorkspaceTreeEntry[],
    childrenOf: (entry: WorkspaceTreeEntry) => readonly WorkspaceTreeEntry[],
): Map<string, WorkspaceTreeEntry> => {
    const map = new Map<string, WorkspaceTreeEntry>();
    const walk = (nodes: readonly WorkspaceTreeEntry[]): void => {
        for (const node of nodes) {
            map.set(node.path, node);
            const kids = childrenOf(node);
            if (kids.length > 0) {
                walk(kids);
            }
        }
    };
    walk(tree);
    return map;
};

export interface RowSource {
    readonly tree: readonly WorkspaceTreeEntry[];
    // The folder `tree` is the contents of, "" for the workspace root.
    readonly rootDir: string;
    // How many of the root's own entries the daemon's entry budget cut (0 = the root listing is complete).
    readonly rootHidden: number;
    // The filter box's text, as typed.
    readonly filter: string;
    readonly expanded: ReadonlySet<string>;
    readonly nesting: boolean;
    readonly filters: ExplorerFilters;
    readonly childrenOf: (entry: WorkspaceTreeEntry) => readonly WorkspaceTreeEntry[];
    // How many of an open folder's own entries the daemon's entry budget cut.
    readonly hiddenIn: (dir: string) => number;
    readonly isBarren: (path: string) => boolean;
    readonly chainOf: (path: string) => BarrenChain;
    readonly entryAt: (path: string) => WorkspaceTreeEntry | undefined;
    // One directory's listing as it is drawn now (withProvisionalEntries): what this browser has just done joins it.
    readonly listing: (dir: string, listed: readonly WorkspaceTreeEntry[]) => readonly WorkspaceTreeEntry[];
}

// One flattening in progress: its source, and the filter as it is matched ("" when not filtering).
interface Walk {
    readonly source: RowSource;
    readonly needle: string;
}

const matches = (walk: Walk, entry: WorkspaceTreeEntry): boolean => entry.name.toLowerCase().includes(walk.needle);

// Filters apply once here, covering the root, lazy subtrees, and name matches that feed the selection/keyboard axis.
// Nesting only applies unfiltered, since a filter flattens every level to match folded names.
const levelOf = (walk: Walk, nodes: readonly WorkspaceTreeEntry[], dir: string): readonly NestedEntry[] => {
    const shown = walk.source.listing(dir, nodes).filter((entry) => explorerShows(entry, walk.source.filters));
    return walk.source.nesting && walk.needle === `` ? nestSiblings(shown) : shown.map((entry) => ({ entry }));
};

// A file's rows: a nest parent and, while it is open, the files folded under it; else the file, if the filter keeps it.
const fileRows = (walk: Walk, { entry, nested }: NestedEntry, depth: number): Row[] => {
    if (nested === undefined) {
        return walk.needle === `` || matches(walk, entry) ? [{ entry, depth, isExpanded: false }] : [];
    }
    const isExpanded = walk.source.expanded.has(entry.path);
    const row: Row = { entry, depth, isExpanded, nest: true };
    return isExpanded ? [row, ...nested.map((child): Row => ({ entry: child, depth: depth + 1, isExpanded: false }))] : [row];
};

// While filtering, a dir earns its row by matching itself or holding a match, and is always shown open.
const filteredDirRows = (walk: Walk, entry: WorkspaceTreeEntry, depth: number): (Row | MoreRow)[] => {
    const childRows = walkRows(walk, walk.source.childrenOf(entry), depth + 1, entry.path);
    if (!matches(walk, entry) && childRows.length === 0) {
        return [];
    }
    return [{ entry, depth, isExpanded: true }, ...childRows];
};

// A barren branch is one row, expanding from the chain's tail. `chainTail` can be missing when the daemon's known branch
// extends past what the listing loaded, leaving nothing below to draw or expand.
const barrenRows = (walk: Walk, entry: WorkspaceTreeEntry, depth: number, isExpanded: boolean): (Row | MoreRow)[] => {
    const { names, tail } = walk.source.chainOf(entry.path);
    const chainTail = walk.source.entryAt(tail);
    const row: Row = { entry, depth, isExpanded, barren: true, ...(chainTail ? { chainTail } : {}), ...(names.length > 1 ? { chain: names } : {}) };
    if (!isExpanded) {
        return [row];
    }
    const from = chainTail ?? entry;
    return [row, ...walkRows(walk, walk.source.childrenOf(from), depth + 1, from.path)];
};

// A folder's rows unfiltered: itself, and once open its contents and a marker for what the daemon's budget cut. A barren
// branch is skipped while filtering, like nesting.
const dirRows = (walk: Walk, entry: WorkspaceTreeEntry, depth: number): (Row | MoreRow)[] => {
    if (walk.needle !== ``) {
        return filteredDirRows(walk, entry, depth);
    }
    const isExpanded = walk.source.expanded.has(entry.path);
    if (walk.source.isBarren(entry.path)) {
        return barrenRows(walk, entry, depth, isExpanded);
    }
    const row: Row = { entry, depth, isExpanded };
    if (!isExpanded) {
        return [row];
    }
    const cut = walk.source.hiddenIn(entry.path);
    const more: MoreRow[] = cut > 0 ? [{ more: cut, depth: depth + 1, key: `${entry.path}#more` }] : [];
    return [row, ...walkRows(walk, walk.source.childrenOf(entry), depth + 1, entry.path), ...more];
};

const walkRows = (walk: Walk, nodes: readonly WorkspaceTreeEntry[], depth: number, dir: string): (Row | MoreRow)[] =>
    levelOf(walk, nodes, dir).flatMap((nested) => (holdsRows(nested.entry) ? dirRows(walk, nested.entry, depth) : fileRows(walk, nested, depth)));

// Flattened, ordered rows built in one pass. A "N more" marker appears only for a dir (or the root) with a nonzero
// server-side cut, and only unfiltered; an unlisted dir gets none, since expanding it loads instead.
export const flattenRows = (source: RowSource): (Row | MoreRow)[] => {
    const walk: Walk = { source, needle: source.filter.trim().toLowerCase() };
    const rows = walkRows(walk, source.tree, 0, source.rootDir);
    return source.rootHidden > 0 && walk.needle === `` ? [...rows, { more: source.rootHidden, depth: 0, key: `#root-more` }] : rows;
};

// A link that goes nowhere or leaves the workspace: dimmed like an ignored row, and never expandable.
export const deadLink = (entry: WorkspaceTreeEntry): boolean => entry.link?.state !== undefined;

// Hover text for a link row: the link's own target text as reported, not the resolved path. Broken and
// outside-workspace states are named explicitly, since a silent no-op click would look like a bug.
export const linkTooltip = (link: WorkspaceLink): string =>
    link.state === `broken`
        ? `Link to ${link.to}: there is nothing there`
        : link.state === `outside`
          ? `Link to ${link.to}: outside the workspace, so the sandbox won't open it`
          : `Link to ${link.to}`;

// A folder takes a drop itself; a file stands in for its parent, as with New File and paste.
export const dropDirOf = (row: Row): string => (row.entry.type === `dir` ? row.entry.path : parentDir(row.entry.path));

// A provisional row's hover text: what is still happening to it, or that the upload behind it failed.
export const provisionalTooltip = (row: Provisional | undefined): string | undefined => {
    if (row === undefined) {
        return undefined;
    }
    if (row.state === `failed`) {
        return `Upload failed; the file isn't in the workspace`;
    }
    const verb = row.kind === `upload` ? `Uploaded` : `Written`;
    return row.state === `landing` ? `${verb} — waiting for the workspace listing` : row.kind === `upload` ? `Uploading…` : `Writing…`;
};
