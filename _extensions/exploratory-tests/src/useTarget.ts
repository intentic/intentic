import { type PanelSummary, PanelsListSchema } from "@intentic/sandbox-contract";
import { useQuery, useQueryClient } from "@tanstack/vue-query";
import { computed, type Ref } from "vue";
import { host } from "./host";

/* WHERE THE TESTS POINT.
 *
 * The agents run INSIDE the sandbox, so the direct loopback address of the repo's dev server is the right
 * default — not its preview URL, which would send every request out through the Cloudflare tunnel and back, and
 * would carry the tunnel's own auth surface into a test of the app's. The preview URL is the fallback for the
 * case loopback cannot cover (a panel the daemon does not run), and free text is the fallback for everything
 * else (a staging deployment, an app started by hand in a terminal on some other port). */

export function useTarget(repo: Ref<string>) {
    const api = host();
    const queryClient = useQueryClient();
    const key = api.sandbox.key(`exploratory`, `panels`);

    const query = useQuery({
        queryKey: key,
        enabled: computed(() => api.sandbox.reachable()),
        queryFn: async (): Promise<PanelSummary[]> => PanelsListSchema.parse(await api.sandbox.json(`/panels`)).panels,
    });

    const panel = computed<PanelSummary | undefined>(() => query.data.value?.find((entry) => entry.repo === repo.value));
    const suggested = computed<string>(() => {
        const current = panel.value;
        if (current?.running === true && current.port !== undefined) {
            return `http://localhost:${current.port}`;
        }
        return current?.previewUrl ?? ``;
    });

    const startPanel = async (): Promise<void> => {
        await api.sandbox.json(`/panels/${encodeURIComponent(repo.value)}/start`, { method: `POST` });
        await queryClient.invalidateQueries({ queryKey: key });
    };

    return {
        panel,
        suggested,
        // Whether the repo ships a dev server the daemon can start — the difference between offering a button
        // and telling the user to bring their own URL.
        hasPanel: computed<boolean>(() => panel.value?.hasPanel === true),
        running: computed<boolean>(() => panel.value?.running === true),
        isLoading: query.isLoading,
        startPanel,
    };
}
