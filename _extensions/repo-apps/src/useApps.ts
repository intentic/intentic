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
    const appsKey = computed(() => api.sandbox.readKey(`workspace.appsList`, { repo: repo.value }));
    const enabled = computed(() => api.sandbox.reachable());

    const query = useQuery({
        queryKey: appsKey,
        queryFn: () => api.sandbox.rpc.workspace.appsList({ repo: repo.value }),
        enabled,
    });
    const templatesQuery = useQuery({
        queryKey: api.sandbox.readKey(`workspace.templates`),
        queryFn: () => api.sandbox.rpc.workspace.templates(),
        enabled,
    });

    const invalidate = async (): Promise<void> => {
        await queryClient.invalidateQueries({ queryKey: appsKey.value });
    };
    const addApps = async (apps: { template: string; name: string }[]): Promise<void> => {
        await api.sandbox.rpc.workspace.addApps({ repo: repo.value, apps });
    };
    // One app's running flag, set on the list as it is now. Only that field, both ways: the list is also rewritten by the
    // daemon's own announcements, and putting back a whole snapshot would undo those too.
    const markRunning = (key: readonly unknown[], app: string, running: boolean): void => {
        queryClient.setQueryData<AppsList>(key, (prev) =>
            prev === undefined ? prev : { ...prev, apps: prev.apps.map((entry) => (entry.app === app ? { ...entry, running } : entry)) },
        );
    };
    const startApp = async (app: string): Promise<void> => {
        // The key the press was made under: the repo may change before the answer comes back.
        const key = appsKey.value;
        const was = queryClient.getQueryData<AppsList>(key)?.apps.find((entry) => entry.app === app)?.running;
        // Optimistic flip to running so the button/status update instantly, without gating on a refetch.
        markRunning(key, app, true);
        try {
            // A list read already in flight would paint the row back from before the press.
            await queryClient.cancelQueries({ queryKey: key });
            await api.sandbox.rpc.workspace.startApp({ repo: repo.value, app });
        } catch (err) {
            // The flip was wrong: take it back at once rather than leave the row claiming to run until a read lands,
            // then reconcile to the daemon's truth.
            if (was !== undefined) {
                markRunning(key, app, was);
            }
            void queryClient.invalidateQueries({ queryKey: key });
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
