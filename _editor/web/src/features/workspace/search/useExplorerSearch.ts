import { computed, ref } from "vue";
import { useSearchOptions } from "./useSearchOptions";
import { type SearchScope, useWorkspaceSearch } from "./useWorkspaceSearch";

// Explorer search box as state, shared by desktop and mobile (only the chrome differs). Three scopes:
// name → filters the loaded tree client-side, instantly.
// text → literal or regex pattern, case-insensitive unless Aa; marks every occurrence.
// smart → iq's fused retrieval, scoring query words against the index to surface the file that answers them.
// Text/smart search the daemon and swap the tree for a match list; `options` (text's switches) persist across
// both explorers and must be shown wherever they apply.
export const useExplorerSearch = () => {
    const filter = ref(``);
    const scope = ref<"name" | SearchScope>(`name`);
    const contentMode = computed(() => scope.value !== `name`);
    const contentScope = computed<SearchScope>(() => (scope.value === `smart` ? `smart` : `text`));

    return {
        filter,
        scope,
        contentMode,
        // Whether the pattern-flavoured switches apply to what is on screen right now.
        textMode: computed(() => scope.value === `text`),
        options: useSearchOptions(),
        results: useWorkspaceSearch(filter, contentScope, contentMode),
        // Clears both the query and the scope: a cleared query left in Smart would search again on the next keystroke.
        clear: (): void => {
            filter.value = ``;
            scope.value = `name`;
        },
    };
};
