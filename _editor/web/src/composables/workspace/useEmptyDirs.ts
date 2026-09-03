import { computed, ref, watch } from "vue";
import { type BarrenChain, barrenChainOf, barrenChildren, barrenRoots, branchDirPaths, settleBarren, sweepableDirs } from "../../pages/workspace/emptyDirs";

/* THE EXPLORER'S VIEW OF BARREN BRANCHES, the reactive shell around emptyDirs.ts' arithmetic. The daemon says
 * which folders hold nothing but empty folders (a walk of its own, complete regardless of what the tree
 * listing's budget reached); the pure module says which of those to offer; this one owns WHEN the explorer is
 * allowed to say it, which is a question about time and about who made the folder:
 *
 *   - Agents create a folder and write into it a beat later, and the daemon's file watcher refetches the tree
 *     on every write, a marker tracking the raw set would strobe while an agent scaffolds. So the explorer
 *     only ever renders the SETTLED set: barren continuously for SETTLE_MS. The timer below re-evaluates when
 *     the youngest unsettled path comes of age; between tree changes nothing ticks.
 *
 *   - A folder the user just created by hand is empty BY DEFINITION, and flagging it three seconds after they
 *     made it is hostile. Creation marks it exempt; the exemption lifts when the folder stops being barren
 *     (it gained content, or was deleted), after which an agent emptying it again flags like anything else.
 *
 * Module-level state, like the clipboard and the expanded set (useWorkspaceTree): the tree component unmounts
 * whenever the sidebar flips, and settle clocks or exemptions that died with it would restart the wait, or
 * re-flag the folder the user made a minute ago. */

const SETTLE_MS = 10_000;

const firstSeen = ref<ReadonlyMap<string, number>>(new Map());
const settled = ref<ReadonlySet<string>>(new Set());
const exempt = ref<ReadonlySet<string>>(new Set());
let prevBarren: ReadonlySet<string> = new Set();
let timer: ReturnType<typeof setTimeout> | undefined;

// The user's own New Folder gesture, called at the create site (useWorkspaceTree.createDir serves paste and
// upload scaffolding too, so the gesture is marked where it is a GESTURE, not where directories get made).
export const noteUserCreatedDir = (path: string): void => {
    exempt.value = new Set([...exempt.value, path]);
};

// A sandbox switch is a different tree entirely: settle clocks and exemptions keyed by path would otherwise
// carry over and mark the NEW sandbox's folders as already-settled. Called from resetWorkspaceTreeState.
export const resetEmptyDirsState = (): void => {
    firstSeen.value = new Map();
    settled.value = new Set();
    exempt.value = new Set();
    prevBarren = new Set();
    if (timer !== undefined) {
        clearTimeout(timer);
        timer = undefined;
    }
};

export function useEmptyDirs(barren: () => readonly string[]) {
    // Tree order throughout, as the daemon sent it: the sweep's list then reads down the screen the way the
    // explorer does.
    const raw = computed<readonly string[]>(() => sweepableDirs(barren()));

    const evaluate = (): void => {
        const now = Date.now();
        const paths = raw.value;
        const set = new Set(paths);
        // An exemption lifts the moment its folder stops being barren, gained content or got deleted. Only a
        // path that WAS in the set can leave it, so a just-created folder isn't unexempted before the tree
        // refetch even lists it.
        const lifted = [...exempt.value].filter((path) => prevBarren.has(path) && !set.has(path));
        if (lifted.length > 0) {
            const next = new Set(exempt.value);
            for (const path of lifted) {
                next.delete(path);
            }
            exempt.value = next;
        }
        prevBarren = set;
        const result = settleBarren(paths, firstSeen.value, exempt.value, now, SETTLE_MS);
        firstSeen.value = result.firstSeen;
        settled.value = result.settled;
        // One timeout, aimed at the youngest unsettled non-exempt path; nothing pending → nothing ticking.
        if (timer !== undefined) {
            clearTimeout(timer);
            timer = undefined;
        }
        const pending = paths
            .filter((path) => !result.settled.has(path) && !exempt.value.has(path))
            .map((path) => SETTLE_MS - (now - (result.firstSeen.get(path) ?? now)));
        if (pending.length > 0) {
            timer = setTimeout(evaluate, Math.max(0, Math.min(...pending)) + 10);
        }
    };
    watch(raw, evaluate, { immediate: true });

    // What the rows consult: barren AND settled, the only form of "empty" the explorer ever shows.
    const isBarren = (path: string): boolean => settled.value.has(path);
    // The sweep's units: the top of each settled branch, in tree order.
    const roots = computed<readonly string[]>(() => barrenRoots(raw.value, settled.value));
    const settledChildren = computed(() => barrenChildren(settled.value));
    const chainOf = (path: string): BarrenChain => barrenChainOf(path, settledChildren.value);
    // Every dir of a branch, recorded before a sweep so Undo can rebuild the exact shape.
    const branchDirs = (root: string): readonly string[] => branchDirPaths(root, raw.value);

    return { isBarren, roots, chainOf, branchDirs };
}
