import { type PanelSummary, PanelsListSchema } from "@intentic/sandbox-contract";
import { useQuery, useQueryClient } from "@tanstack/vue-query";
import { computed } from "vue";
import { host } from "./host";

/* WHERE THE TESTS POINT — one address PER REPO, because the area is workspace-wide.
 *
 * A run may carry the web app's stories and the API's in the same fan-out, and those are two different servers on
 * two different ports. So this is a single `/panels` query with per-repo accessors over it rather than a
 * composable instantiated per repo: the dialog needs every selected repo's state at once, and N queries for one
 * list is N times the same request.
 *
 * THE AGENTS RUN INSIDE THE SANDBOX, so the direct loopback address of the repo's dev server is the answer
 * whenever there is one. Its preview URL is deliberately NOT offered as a fallback: it routes every request out
 * through the Cloudflare tunnel and back, carries the tunnel's own auth surface into a test of the app's, and —
 * the part that made this actively wrong — a panel that is stopped or still booting answers it with a 502.
 * Suggesting it while the server was down is how a run came to be pointed at an unreachable address.
 *
 * RUNNING IS NOT SERVING. `POST /panels/:repo/start` returns as soon as it has spawned the tmux session; the
 * command behind it is `test -d node_modules || pnpm install && pnpm dev`, so a first start can take minutes.
 * `running` says the process exists, `healthy` says the port answers, and only the second one means a test can
 * be pointed at it. Conflating them is what made "Start" look like it had done nothing. */

// While a start is in flight — and only then. Once every panel has settled (healthy, or never started) there is
// no transition left to watch, and this composable lives on a view that stays open.
const POLL_MS = 2000;

// What a repo can offer as a target, in the order the dialog reasons about it.
export type PanelState =
    // The daemon runs no dev server for this repo — an address has to come from the user.
    | "none"
    // It has one and it is not running. The offer is a Start button.
    | "stopped"
    // Spawned, port not answering yet: installing, compiling, or wedged. Not a target.
    | "starting"
    // The port answers. This is the only state that yields an address.
    | "ready";

export function useTargets() {
    const api = host();
    const queryClient = useQueryClient();
    const key = api.sandbox.key(`acceptance`, `panels`);

    const query = useQuery({
        queryKey: key,
        enabled: computed(() => api.sandbox.reachable()),
        queryFn: async (): Promise<PanelSummary[]> => PanelsListSchema.parse(await api.sandbox.json(`/panels`)).panels,
        // Read the query's own data, never an outer const — a closure that reaches outward from a vue-query
        // option runs during setup, before that const exists. See useStories.test.ts.
        refetchInterval: (state) => ((state.state.data ?? []).some((panel) => panel.running && !panel.healthy) ? POLL_MS : false),
    });

    const panelOf = (repo: string): PanelSummary | undefined => query.data.value?.find((entry) => entry.repo === repo);

    const stateOf = (repo: string): PanelState => {
        const panel = panelOf(repo);
        if (panel?.hasPanel !== true) {
            return `none`;
        }
        if (!panel.running) {
            return `stopped`;
        }
        return panel.healthy ? `ready` : `starting`;
    };

    return {
        stateOf,
        // The dev server's address, or undefined when there is nothing serving to point at. Undefined is the
        // whole gate: the dialog refuses to submit a repo it cannot resolve, so a fan-out of sessions is never
        // spent rediscovering that the app is down.
        localUrl: (repo: string): string | undefined => {
            const panel = panelOf(repo);
            return stateOf(repo) === `ready` && panel?.port !== undefined ? `http://localhost:${panel.port}` : undefined;
        },
        isLoading: query.isLoading,
        error: computed(() => query.error.value?.message),
        // Called when the dialog opens: a panel may have been started from Preview since this was last read, and
        // the poll only runs while something is mid-start.
        refresh: async (): Promise<void> => {
            await queryClient.invalidateQueries({ queryKey: key });
        },
        startPanel: async (repo: string): Promise<void> => {
            await api.sandbox.json(`/panels/${encodeURIComponent(repo)}/start`, { method: `POST` });
            await queryClient.invalidateQueries({ queryKey: key });
        },
    };
}
