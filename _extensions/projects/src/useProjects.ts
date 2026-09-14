import { useQueries, useQuery, useQueryClient } from "@tanstack/vue-query";
import { computed, type ComputedRef } from "vue";
import { host } from "./host.js";
import { accentOf, monogramOf, projectIds, type ProjectTile, summaryOf } from "./projects.js";

// The tiles: the daemon's repository list, each with its README's first paragraph and whether it can be looked at
// running. Re-read on a slow clock, and at once after a press makes a new one.

const REPOS_EVERY_MS = 30_000;

export function useProjects() {
    const api = host();
    const queryClient = useQueryClient();
    const reposKey = computed(() => api.sandbox.key(`projects`, `repos`));
    const repos = useQuery({
        queryKey: reposKey,
        queryFn: () => api.sandbox.rpc.workspace.repos(),
        enabled: computed(() => api.sandbox.reachable()),
        refetchInterval: REPOS_EVERY_MS,
    });
    const ids = computed(() => projectIds(repos.data.value?.repos ?? []));

    // One small read per tile, cached by path; a README that does not exist is an empty summary, not an error.
    const summaries = useQueries({
        queries: computed(() =>
            ids.value.map((id) => ({
                queryKey: api.sandbox.key(`projects`, `summary`, id),
                queryFn: async (): Promise<string> => {
                    const text = await api.workspace.file(`${id}/README.md`);
                    return text === undefined ? `` : summaryOf(text);
                },
                enabled: api.sandbox.reachable(),
            })),
        ),
    });

    const tiles: ComputedRef<ProjectTile[]> = computed(() => {
        const facts = api.workspace.repos();
        return ids.value.map((id, index) => ({
            id,
            name: id.split(`/`).at(-1) ?? id,
            monogram: monogramOf(id),
            accent: accentOf(id),
            summary: summaries.value[index]?.data ?? ``,
            hasPanel: facts.find((fact) => fact.repo === id)?.hasPanel ?? false,
        }));
    });

    // Makes the repository and reads the list again, so the new tile is there when the press settles.
    const create = async (name: string): Promise<string> => {
        const made = await api.sandbox.rpc.workspace.createRepo({ name });
        await queryClient.invalidateQueries({ queryKey: reposKey.value });
        return made.name;
    };

    return { tiles, ids, isLoading: repos.isLoading, create };
}
