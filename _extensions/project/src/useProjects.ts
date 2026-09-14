import { useQuery, useQueryClient } from "@tanstack/vue-query";
import { computed, type ComputedRef, type Ref } from "vue";
import { contentEntries, summaryOf } from "./contentFiles.js";
import { host } from "./host.js";

// The projects the workspace holds and what each is. A project is a repository the daemon lists; the workspace's own
// repository ("root") is a project only when it is the only one, since a workspace of repositories has nothing of its
// own to show a maker.

export interface Project {
    // The repository id the daemon's routes take; "root" for the workspace itself.
    readonly id: string;
    readonly name: string;
    // The folder under the workspace root, "" for the workspace itself.
    readonly dir: string;
    // Whether the Preview area can show it running (a dev server the daemon knows how to start).
    readonly hasPanel: boolean;
}

const ROOT: Project = { id: `root`, name: `Your workspace`, dir: ``, hasPanel: false };

// How often the list is re-read on its own; a clone or a new project refreshes it at once.
const REPOS_EVERY_MS = 30_000;

export function useProjects() {
    const api = host();
    const queryClient = useQueryClient();
    const key = computed(() => api.sandbox.key(`project`, `repos`));
    const query = useQuery({
        queryKey: key,
        queryFn: () => api.sandbox.rpc.workspace.repos(),
        enabled: computed(() => api.sandbox.reachable()),
        refetchInterval: REPOS_EVERY_MS,
    });
    const projects: ComputedRef<Project[]> = computed(() => {
        const ids = query.data.value?.repos ?? [];
        const facts = api.workspace.repos();
        const named = ids
            .filter((id) => id !== `root`)
            .map((id) => ({ id, name: id.split(`/`).at(-1) ?? id, dir: id, hasPanel: facts.find((fact) => fact.repo === id)?.hasPanel ?? false }));
        if (named.length > 0) {
            return named;
        }
        return ids.includes(`root`) ? [ROOT] : [];
    });
    const refresh = (): Promise<void> => queryClient.invalidateQueries({ queryKey: key.value });
    return { projects, isLoading: query.isLoading, refresh };
}

// The project's own sentence, read off its README; empty when it has none yet.
export function useSummary(dir: Ref<string | undefined>) {
    const api = host();
    const query = useQuery({
        queryKey: computed(() => api.sandbox.key(`project`, `summary`, dir.value ?? ``)),
        queryFn: async (): Promise<string> => {
            const path = dir.value === `` || dir.value === undefined ? `README.md` : `${dir.value}/README.md`;
            const text = await api.workspace.file(path);
            return text === undefined ? `` : summaryOf(text);
        },
        enabled: computed(() => dir.value !== undefined && api.sandbox.reachable()),
    });
    return computed(() => query.data.value ?? ``);
}

// The files a maker sees at a project's top level, tooling left out; the whole workspace listing for the root project.
export function useContentFiles(dir: Ref<string | undefined>) {
    const api = host();
    const queryClient = useQueryClient();
    const key = computed(() => api.sandbox.key(`project`, `files`, dir.value ?? ``));
    const query = useQuery({
        queryKey: key,
        queryFn: async () => {
            if (dir.value === `` || dir.value === undefined) {
                const { tree } = await api.sandbox.rpc.workspace.tree({});
                return tree;
            }
            const { entries } = await api.sandbox.rpc.workspace.children({ path: dir.value });
            return entries;
        },
        enabled: computed(() => dir.value !== undefined && api.sandbox.reachable()),
    });
    const entries = computed(() => contentEntries(query.data.value ?? []));
    const refresh = (): Promise<void> => queryClient.invalidateQueries({ queryKey: key.value });
    return { entries, isLoading: query.isLoading, refresh };
}
