import { computed, ref, watch } from "vue";
import { type BarrenChain, barrenChainOf, barrenChildren, barrenRoots, branchDirPaths, settleBarren, sweepableDirs } from "./emptyDirs";

// Reactive shell around emptyDirs.ts: decides when a folder counts as barren (time, authorship), not which qualify.
// - Settles only after continuously barren for SETTLE_MS, so an agent mid-scaffold doesn't flicker.
// - A user-created folder is exempt until it stops being barren (gains content, or is deleted).
// Module-level, like the clipboard: state survives the tree unmounting when the sidebar flips.

const SETTLE_MS = 10_000;

const firstSeen = ref<ReadonlyMap<string, number>>(new Map());
const settled = ref<ReadonlySet<string>>(new Set());
const exempt = ref<ReadonlySet<string>>(new Set());
let prevBarren: ReadonlySet<string> = new Set();
let timer: ReturnType<typeof setTimeout> | undefined;

// Marks the New Folder gesture itself, not createDir generally: paste and upload scaffolding must not be exempt.
export const noteUserCreatedDir = (path: string): void => {
    exempt.value = new Set([...exempt.value, path]);
};

// Clears settle clocks and exemptions on a sandbox switch, so the new sandbox's folders aren't already-settled. Called
// from resetWorkspaceTreeState.
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
    // Tree order throughout, as the daemon sent it: the sweep list reads down the screen like the explorer.
    const raw = computed<readonly string[]>(() => sweepableDirs(barren()));

    const evaluate = (): void => {
        const now = Date.now();
        const paths = raw.value;
        const set = new Set(paths);
        // Exemption lifts once a folder leaves the barren set; a path never yet in the set can't be lifted early.
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
