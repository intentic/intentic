import type { AppsList, RepoApp, TemplateSummary } from "@intentic/sandbox-contract";
import { useQuery, useQueryClient } from "@tanstack/vue-query";
import { computed, type Ref } from "vue";
import { host } from "./host";

// One monorepo's apps via the daemon's per-repo procedures: apps present (preview URL + live status), addable kinds from
// templates.json, and add/start/stop. Unpolled: an app IS a managed process, so the daemon announces start/stop and its
// port sampler catches the bind, on the same `panels` domain as the preview list.

export function useApps(repo: Ref<string>) {
    const api = host();
    const queryClient = useQueryClient();
    const appsKey = computed(() => api.sandbox.key(`apps`, repo.value));
    const enabled = computed(() => api.sandbox.reachable());

    const query = useQuery({
        queryKey: appsKey,
        queryFn: () => api.sandbox.rpc.workspace.appsList({ repo: repo.value }),
        enabled,
    });
    const templatesQuery = useQuery({
        queryKey: api.sandbox.key(`templates`),
        queryFn: () => api.sandbox.rpc.workspace.templates(),
        enabled,
    });

    const invalidate = async (): Promise<void> => {
        await queryClient.invalidateQueries({ queryKey: appsKey.value });
    };
    const addApps = async (apps: { template: string; name: string }[]): Promise<void> => {
        await api.sandbox.rpc.workspace.addApps({ repo: repo.value, apps });
    };
    const startApp = async (app: string): Promise<void> => {
        // Optimistic flip to running so the button/status update instantly, without gating on a refetch.
        queryClient.setQueryData<AppsList>(appsKey.value, (prev) =>
            prev === undefined ? prev : { apps: prev.apps.map((entry) => (entry.app === app ? { ...entry, running: true } : entry)) },
        );
        try {
            await api.sandbox.rpc.workspace.startApp({ repo: repo.value, app });
        } catch (err) {
            await invalidate(); // the optimistic flip was wrong: reconcile to the daemon's truth
            throw err;
        }
        void invalidate(); // reconcile previewUrl/healthy in the background; never blocks the caller's terminal open
    };
    const stopApp = async (app: string): Promise<void> => {
        await api.sandbox.rpc.workspace.stopApp({ repo: repo.value, app });
        await invalidate();
    };

    return {
        apps: computed<RepoApp[]>(() => query.data.value?.apps ?? []),
        templates: computed<TemplateSummary[]>(() => templatesQuery.data.value?.templates ?? []),
        error: computed(() => (query.error.value ? query.error.value.message : null)),
        isLoading: query.isLoading,
        addApps,
        refresh: invalidate,
        startApp,
        stopApp,
    };
}
