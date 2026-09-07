import { computed, ref } from "vue";
import { useSearchOptions } from "./useSearchOptions";
import { type SearchScope, useWorkspaceSearch } from "./useWorkspaceSearch";

/* THE EXPLORER'S SEARCH BOX, as state rather than as markup. One input, three scopes, shared by the two
 * explorers (WorkspaceDesktop, WorkspaceMobile) because a phone and a desktop searching the same workspace
 * differently is not a feature — the CHROME differs (a funnel beside a 16px field, a row of touch targets) and
 * that is what stays in each component.
 *
 *   name  → filters the loaded tree instantly, client-side. No request.
 *   text  → what an editor's search box does: the query is one pattern, matched literally (or as a regex with
 *           .*), case-insensitively unless Aa, and every occurrence is marked in the results.
 *   smart → iq's fused retrieval: the query is a question, its words scored separately against the index and
 *           reranked. Finds the file that ANSWERS the words; finds nothing to underline in them.
 *
 * `text` and `smart` search file contents on the daemon (debounced, via useWorkspaceSearch) and swap the tree
 * for a match list; `contentMode` is the flag every surface over this reads to know which of the two it is
 * drawing. The match switches (`options`) belong to Text alone: they change what the pattern means. They are
 * PERSISTED and shared across both explorers, which is why they have to be shown wherever they apply — a phone
 * that applied them without showing them was running a regex search the reader had no way to see, let alone
 * turn off. */
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
        // Back to an empty box AND back to Name: a cleared query that stayed in Smart left the reader looking
        // at the tree with a scope selected that was doing nothing, and the next keystroke fired a search.
        clear: (): void => {
            filter.value = ``;
            scope.value = `name`;
        },
    };
};
