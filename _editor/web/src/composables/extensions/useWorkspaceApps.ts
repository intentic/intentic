import { AppsListSchema } from "@intentic-app/api-contract";
import { computed, type Ref } from "vue";
import { sandboxJson } from "../sandbox/sandboxClient";
import { WORKSPACE_APPS } from "../queryKeys";
import { useSandboxQuery } from "../sandbox/useSandboxQuery";
import { usePanels } from "./usePanels";

/* The apps living in workspace monorepos, via the daemon's per-repo apps routes (one round-trip per monorepo).
 * Keyed on the monorepo list, so a repo appearing or vanishing while a consumer is open refetches instead of
 * leaving a frozen snapshot. `active` gates the fan-out, consumers are dialogs that open rarely, and the
 * round-trips shouldn't run for those who never do. */
export function useWorkspaceApps(active: Ref<boolean>) {
    const { panels } = usePanels();
    const repos = computed(() => panels.value.filter((panel) => panel.monorepo).map((panel) => panel.repo));

    const { query, error } = useSandboxQuery({
        queryKey: computed(() => WORKSPACE_APPS.of(...repos.value)),
        queryFn: async () => {
            const lists = await Promise.all(
                repos.value.map(async (repo) => {
                    const { apps } = AppsListSchema.parse(await sandboxJson(`/workspace/repos/${encodeURIComponent(repo)}/apps`));
                    return apps.map(({ app }) => ({ repo, app }));
                }),
            );
            return lists.flat();
        },
        enabled: active,
    });

    return {
        apps: computed(() => query.data.value ?? []),
        error,
    };
}
