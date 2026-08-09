import { useMutation, useQuery, useQueryClient } from "@tanstack/vue-query";
import { computed, type Ref } from "vue";
import {
    type Graph,
    GraphSchema,
    KNOWLEDGE_BASE,
    type Note,
    NoteSchema,
    type Overview,
    OverviewSchema,
    type SearchHit,
    SearchResultSchema,
    SeedResultSchema,
} from "./contract";
import { host } from "./host";

/* The vault, through this extension's OWN backend at its /x namespace — no `permissions.sandbox` entry, because
 * an extension's own backend is its own code. All daemon access goes through the host api, which injects auth
 * and scopes the cache per sandbox.
 *
 * EVERY QUERY KEY STARTS WITH `knowledge`, and that is load-bearing rather than tidy: the manifest's
 * `contributes.files` declares `knowledge/` → invalidates `knowledge`, so when the agent writes a note with its
 * own file tools the daemon's watcher pushes the change and these queries refetch. The poll below is the
 * fallback for a vault the owner has pointed somewhere else, where no static path could have been declared. */

const POLL_MS = 30_000;

const query = (params: Record<string, string | number | undefined>): string =>
    Object.entries(params)
        .flatMap(([key, value]) => (value === undefined || value === `` ? [] : [`${key}=${encodeURIComponent(String(value))}`]))
        .join(`&`);

export function useOverview() {
    const api = host();
    const overview = useQuery({
        queryKey: api.sandbox.key(`knowledge`, `overview`),
        queryFn: async () => OverviewSchema.parse(await api.sandbox.json(`${KNOWLEDGE_BASE}/overview`)),
        enabled: computed(() => api.sandbox.reachable()),
        refetchInterval: POLL_MS,
    });
    return {
        overview: computed<Overview | undefined>(() => overview.data.value),
        error: computed(() => overview.error.value?.message),
        isLoading: computed(() => overview.isLoading.value),
    };
}

export interface Filters {
    readonly q: string;
    readonly type: string | undefined;
    readonly tag: string | undefined;
    // Set by following a "what else is about this" affordance rather than by typing.
    readonly linkedTo: string | undefined;
}

/* THE LIST IS THE SEARCH — one route, whether or not anything has been typed. An empty query with no filters is
 * "every note, newest first", which is exactly what a browse surface wants, so there is no second code path for
 * browsing and no chance of the two disagreeing about what the vault contains. */
export function useSearch(filters: Ref<Filters>) {
    const api = host();
    const hits = useQuery({
        queryKey: computed(() =>
            api.sandbox.key(`knowledge`, `search`, filters.value.q, filters.value.type ?? ``, filters.value.tag ?? ``, filters.value.linkedTo ?? ``),
        ),
        queryFn: async () =>
            SearchResultSchema.parse(
                await api.sandbox.json(
                    `${KNOWLEDGE_BASE}/search?${query({
                        q: filters.value.q,
                        type: filters.value.type,
                        tag: filters.value.tag,
                        linkedTo: filters.value.linkedTo,
                        limit: 200,
                    })}`,
                ),
            ).hits,
        enabled: computed(() => api.sandbox.reachable()),
        refetchInterval: POLL_MS,
        // The previous answer stays on screen while the next one is fetched: a list that blanks on every
        // keystroke is a list nobody can aim at.
        placeholderData: (previous) => previous,
    });
    return {
        hits: computed<SearchHit[]>(() => hits.data.value ?? []),
        error: computed(() => hits.error.value?.message),
        isLoading: computed(() => hits.isLoading.value),
        isFetching: computed(() => hits.isFetching.value),
    };
}

export function useNote(path: Ref<string | undefined>) {
    const api = host();
    const note = useQuery({
        queryKey: computed(() => api.sandbox.key(`knowledge`, `note`, path.value ?? ``)),
        queryFn: async () => NoteSchema.parse(await api.sandbox.json(`${KNOWLEDGE_BASE}/note?${query({ path: path.value })}`)),
        enabled: computed(() => api.sandbox.reachable() && path.value !== undefined),
    });
    return {
        note: computed<Note | undefined>(() => note.data.value),
        error: computed(() => note.error.value?.message),
        isLoading: computed(() => note.isLoading.value),
    };
}

export function useGraph(path: Ref<string | undefined>, depth: Ref<number>, enabled: Ref<boolean>) {
    const api = host();
    const graph = useQuery({
        queryKey: computed(() => api.sandbox.key(`knowledge`, `graph`, path.value ?? ``, String(depth.value))),
        queryFn: async () => GraphSchema.parse(await api.sandbox.json(`${KNOWLEDGE_BASE}/graph?${query({ focus: path.value, depth: depth.value })}`)),
        // Only fetched once the map is actually being looked at — it is the most expensive answer here and the
        // least often wanted.
        enabled: computed(() => api.sandbox.reachable() && path.value !== undefined && enabled.value),
    });
    return {
        graph: computed<Graph | undefined>(() => graph.data.value),
        error: computed(() => graph.error.value?.message),
        isLoading: computed(() => graph.isLoading.value),
    };
}

export function useNoteMutations() {
    const api = host();
    const queryClient = useQueryClient();
    // A write changes the note, its neighbours' backlinks, the counts and the map — everything under the one
    // prefix. Invalidating the lot is right here: this is a hand edit, not a stream, and being certain the
    // panel agrees with the folder is worth one extra round trip.
    const invalidate = (): Promise<void> => queryClient.invalidateQueries({ queryKey: api.sandbox.key(`knowledge`) });
    const save = useMutation({
        mutationFn: ({ path, content }: { path: string; content: string }) =>
            api.sandbox.json(`${KNOWLEDGE_BASE}/note`, {
                method: `PUT`,
                headers: { "content-type": `application/json` },
                body: JSON.stringify({ path, content }),
            }),
        onSuccess: () => void invalidate(),
    });
    const remove = useMutation({
        mutationFn: ({ path }: { path: string }) =>
            api.sandbox.json(`${KNOWLEDGE_BASE}/note`, {
                method: `DELETE`,
                headers: { "content-type": `application/json` },
                body: JSON.stringify({ path }),
            }),
        onSuccess: () => void invalidate(),
    });
    // Starting the vault off — owner-pressed, from the empty state, never on a read. It answers with what it
    // wrote so the panel can open the note rather than announce a success nobody can see.
    const seed = useMutation({
        mutationFn: async () => SeedResultSchema.parse(await api.sandbox.json(`${KNOWLEDGE_BASE}/seed`, { method: `POST` })),
        onSuccess: () => void invalidate(),
    });
    return { save, remove, seed };
}

// Everything the filter controls offer, read off the overview so the vault's own words are the vocabulary —
// never a hardcoded list that could disagree with what is in the folder.
export const filterOptions = (overview: Overview | undefined): { types: readonly string[]; tags: readonly string[] } => ({
    types: (overview?.types ?? []).map((entry) => entry.name),
    tags: (overview?.tags ?? []).map((entry) => entry.name),
});
