import { AppsListSchema } from "@intentic/api-contract";
import { computed, type Ref } from "vue";
import { sandboxJson } from "../sandbox/client/sandboxClient";
import { WORKSPACE_APPS } from "../../lib/queryKeys";
import { useSandboxQuery } from "../sandbox/client/useSandboxQuery";
import { usePanels } from "./usePanels";

/* The apps living in workspace monorepos, via the daemon's per-repo apps routes (one round-trip per monorepo). */
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
