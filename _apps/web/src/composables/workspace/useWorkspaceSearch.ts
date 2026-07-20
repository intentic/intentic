import type { WorkspaceSearchResult, WorkspaceSearchMode } from "@intentic-app/api-contract";
import { keepPreviousData, useQuery } from "@tanstack/vue-query";
import type { Ref } from "vue";
import { computed, ref, watch } from "vue";
import { sandboxJson } from "../sandbox/sandboxClient";
import { useLayout } from "../useLayout";
import { sandboxKey, useSandbox } from "../sandbox/useSandbox";

// Search over /work, read directly from the sandbox daemon (GET /workspace/search — results come
// relevance-ranked and grouped). `mode` picks the search verb: the default fused content search when
// omitted, or `files` for filename quick-open. The input is debounced just enough to coalesce a keystroke
// burst (the daemon's resident engine answers from a warm index, so queries are cheap); TanStack's abort
// signal is threaded through so a superseded search cancels daemon-side instead of piling up;
// keepPreviousData keeps the last results on screen while a refinement is in flight (no flash to the spinner).
export function useWorkspaceSearch(filter: Ref<string>, active: Ref<boolean>, mode?: Ref<WorkspaceSearchMode | undefined>, debounceMs = 150) {
    const { reachable } = useSandbox();
    const { includeIgnored } = useLayout();

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
    const query = useQuery({
        // includeIgnored is in the key so flipping the toggle refetches with the wider/narrower result set.
        queryKey: computed(() => sandboxKey(`workspace`, `search`, mode?.value ?? `q`, debounced.value, includeIgnored.value ? `all` : `filtered`)),
        queryFn: ({ signal }) =>
            sandboxJson<WorkspaceSearchResult>(
                `/workspace/search?query=${encodeURIComponent(debounced.value)}${mode?.value ? `&mode=${mode.value}` : ``}${includeIgnored.value ? `&includeIgnored=true` : ``}`,
                { signal },
            ),
        enabled,
        placeholderData: keepPreviousData,
    });

    return {
        groups: computed(() => (enabled.value ? (query.data.value?.groups ?? []) : [])),
        truncated: computed(() => enabled.value && (query.data.value?.truncated ?? false)),
        searching: computed(() => enabled.value && query.isFetching.value),
        error: computed(() => (enabled.value && query.error.value ? query.error.value.message : undefined)),
        // True while the typed filter hasn't produced a searchable query yet (too short, or debounce pending).
        pending: computed(() => filter.value.trim().length >= 2 && debounced.value !== filter.value.trim()),
    };
}
