import { STATE_DIR } from "@intentic/constants";
import { PUBLIC_DIR, REFERENCE_DIR } from "@intentic/workspace-ignore/constants";

// Barren branches: folders holding nothing but empty folders, counted and swept as one branch, not
// leaf by leaf. The daemon computes barrenness separately (the tree stops at its listing budget) and
// sends the full list; this file only decides which to offer. Arithmetic over paths; `now` is passed in, no clocks
// here.

// Excluded from sweeping: user's empty folders, and daemon-owned ones it recreates on converge (root-relative).
const FIXTURES = [REFERENCE_DIR, PUBLIC_DIR, STATE_DIR, `.agents/skills`, `.claude/skills`];

// Matches a fixture, anything inside one, or an ancestor of one: an empty folder holding only a
// fixture (like `.claude` over `skills`) is just as unsweepable.
const isFixturePath = (path: string): boolean =>
    FIXTURES.some((dir) => path === dir || path.startsWith(`${dir}/`) || dir.startsWith(`${path}/`));

// Folders the explorer may offer, in daemon (tree) order. Everything downstream reads this list, not the raw one.
export const sweepableDirs = (barren: readonly string[]): readonly string[] => barren.filter((path) => !isFixturePath(path));

const parentOf = (path: string): string | undefined => {
    const cut = path.lastIndexOf(`/`);
    return cut === -1 ? undefined : path.slice(0, cut);
};

// Tops of each barren branch, in tree order: the units the sweep counts and deletes. A barren dir
// whose parent is also barren is interior, not a root.
export const barrenRoots = (barren: readonly string[], settled: ReadonlySet<string>): readonly string[] =>
    barren.filter((path) => {
        const parent = parentOf(path);
        return settled.has(path) && (parent === undefined || !settled.has(parent));
    });

// Direct children of each barren dir, built once per set rather than per row that asks for a chain.
export const barrenChildren = (barren: Iterable<string>): ReadonlyMap<string, readonly string[]> => {
    const children = new Map<string, string[]>();
    for (const path of barren) {
        const parent = parentOf(path);
        if (parent !== undefined) {
            children.set(parent, [...(children.get(parent) ?? []), path]);
        }
    }
    return children;
};

// `names` labels the collapsed branch, `tail` is where the single-child descent stops (its children,
// if any, show when expanded). Chain stops early if the settled set doesn't cover further descendants.
export interface BarrenChain {
    readonly names: readonly string[];
    readonly tail: string;
}

const nameOf = (path: string): string => path.split(`/`).pop() ?? path;

export const barrenChainOf = (path: string, children: ReadonlyMap<string, readonly string[]>): BarrenChain => {
    const names: string[] = [nameOf(path)];
    let tail = path;
    for (;;) {
        const below = children.get(tail) ?? [];
        const only = below.length === 1 ? below[0] : undefined;
        if (only === undefined) {
            return { names, tail };
        }
        names.push(nameOf(only));
        tail = only;
    }
};

// Every dir path inside a branch (root included), recorded so Undo recreates the exact shape. Asked
// against the full barren list, not just settled, since delete takes everything under the root either way.
export const branchDirPaths = (root: string, barren: readonly string[]): readonly string[] =>
    barren.filter((path) => path === root || path.startsWith(`${root}/`));

// Settled once continuously barren for `settleMs` (new path stamps now, departure drops the stamp,
// exempt paths never settle). Caller passes `now`: no clock reads here.
export const settleBarren = (
    barren: readonly string[],
    firstSeen: ReadonlyMap<string, number>,
    exempt: ReadonlySet<string>,
    now: number,
    settleMs: number,
): { readonly firstSeen: ReadonlyMap<string, number>; readonly settled: ReadonlySet<string> } => {
    const nextSeen = new Map<string, number>();
    const settled = new Set<string>();
    for (const path of barren) {
        const since = firstSeen.get(path) ?? now;
        nextSeen.set(path, since);
        if (!exempt.has(path) && now - since >= settleMs) {
            settled.add(path);
        }
    }
    return { firstSeen: nextSeen, settled };
};
