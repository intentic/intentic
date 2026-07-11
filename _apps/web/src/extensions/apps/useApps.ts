import { AppsListSchema, type RepoApp, TemplatesListSchema, type TemplateSummary } from "@intentic-app/api-contract";
import { useQuery, useQueryClient } from "@tanstack/vue-query";
import { computed, type Ref } from "vue";
import { sandboxJson } from "../../composables/sandboxClient";
import { sandboxKey, useSandbox } from "../../composables/useSandbox";

/* One monorepo's apps, via the daemon's per-repo apps routes (/workspace/repos/{repo}/apps...): the apps
 * present (each with per-app preview URL + live status), the addable kinds from the source repo's
 * templates.json, and add/start/stop. Polls while any app runs, like usePanels. */

const POLL_MS = 4000;

export function useApps(repo: Ref<string>) {
    const { reachable } = useSandbox();
    const queryClient = useQueryClient();
    const appsKey = computed(() => sandboxKey(`apps`, repo.value));

    const query = useQuery({
        queryKey: appsKey,
        queryFn: async () => AppsListSchema.parse(await sandboxJson(`/workspace/repos/${encodeURIComponent(repo.value)}/apps`)),
        enabled: reachable,
        refetchInterval: (state) => (state.state.data?.apps.some((app) => app.running) ? POLL_MS : false),
    });
    const templatesQuery = useQuery({
        queryKey: sandboxKey(`templates`),
        queryFn: async () => TemplatesListSchema.parse(await sandboxJson(`/workspace/templates`)),
        enabled: reachable,
    });

    const invalidate = async (): Promise<void> => {
        await queryClient.invalidateQueries({ queryKey: appsKey.value });
    };
    // Kick off the add-apps tmux job (session panel-<repo>--add_apps) and return immediately — the daemon runs
    // `intentic add-app` in a detached terminal. The attachable terminal is the progress/error surface; the
    // caller (AppsView) attaches it and polls the session's `running` for completion, then calls refresh() so
    // the new apps appear.
    const addApps = async (apps: { template: string; name: string }[]): Promise<void> => {
        await sandboxJson(`/workspace/repos/${encodeURIComponent(repo.value)}/apps`, {
            method: `POST`,
            headers: { "content-type": `application/json` },
            body: JSON.stringify({ apps }),
        });
    };
    const startApp = async (app: string): Promise<void> => {
        await sandboxJson(`/workspace/repos/${encodeURIComponent(repo.value)}/apps/${encodeURIComponent(app)}/start`, { method: `POST` });
        await invalidate();
    };
    const stopApp = async (app: string): Promise<void> => {
        await sandboxJson(`/workspace/repos/${encodeURIComponent(repo.value)}/apps/${encodeURIComponent(app)}/stop`, { method: `POST` });
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
