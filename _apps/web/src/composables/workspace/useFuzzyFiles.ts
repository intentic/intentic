import type { WorkspaceSearchMode, WorkspaceTreeEntry } from "@intentic-app/api-contract";
import type { Ref } from "vue";
import { computed, ref } from "vue";
import { useLayout } from "../useLayout";
import { rankPaths } from "./fuzzyPaths";
import { useWorkspaceSearch } from "./useWorkspaceSearch";
import { useWorkspaceTree } from "./useWorkspaceTree";

/* Ranked filename matching for the quick-open surfaces (Ctrl/Cmd+P palette, the chat @-mention picker).
 * Client-ranked by default: the explorer's tree query already holds every visible file path (the daemon's
 * file-watch SSE keeps it fresh), and scoring ≤5k paths takes well under a millisecond — results land in the
 * same frame as the keystroke, no debounce, no network, ranked from the first character. The daemon's `files`
 * search stays as the fallback for exactly the two cases the tree can't answer: the include-ignored toggle
 * (ignored files aren't in the eager tree) and a tree truncated by the 5k entry cap (the daemon sweeps to 100k). */

const LIMIT = 100;
// The fallback is already rare and server-bound — a tight debounce just coalesces a keystroke burst.
const SERVER_DEBOUNCE_MS = 50;

export function useFuzzyFiles(query: Ref<string>, active: Ref<boolean>) {
    const { tree, truncated: treeTruncated, error: treeError, isLoading } = useWorkspaceTree();
    const { includeIgnored } = useLayout();

    // Every non-ignored file path in the eager tree (ignored entries are listed grayed but excluded here,
    // matching the daemon's filtered sweep), plus whether ANY dir's child list was cut by the entry cap — the
    // response-level flag only covers the root's own entries, so a deep cut would otherwise read as complete.
    const clientTree = computed<{ paths: readonly string[]; cut: boolean }>(() => {
        const paths: string[] = [];
        let cut = false;
        const walk = (nodes: readonly WorkspaceTreeEntry[]): void => {
            for (const node of nodes) {
                if (node.ignored === true) {
                    continue;
                }
                if (node.truncated === true) {
                    cut = true;
                }
                if (node.type === `file`) {
                    paths.push(node.path);
                } else if (node.children !== undefined) {
                    walk(node.children);
                }
            }
        };
        walk(tree.value);
        return { paths, cut };
    });

    const serverMode = computed(() => includeIgnored.value || treeTruncated.value || clientTree.value.cut);
    const mode = ref<WorkspaceSearchMode>(`files`);
    const serverActive = computed(() => active.value && serverMode.value);
    const server = useWorkspaceSearch(query, serverActive, mode, SERVER_DEBOUNCE_MS);

    const trimmed = computed(() => query.value.trim());
    // The shortest query that can produce matches: the daemon's contract floors at 2 chars, client ranking at 1.
    const floor = computed(() => (serverMode.value ? 2 : 1));

    const paths = computed<readonly string[]>(() => {
        if (!active.value || trimmed.value.length < floor.value) {
            return [];
        }
        return serverMode.value ? server.groups.value.map((group) => group.path) : rankPaths(trimmed.value, clientTree.value.paths, LIMIT);
    });

    return {
        paths,
        floor,
        searching: computed(() => (serverMode.value ? server.searching.value : isLoading.value)),
        pending: computed(() => serverMode.value && server.pending.value),
        truncated: computed(() => serverMode.value && server.truncated.value),
        error: computed(() => (serverMode.value ? server.error.value : treeError.value)),
    };
}
