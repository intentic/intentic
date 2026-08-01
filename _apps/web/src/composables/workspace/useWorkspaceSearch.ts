import type { WorkspaceSearchMode, WorkspaceSearchResult } from "@intentic-app/api-contract";
import { keepPreviousData, useInfiniteQuery } from "@tanstack/vue-query";
import type { Ref } from "vue";
import { computed, ref, watch } from "vue";
import { sandboxJson } from "../sandbox/sandboxClient";
import { useSearchOptions } from "./useSearchOptions";
import { sandboxKey, useSandbox } from "../sandbox/useSandbox";

/* Search over /work, read directly from the sandbox daemon (GET /workspace/search).
 *
 * Two scopes, two verbs, and the difference is the whole point of having both:
 *
 *   `text`  → iq's `find`: ripgrep over the workspace. The query is ONE pattern — a phrase matches as a phrase,
 *             not as its words — case-insensitive unless Aa, marked in the results by the char spans the daemon
 *             reports. This is what every editor's search box does, and it is the default.
 *   `smart` → iq's `q`: BM25 + embeddings + a cross-encoder rerank. The query is a QUESTION; its words are
 *             scored separately and a file can place without containing any of them, which is why it is a
 *             deliberate choice rather than what typing a phrase gets you.
 *   `files` → iq's `files`: fuzzy over PATHS, no file contents. The quick-open fallback for the trees the
 *             client can't rank itself (useFuzzyFiles).
 *
 * Results come relevance-ranked and grouped by file, one page at a time: the daemon answers with as many whole
 * files as its row ceiling allows plus a cursor, and `loadMore` appends the next page rather than re-rendering
 * the list. The input is debounced just enough to coalesce a keystroke burst; TanStack's abort signal is
 * threaded through so a superseded search cancels daemon-side instead of piling up; keepPreviousData keeps the
 * last results on screen while a refinement is in flight (no flash to the spinner). */
export type SearchScope = "text" | "smart" | "files";

const VERB: Record<SearchScope, NonNullable<WorkspaceSearchMode>> = { text: `find`, smart: `q`, files: `files` };

export function useWorkspaceSearch(filter: Ref<string>, scope: Ref<SearchScope>, active: Ref<boolean>, debounceMs = 150) {
    const { reachable } = useSandbox();
    const { includeIgnored, useRegex, matchCase, wholeWord } = useSearchOptions();

    const debounced = ref(filter.value.trim());
    let timer: ReturnType<typeof setTimeout> | undefined;
    watch(filter, (value) => {
        clearTimeout(timer);
        timer = setTimeout(() => {
            debounced.value = value.trim();
        }, debounceMs);
    });

    // The daemon rejects queries under 2 chars (min length in the contract), so short input just disables the query.
    const enabled = computed(() => reachable.value && active.value && debounced.value.length >= 2);
    // Only `text` reads the match switches — `smart` has no pattern to apply them to.
    const params = computed(() => {
        const search = new URLSearchParams({ query: debounced.value, mode: VERB[scope.value] });
        if (includeIgnored.value) {
            search.set(`includeIgnored`, `true`);
        }
        if (scope.value === `text`) {
            // The engine's `find` takes a rust regex; with .* off the query is fixed text (rg -F) instead, so a
            // query full of dots and parens searches for itself. The other two are off unless switched on.
            if (!useRegex.value) {
                search.set(`literal`, `true`);
            }
            if (matchCase.value) {
                search.set(`caseSensitive`, `true`);
            }
            if (wholeWord.value) {
                search.set(`word`, `true`);
            }
        }
        return search.toString();
    });
    const query = useInfiniteQuery({
        // Every switch is in the key: flipping one is a different search, and its previous answer stays cached.
        queryKey: computed(() => sandboxKey(`workspace`, `search`, params.value)),
        queryFn: ({ pageParam, signal }) =>
            sandboxJson<WorkspaceSearchResult>(`/workspace/search?${params.value}${pageParam === undefined ? `` : `&after=${pageParam}`}`, {
                signal,
            }),
        initialPageParam: undefined as string | undefined,
        getNextPageParam: (last: WorkspaceSearchResult) => last.cursor,
        enabled,
        placeholderData: keepPreviousData,
    });

    const pages = computed<readonly WorkspaceSearchResult[]>(() => (enabled.value ? (query.data.value?.pages ?? []) : []));
    // Every page carries the same counts — they describe the whole match set, not the slice that came back.
    const head = computed(() => pages.value[0]);

    return {
        // Ranked best-first by the daemon. A text search then goes back to path order — every hit is an equally
        // exact match of the same pattern, so ranking them says nothing, while path order groups a directory's
        // files together the way an editor's search tree does.
        groups: computed(() => {
            const groups = pages.value.flatMap((page) => page.groups);
            return scope.value === `text` ? groups.toSorted((a, b) => (a.path < b.path ? -1 : 1)) : groups;
        }),
        total: computed(() => head.value?.total ?? 0),
        files: computed(() => head.value?.files ?? 0),
        // `total` is a floor: some file had more matches than the engine keeps per file.
        partial: computed(() => head.value?.partial ?? false),
        // More pages exist behind the cursor — the panel offers them rather than implying this is everything.
        truncated: computed(() => query.hasNextPage.value),
        loadMore: () => void query.fetchNextPage(),
        loadingMore: computed(() => query.isFetchingNextPage.value),
        // The header spinner is about the SEARCH; a page append has its own control to report on.
        searching: computed(() => enabled.value && query.isFetching.value && !query.isFetchingNextPage.value),
        error: computed(() => (enabled.value && query.error.value ? query.error.value.message : undefined)),
        // What the engine did with the pattern that the pattern didn't ask for (an unparseable regex rerun as
        // literal text, grep-style escapes rewritten) — the panel shows it the way the CLI prints it.
        note: computed(() => head.value?.note),
        // True while the typed filter hasn't produced a searchable query yet (too short, or debounce pending).
        pending: computed(() => filter.value.trim().length >= 2 && debounced.value !== filter.value.trim()),
    };
}
