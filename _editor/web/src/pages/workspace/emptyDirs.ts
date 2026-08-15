import type { WorkspaceTreeEntry } from "@intentic-app/api-contract";
import { STATE_DIR } from "@intentic/constants";
import { isLockedWorkspacePath } from "@intentic/sandbox-contract";
import { PUBLIC_DIR, REFERENCE_DIR } from "@intentic/workspace-ignore/constants";

/* BARREN BRANCHES — folders holding nothing but empty folders, the debris file moves leave behind (git carries
 * no directories, so nothing ever cleans them up). The unit everywhere is the BRANCH, not the folder:
 * `public/demo/assets` where each link holds only the next is ONE piece of junk, and any count, marker, or
 * delete that works leaf-by-leaf understates the mess and triples the chore.
 *
 * Pure arithmetic over one tree snapshot, in the vein of explorerFilter/fileNesting: the component binds, this
 * file computes, tests need no mounting. The settle step takes `now` as an argument for the same reason —
 * no clocks in here, no fake timers in the tests.
 *
 * The honesty rule is structural: `children: []` is a dir the walk actually listed and found empty, while
 * `undefined` means it never looked (ignored, locked, or deferred past the entry budget) — and UNKNOWN MUST
 * NEVER RENDER AS EMPTY. Ignored territory is off-limits outright (nobody wants an offer to tidy build
 * output), as are the daemon's locked dirs and the FIXTURES below. */

/* FIXTURES — folders whose existence is nobody's chore, empty or not. Two are the user's own furniture (the
 * reference shelf and the public outbox, whose emptiness is a state they chose); the rest belong to the daemon:
 * its state dir, and the two folders it projects every loaded skill into.
 *
 * Machine-owned folders are excluded because sweeping one is a LOOP, not a chore. The daemon recreates each of
 * these the next time it converges, so the offer would come back — and the one workspace where the debris the
 * sweep exists for cannot possibly have accumulated yet is a BRAND NEW ONE, which is exactly where these folders
 * are all there is. A first-run explorer opening on "2 empty folders — Clean up", for folders the owner never
 * made and cannot keep swept, reads as a mess the product shipped with.
 *
 * Root-relative, like every other path rule around here: a repo's own `public/` or `.claude/` is content. */
const FIXTURES = [REFERENCE_DIR, PUBLIC_DIR, STATE_DIR, `.agents/skills`, `.claude/skills`];
const isFixturePath = (path: string): boolean => FIXTURES.some((dir) => path === dir || path.startsWith(`${dir}/`));

// Children as the explorer knows them: the eager walk's inline listing, else the lazily-fetched one. `undefined`
// is "never looked", which is exactly the distinction barrenness must preserve — so no `?? []` here.
const knownChildren = (
    entry: WorkspaceTreeEntry,
    lazy: ReadonlyMap<string, readonly WorkspaceTreeEntry[]>,
): readonly WorkspaceTreeEntry[] | undefined => entry.children ?? lazy.get(entry.path);

/* Every barren dir path in the snapshot — a dir whose entire KNOWN subtree holds no files, with unknowns
 * poisoning the branch rather than passing silently. One bottom-up pass; the set answers both the row dimming
 * (any barren dir dims) and the root/chain arithmetic below. */
export const barrenDirs = (tree: readonly WorkspaceTreeEntry[], lazy: ReadonlyMap<string, readonly WorkspaceTreeEntry[]>): ReadonlySet<string> => {
    const barren = new Set<string>();
    const visit = (entry: WorkspaceTreeEntry): boolean => {
        // A LINK is never debris, whatever is on the other end of it. Sweeping one deletes the link (never the
        // target — that is what `rm` on a symlink does), so the offer would be to tidy away something somebody
        // deliberately made, on the strength of a fact about a different directory entirely.
        if (
            entry.type !== `dir` ||
            entry.link !== undefined ||
            entry.ignored === true ||
            isLockedWorkspacePath(entry.path) ||
            isFixturePath(entry.path)
        ) {
            // Still descend a non-barren dir: barren branches deeper down are their own units.
            if (entry.type === `dir`) {
                for (const child of knownChildren(entry, lazy) ?? []) {
                    visit(child);
                }
            }
            return false;
        }
        const children = knownChildren(entry, lazy);
        if (children === undefined) {
            return false;
        }
        // Every child must come back barren — and every child must be VISITED regardless, so a barren pocket
        // under a non-barren sibling still lands in the set. (`&&=` would short-circuit the walk.)
        let all = true;
        for (const child of children) {
            if (!visit(child)) {
                all = false;
            }
        }
        if (all) {
            barren.add(entry.path);
        }
        return all;
    };
    for (const entry of tree) {
        visit(entry);
    }
    return barren;
};

/* The tops of the barren branches, in tree order — the units the sweep counts and deletes. A barren dir whose
 * parent is also barren is interior to its branch, not a root; the walk stops at each root, so the list is
 * disjoint by construction and safe to delete in one pass. */
export const barrenRoots = (
    tree: readonly WorkspaceTreeEntry[],
    lazy: ReadonlyMap<string, readonly WorkspaceTreeEntry[]>,
    barren: ReadonlySet<string>,
): readonly WorkspaceTreeEntry[] => {
    const roots: WorkspaceTreeEntry[] = [];
    const visit = (entries: readonly WorkspaceTreeEntry[]): void => {
        for (const entry of entries) {
            if (entry.type !== `dir`) {
                continue;
            }
            if (barren.has(entry.path)) {
                roots.push(entry);
                continue;
            }
            visit(knownChildren(entry, lazy) ?? []);
        }
    };
    visit(tree);
    return roots;
};

/* The collapsed row's shape: the maximal single-child descent from a barren dir. `names` labels the row
 * ("public / demo / assets"), `tail` is where the chain stops widening — its children (if any) are what an
 * expanded chain row shows. A dir with zero or several children is its own one-link chain. */
export interface BarrenChain {
    readonly names: readonly string[];
    readonly tail: WorkspaceTreeEntry;
}

export const barrenChainOf = (
    entry: WorkspaceTreeEntry,
    lazy: ReadonlyMap<string, readonly WorkspaceTreeEntry[]>,
    barren: ReadonlySet<string>,
): BarrenChain => {
    const names: string[] = [entry.name];
    let tail = entry;
    for (;;) {
        const children = knownChildren(tail, lazy);
        if (children === undefined || children.length !== 1) {
            return { names, tail };
        }
        const only = children[0];
        if (only === undefined || !barren.has(only.path)) {
            return { names, tail };
        }
        names.push(only.name);
        tail = only;
    }
};

// Every dir path inside a branch, root included — what the sweep records so its Undo can put the branch back
// EXACTLY (recursive create is idempotent, so recreating each path rebuilds the shape whatever the order).
export const branchDirPaths = (root: WorkspaceTreeEntry, lazy: ReadonlyMap<string, readonly WorkspaceTreeEntry[]>): readonly string[] => {
    const paths: string[] = [];
    const visit = (entry: WorkspaceTreeEntry): void => {
        if (entry.type !== `dir`) {
            return;
        }
        paths.push(entry.path);
        for (const child of knownChildren(entry, lazy) ?? []) {
            visit(child);
        }
    };
    visit(root);
    return paths;
};

/* THE SETTLE STEP — barrenness held long enough to be a fact rather than a construction site. Agents create a
 * folder and write into it a beat later, and the tree refetches on every write; a marker that tracked the raw
 * set would strobe while an agent scaffolds. So a path is `settled` only once it has been continuously barren
 * for `settleMs`, measured against the `firstSeen` stamps this same function maintains: a path new to the set
 * is stamped `now`, a departed path forgets its stamp entirely (re-emptying starts the clock over), and
 * `exempt` paths — folders the user just created by hand — never settle at all until they leave the set by
 * gaining content. Callers pass `now` in; nothing here reads a clock. */
export const settleBarren = (
    barren: ReadonlySet<string>,
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
