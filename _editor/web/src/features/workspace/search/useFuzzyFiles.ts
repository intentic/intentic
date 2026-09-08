import type { WorkspaceTreeEntry } from "@intentic/api-contract";
import { isLockedWorkspacePath } from "@intentic/sandbox-contract";
import type { Ref } from "vue";
import { computed, ref } from "vue";
import { rankPaths } from "./fuzzyPaths";
import { type SearchScope, useWorkspaceSearch } from "./useWorkspaceSearch";
import { useSearchOptions } from "./useSearchOptions";
import { useWorkspaceTree } from "../explorer/useWorkspaceTree";

// Ranked filename matching for quick-open surfaces (Ctrl/Cmd+P palette, chat @-mention picker). Client-ranked by
// default: the tree already holds every visible path and scores fast enough for no debounce. Falls back to the
// daemon's `files` search only for include-ignored or a tree truncated past its 5k cap (daemon sweeps to 100k).

const LIMIT = 100;
// The fallback is already rare and server-bound, a tight debounce just coalesces a keystroke burst.
const SERVER_DEBOUNCE_MS = 50;

export function useFuzzyFiles(query: Ref<string>, active: Ref<boolean>) {
    const { tree, rootHidden, error: treeError, isLoading } = useWorkspaceTree();
    const { includeIgnored } = useSearchOptions();

    // Collects non-ignored paths from the eager tree, plus whether any dir is unloaded (`children` undefined), forcing
    // the daemon fallback. Locked entries are skipped whole, not counted as a gap, or every keystroke would fall back.
    const clientTree = computed<{ paths: readonly string[]; cut: boolean }>(() => {
        const paths: string[] = [];
        let cut = false;
        const walk = (nodes: readonly WorkspaceTreeEntry[]): void => {
            for (const node of nodes) {
                if (node.ignored === true || isLockedWorkspacePath(node.path)) {
                    continue;
                }
                if (node.type === `file`) {
                    paths.push(node.path);
                } else if (node.children === undefined) {
                    cut = true;
                } else {
                    walk(node.children);
                }
            }
        };
        walk(tree.value);
        return { paths, cut };
    });

    const serverMode = computed(() => includeIgnored.value || rootHidden.value > 0 || clientTree.value.cut);
    const scope = ref<SearchScope>(`files`);
    const serverActive = computed(() => active.value && serverMode.value);
    const server = useWorkspaceSearch(query, scope, serverActive, SERVER_DEBOUNCE_MS);

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
