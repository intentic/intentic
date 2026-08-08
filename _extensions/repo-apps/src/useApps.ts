import { type AppsList, AppsListSchema, type RepoApp, TemplatesListSchema, type TemplateSummary } from "@intentic/sandbox-contract";
import { useQuery, useQueryClient } from "@tanstack/vue-query";
import { computed, type Ref } from "vue";
import { host } from "./host";

/* One monorepo's apps, via the daemon's per-repo apps routes (/workspace/repos/{repo}/apps...): the apps
 * present (each with per-app preview URL + live status), the addable kinds from the source repo's
 * templates.json, and add/start/stop.
 *
 * Unpolled, like the preview panels and for the same reason: an app preview IS a managed process, so the daemon
 * announces it starting and reaps it dying, and its port sampler catches the moment the dev server binds. The
 * `apps` key is what the runtime table's `panels` domain names alongside its own, because there is one fact
 * underneath both lists. */

export function useApps(repo: Ref<string>) {
    const api = host();
    const queryClient = useQueryClient();
    const appsKey = computed(() => api.sandbox.key(`apps`, repo.value));
    const enabled = computed(() => api.sandbox.reachable());

    const query = useQuery({
        queryKey: appsKey,
        queryFn: async () => AppsListSchema.parse(await api.sandbox.json(`/workspace/repos/${encodeURIComponent(repo.value)}/apps`)),
        enabled,
    });
    const templatesQuery = useQuery({
        queryKey: api.sandbox.key(`templates`),
        queryFn: async () => TemplatesListSchema.parse(await api.sandbox.json(`/workspace/templates`)),
        enabled,
    });

    const invalidate = async (): Promise<void> => {
        await queryClient.invalidateQueries({ queryKey: appsKey.value });
    };
    const addApps = async (apps: { template: string; name: string }[]): Promise<void> => {
        await api.sandbox.json(`/workspace/repos/${encodeURIComponent(repo.value)}/apps`, {
            method: `POST`,
            headers: { "content-type": `application/json` },
            body: JSON.stringify({ apps }),
        });
    };
    const startApp = async (app: string): Promise<void> => {
        // Optimistically flip the row to running so the Start→Stop button + status update instantly, instead of
        // gating the terminal open on a refetch. The daemon's own frame reconciles it a moment later.
        queryClient.setQueryData<AppsList>(appsKey.value, (prev) =>
            prev === undefined ? prev : { apps: prev.apps.map((entry) => (entry.app === app ? { ...entry, running: true } : entry)) },
        );
        try {
            await api.sandbox.json(`/workspace/repos/${encodeURIComponent(repo.value)}/apps/${encodeURIComponent(app)}/start`, { method: `POST` });
        } catch (err) {
            await invalidate(); // the optimistic flip was wrong — reconcile to the daemon's truth
            throw err;
        }
        void invalidate(); // reconcile previewUrl/healthy in the background; never blocks the caller's terminal open
    };
    const stopApp = async (app: string): Promise<void> => {
        await api.sandbox.json(`/workspace/repos/${encodeURIComponent(repo.value)}/apps/${encodeURIComponent(app)}/stop`, { method: `POST` });
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
