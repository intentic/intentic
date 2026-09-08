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

// Talks to this extension's own /x backend via the host api, which injects auth and scopes the cache per sandbox. Every
// query key starts with `knowledge`, matching the manifest's `contributes.files` invalidation so a file write
// refetches; polling covers a knowledge base folder moved outside that static path.

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
    // Set via a link affordance ('what else is about this'), never typed directly.
    readonly linkedTo: string | undefined;
}

// One route for both browsing and search; an empty query with no filters returns every note, newest first.
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
        // Keeps the previous answer on screen while the next fetch runs.
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
        // Fetched only once the map is actually viewed; the most expensive query here.
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
    // Invalidates everything under `knowledge`: a write can change backlinks, counts and the map too.
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
    // Owner-pressed from the empty state; answers with what it wrote so the panel can open it.
    const seed = useMutation({
        mutationFn: async () => SeedResultSchema.parse(await api.sandbox.json(`${KNOWLEDGE_BASE}/seed`, { method: `POST` })),
        onSuccess: () => void invalidate(),
    });
    return { save, remove, seed };
}

// Filter options come from the overview; never a hardcoded list that could drift from the folder.
export const filterOptions = (overview: Overview | undefined): { types: readonly string[]; tags: readonly string[] } => ({
    types: (overview?.types ?? []).map((entry) => entry.name),
    tags: (overview?.tags ?? []).map((entry) => entry.name),
});
