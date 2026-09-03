import { STATE_DIR } from "@intentic/constants";
import { PUBLIC_DIR, REFERENCE_DIR } from "@intentic/workspace-ignore/constants";

/* BARREN BRANCHES, folders holding nothing but empty folders, the debris file moves leave behind (git carries
 * no directories, so nothing ever cleans them up). The unit everywhere is the BRANCH, not the folder:
 * `public/demo/assets` where each link holds only the next is ONE piece of junk, and any count, marker, or
 * delete that works leaf-by-leaf understates the mess and triples the chore.
 *
 * WHICH folders are barren is the daemon's answer, on the tree response, and it has to be: the explorer's tree
 * stops at a listing budget, so every directory below the cut arrives with no `children` at all, which means
 * "never looked at" and can never mean "empty". Computing barrenness from that tree, which is what this file
 * used to do, quietly scoped the whole feature to the workspace root, an empty folder inside any repository was
 * invisible to the one feature that exists to find it. So the daemon walks for it separately (its
 * workspace/empty-dirs.ts) and sends the complete list, and everything here is arithmetic over PATHS.
 *
 * What stays here is policy, in the vein of explorerFilter/fileNesting: which of those folders to OFFER, and
 * when. The component binds, this file computes, tests need no mounting. The settle step takes `now` as an
 * argument for the same reason, no clocks in here, no fake timers in the tests. */

/* FIXTURES, folders whose existence is nobody's chore, empty or not. Two are the user's own furniture (the
 * reference shelf and the public outbox, whose emptiness is a state they chose); the rest belong to the daemon:
 * its state dir, and the two folders it projects every loaded skill into.
 *
 * Machine-owned folders are excluded because sweeping one is a LOOP, not a chore. The daemon recreates each of
 * these the next time it converges, so the offer would come back, and the one workspace where the debris the
 * sweep exists for cannot possibly have accumulated yet is a BRAND NEW ONE, which is exactly where these folders
 * are all there is. A first-run explorer opening on "2 empty folders. Clean up", for folders the owner never
 * made and cannot keep swept, reads as a mess the product shipped with.
 *
 * Root-relative, like every other path rule around here: a repo's own `public/` or `.claude/` is content. */
const FIXTURES = [REFERENCE_DIR, PUBLIC_DIR, STATE_DIR, `.agents/skills`, `.claude/skills`];

/* A fixture, anything inside one, and anything ABOVE one. The last is the case that only appears now that the
 * daemon answers structurally: `.claude` holding nothing but its empty `skills` projection is barren as a fact
 * about the filesystem, and sweeping it would delete the folder the daemon remakes on its next converge, taking
 * the projection with it. An ancestor of a fixture is therefore no more sweepable than the fixture itself. */
const isFixturePath = (path: string): boolean =>
    FIXTURES.some((dir) => path === dir || path.startsWith(`${dir}/`) || dir.startsWith(`${path}/`));

// The folders the explorer may offer, in the order the daemon sent them (tree order, a parent immediately above
// its branch). Everything downstream reads this list, never the raw one.
export const sweepableDirs = (barren: readonly string[]): readonly string[] => barren.filter((path) => !isFixturePath(path));

const parentOf = (path: string): string | undefined => {
    const cut = path.lastIndexOf(`/`);
    return cut === -1 ? undefined : path.slice(0, cut);
};

/* The tops of the barren branches, in tree order, the units the sweep counts and deletes. A barren dir whose
 * parent is also barren is interior to its branch, not a root; the list is disjoint by construction and safe to
 * delete in one pass. */
export const barrenRoots = (barren: readonly string[], settled: ReadonlySet<string>): readonly string[] =>
    barren.filter((path) => {
        const parent = parentOf(path);
        return settled.has(path) && (parent === undefined || !settled.has(parent));
    });

// Who sits directly inside each barren dir, built once per set rather than per row: the chain below walks it,
// and a chain is asked for on every barren row the explorer draws.
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

/* The collapsed row's shape: the maximal single-child descent from a barren dir. `names` labels the row
 * ("public / demo / assets"), `tail` is the path where the chain stops widening, whose children (if any) are
 * what an expanded chain row shows. A dir with zero or several children is its own one-link chain.
 *
 * Read off the barren set alone: everything inside a barren dir is a barren dir, so the set holds the whole
 * branch and the descent needs no tree. Given the SETTLED set, the chain stops where settling has, which is
 * what keeps a row from collapsing a folder the explorer is not yet willing to call empty. */
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

// Every dir path inside a branch, root included, what the sweep records so its Undo can put the branch back
// EXACTLY (recursive create is idempotent, so recreating each path rebuilds the shape whatever the order).
// Asked of the full barren list rather than the settled set: the delete takes the root and everything under it,
// settled or not, so the way back has to name all of it.
export const branchDirPaths = (root: string, barren: readonly string[]): readonly string[] =>
    barren.filter((path) => path === root || path.startsWith(`${root}/`));

/* THE SETTLE STEP, barrenness held long enough to be a fact rather than a construction site. Agents create a
 * folder and write into it a beat later, and the tree refetches on every write; a marker that tracked the raw
 * set would strobe while an agent scaffolds. So a path is `settled` only once it has been continuously barren
 * for `settleMs`, measured against the `firstSeen` stamps this same function maintains: a path new to the set
 * is stamped `now`, a departed path forgets its stamp entirely (re-emptying starts the clock over), and
 * `exempt` paths, folders the user just created by hand, never settle at all until they leave the set by
 * gaining content. Callers pass `now` in; nothing here reads a clock. */
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
