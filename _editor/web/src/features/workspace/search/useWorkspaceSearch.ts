import type { WorkspaceSearchMode, WorkspaceSearchResult } from "@intentic/api-contract";
import { keepPreviousData, useInfiniteQuery } from "@tanstack/vue-query";
import type { Ref } from "vue";
import { computed, onScopeDispose, ref, watch } from "vue";
import { sandboxJson } from "../../sandbox/client/sandboxClient";
import { useSearchOptions } from "./useSearchOptions";
import { workspaceAgent } from "../health/workspaceScope";
import { useSandbox } from "../../sandbox/client/useSandbox";
import { WORKSPACE_SEARCH } from "../../../lib/queryKeys";

// Search over /work via the sandbox daemon (GET /workspace/search). Two scopes, two verbs:
// text → iq's `find` (ripgrep): one literal/regex pattern, phrase-matched, case-insensitive unless Aa.
// smart → iq's `q` (BM25 + embeddings + rerank): the query is a question, scored by word, can match without
// containing any of them.
// files → iq's `files`: fuzzy over paths only, the quick-open fallback (useFuzzyFiles).
// An `include` field carries VSCode's files-to-include glob straight to the daemon for either scope. Results are
// grouped by file, paginated (`loadMore`), debounced, abort-cancelled, and keep previous data on screen mid-refinement.
export type SearchScope = "text" | "smart" | "files";

const VERB: Record<SearchScope, NonNullable<WorkspaceSearchMode>> = { text: `find`, smart: `q`, files: `files` };

export function useWorkspaceSearch(filter: Ref<string>, scope: Ref<SearchScope>, active: Ref<boolean>, debounceMs = 150) {
    const { reachable } = useSandbox();
    const { includeIgnored, useRegex, matchCase, wholeWord, include } = useSearchOptions();

    // Both fields are typed a character at a time, so both wait out the same burst before a search goes out.
    const debounce = (source: Ref<string>): Ref<string> => {
        const settled = ref(source.value.trim());
        let timer: ReturnType<typeof setTimeout> | undefined;
        watch(source, (value) => {
            clearTimeout(timer);
            timer = setTimeout(() => {
                settled.value = value.trim();
            }, debounceMs);
        });
        // Timer dies with the surface, or closing mid-type could still fire a stale search after the fact.
        onScopeDispose(() => clearTimeout(timer));
        return settled;
    };
    const debounced = debounce(filter);
    const debouncedInclude = debounce(include);

    // The daemon rejects queries under 2 chars (contract's min length); short input just disables the query.
    const enabled = computed(() => reachable.value && active.value && debounced.value.length >= 2);
    // Only `text` reads the match switches, `smart` has no pattern to apply them to.
    const params = computed(() => {
        const search = new URLSearchParams({ query: debounced.value, mode: VERB[scope.value] });
        if (includeIgnored.value) {
            search.set(`includeIgnored`, `true`);
        }
        // Files to ask, in VSCode's glob grammar; scopes both text and smart search equally.
        if (debouncedInclude.value !== ``) {
            search.set(`include`, debouncedInclude.value);
        }
        if (scope.value === `text`) {
            // `find` takes a rust regex; with `.*` off the query is literal text (rg -F), dots and parens included.
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
        queryKey: computed(() => WORKSPACE_SEARCH.of(params.value)),
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
    // Every page carries the same counts, they describe the whole match set, not the slice that came back.
    const head = computed(() => pages.value[0]);

    return {
        // Daemon ranks best-first; `text` results are then sorted by path instead, since every hit matches the pattern
        // equally and path order groups a directory's files like an editor's tree.
        groups: computed(() => {
            const groups = pages.value.flatMap((page) => page.groups);
            return scope.value === `text` ? groups.toSorted((a, b) => (a.path < b.path ? -1 : 1)) : groups;
        }),
        total: computed(() => head.value?.total ?? 0),
        files: computed(() => head.value?.files ?? 0),
        // `total` is a floor: some file had more matches than the engine keeps per file.
        partial: computed(() => head.value?.partial ?? false),
        // More pages exist behind the cursor, the panel offers them rather than implying this is everything.
        truncated: computed(() => query.hasNextPage.value),
        loadMore: () => void query.fetchNextPage(),
        loadingMore: computed(() => query.isFetchingNextPage.value),
        // Header spinner is about the search itself; a page append has its own loading control.
        searching: computed(() => enabled.value && query.isFetching.value && !query.isFetchingNextPage.value),
        error: computed(() => (enabled.value && query.error.value ? query.error.value.message : undefined)),
        // What the engine did unasked (e.g. a regex rerun literally). Search always reads the shared /work tree, not an
        // agent's own copy; the note says so when they differ.
        note: computed(() =>
            workspaceAgent.value === undefined
                ? head.value?.note
                : [head.value?.note, `Searching the shared workspace, an agent's own copy isn't indexed.`].filter(Boolean).join(` `),
        ),
        // True while input hasn't produced a searchable query yet, in either field: too short or still debouncing.
        pending: computed(
            () => filter.value.trim().length >= 2 && (debounced.value !== filter.value.trim() || debouncedInclude.value !== include.value.trim()),
        ),
    };
}
