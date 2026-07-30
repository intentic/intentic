import { type PanelSummary, PanelsListSchema } from "@intentic/sandbox-contract";
import { useQuery, useQueryClient } from "@tanstack/vue-query";
import { computed } from "vue";
import { host } from "./host";

/* WHERE THE TESTS POINT — one address PER REPO, because the area is workspace-wide.
 *
 * A run may carry the web app's stories and the API's in the same fan-out, and those are two different servers on
 * two different ports. So this is a single `/panels` query with per-repo accessors over it rather than a
 * composable instantiated per repo: the dialog needs every selected repo's suggestion at once, and N queries for
 * one list is N times the same request.
 *
 * The agents run INSIDE the sandbox, so the direct loopback address of the repo's dev server is the right
 * default — not its preview URL, which would send every request out through the Cloudflare tunnel and back, and
 * would carry the tunnel's own auth surface into a test of the app's. The preview URL is the fallback for the
 * case loopback cannot cover (a panel the daemon does not run), and free text is the fallback for everything
 * else (a staging deployment, an app started by hand in a terminal on some other port). */

export function useTargets() {
    const api = host();
    const queryClient = useQueryClient();
    const key = api.sandbox.key(`acceptance`, `panels`);

    const query = useQuery({
        queryKey: key,
        enabled: computed(() => api.sandbox.reachable()),
        queryFn: async (): Promise<PanelSummary[]> => PanelsListSchema.parse(await api.sandbox.json(`/panels`)).panels,
    });

    const panelOf = (repo: string): PanelSummary | undefined => query.data.value?.find((entry) => entry.repo === repo);

    // The address to prefill. Empty when there is nothing honest to suggest — the dialog then asks for one rather
    // than starting a run against a URL nobody chose.
    const suggestedFor = (repo: string): string => {
        const panel = panelOf(repo);
        if (panel?.running === true && panel.port !== undefined) {
            return `http://localhost:${panel.port}`;
        }
        return panel?.previewUrl ?? ``;
    };

    return {
        panelOf,
        suggestedFor,
        // Whether the repo ships a dev server the daemon can start — the difference between offering a button
        // and telling the user to bring their own URL.
        hasPanel: (repo: string): boolean => panelOf(repo)?.hasPanel === true,
        running: (repo: string): boolean => panelOf(repo)?.running === true,
        isLoading: query.isLoading,
        startPanel: async (repo: string): Promise<void> => {
            await api.sandbox.json(`/panels/${encodeURIComponent(repo)}/start`, { method: `POST` });
            await queryClient.invalidateQueries({ queryKey: key });
        },
    };
}
