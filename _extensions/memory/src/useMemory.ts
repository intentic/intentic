import { type MemoryFile, type MemoryFileEntry, MemoryFileSchema, MemoryListSchema } from "@intentic/sandbox-contract";
import { useMutation, useQuery, useQueryClient } from "@tanstack/vue-query";
import { computed, type Ref } from "vue";
import { host } from "./host";

/* The agent's persistent memory notes, via the daemon's /memory routes: every project's memory dir
 * (MEMORY.md + one markdown file per fact), readable, editable, and deletable — the owner's window into (and
 * red pen over) what the agent carries across sessions. Plain polling; memory changes at agent-turn cadence.
 * All daemon access goes through the host api (auth + per-sandbox cache scoping injected host-side). */

const POLL_MS = 30_000;

const fileQuery = (project: string, name: string): string => `project=${encodeURIComponent(project)}&name=${encodeURIComponent(name)}`;

export function useMemory() {
    const api = host();
    const files = useQuery({
        queryKey: api.sandbox.key(`memory`),
        queryFn: async () => MemoryListSchema.parse(await api.sandbox.json(`/memory`)).files,
        enabled: computed(() => api.sandbox.reachable()),
        refetchInterval: POLL_MS,
    });
    return {
        files: computed<MemoryFileEntry[]>(() => files.data.value ?? []),
        error: computed(() => files.error.value?.message),
        isLoading: computed(() => files.isLoading.value),
    };
}

export function useMemoryFile(selected: Ref<{ project: string; name: string } | undefined>) {
    const api = host();
    const note = useQuery({
        queryKey: computed(() => api.sandbox.key(`memory-file`, selected.value?.project ?? ``, selected.value?.name ?? ``)),
        queryFn: async () => MemoryFileSchema.parse(await api.sandbox.json(`/memory/file?${fileQuery(selected.value!.project, selected.value!.name)}`)),
        enabled: computed(() => api.sandbox.reachable() && selected.value !== undefined),
    });
    return {
        note: computed<MemoryFile | undefined>(() => note.data.value),
        error: computed(() => note.error.value?.message),
        isLoading: computed(() => note.isLoading.value),
    };
}

export function useMemoryMutations() {
    const api = host();
    const queryClient = useQueryClient();
    // A write changes both the list (size/mtime) and the note body; a delete only the list — but invalidating
    // the file-read cache too is free and keeps a re-created note from showing its deleted predecessor.
    const invalidate = (): Promise<void> => queryClient.invalidateQueries({ queryKey: api.sandbox.key(`memory`) });
    const invalidateFile = (project: string, name: string): Promise<void> =>
        queryClient.invalidateQueries({ queryKey: api.sandbox.key(`memory-file`, project, name) });

    const save = useMutation({
        mutationFn: ({ project, name, content }: { project: string; name: string; content: string }) =>
            api.sandbox.json(`/memory/file`, {
                method: `PUT`,
                headers: { "content-type": `application/json` },
                body: JSON.stringify({ project, name, content }),
            }),
        onSuccess: (_data, { project, name }) => {
            void invalidate();
            void invalidateFile(project, name);
        },
    });
    const remove = useMutation({
        mutationFn: ({ project, name }: { project: string; name: string }) =>
            api.sandbox.json(`/memory/file`, {
                method: `DELETE`,
                headers: { "content-type": `application/json` },
                body: JSON.stringify({ project, name }),
            }),
        onSuccess: (_data, { project, name }) => {
            void invalidate();
            void invalidateFile(project, name);
        },
    });
    return { save, remove };
}
