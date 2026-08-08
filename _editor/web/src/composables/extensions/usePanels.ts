import { PanelsListSchema, type PanelSummary } from "@intentic-app/api-contract";
import { useQueryClient } from "@tanstack/vue-query";
import { computed } from "vue";
import { sandboxJson } from "../sandbox/sandboxClient";
import { sandboxKey } from "../sandbox/useSandbox";
import { useSandboxQuery } from "../sandbox/useSandboxQuery";

/* The workspace's repositories: runtime status (running/healthy/previewUrl) + the content facts the extension
 * registry detects on, read via the daemon's /panels routes. Discovery is convention-only — no manifest — so
 * there are just list, start, and stop; a panel's lifecycle lives in the daemon, which is also why this holds no
 * clock. This is the source for the rail's extension activations and every extension view.
 *
 * Both halves of "start → healthy" are pushed, from the two places that actually know. The process manager says
 * so when it launches or reaps a session; the daemon's port sampler says so when the dev server finally binds,
 * which is the moment `starting` becomes `healthy` (panel health is read off the listening sockets). A dev
 * server left running for a week used to keep every open tab asking every four seconds for that flip long after
 * it had happened. */

const QUERY_KEY = sandboxKey(`panels`);

// Named for the background loader (composables/prefetch): the rail's extension tiles are detected from these
// facts, so having them early is what lets a tile open filled in rather than empty.
export const panelsKey = QUERY_KEY;
export const fetchPanels = async () => PanelsListSchema.parse(await sandboxJson(`/panels`));

export function usePanels() {
    const queryClient = useQueryClient();

    const { query, error } = useSandboxQuery({ queryKey: QUERY_KEY, queryFn: fetchPanels });

    const invalidate = async (): Promise<void> => {
        await queryClient.invalidateQueries({ queryKey: QUERY_KEY });
    };
    const start = async (repo: string): Promise<void> => {
        await sandboxJson(`/panels/${encodeURIComponent(repo)}/start`, { method: `POST` });
        await invalidate();
    };
    const stop = async (repo: string): Promise<void> => {
        await sandboxJson(`/panels/${encodeURIComponent(repo)}/stop`, { method: `POST` });
        await invalidate();
    };

    return {
        panels: computed<PanelSummary[]>(() => query.data.value?.panels ?? []),
        // The list has actually arrived (or definitively failed) — what the rail waits on before deciding an
        // extension tile is absent rather than late, since every repo-driven tile is detected from these facts.
        settled: computed(() => query.isFetched.value || query.isError.value),
        error,
        isLoading: query.isLoading,
        start,
        stop,
    };
}
