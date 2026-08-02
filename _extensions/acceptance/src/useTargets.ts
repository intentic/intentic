import { type PanelSummary, PanelsListSchema } from "@intentic/sandbox-contract";
import { useQuery, useQueryClient } from "@tanstack/vue-query";
import { computed, type Ref, ref } from "vue";
import { host } from "./host";
import { targetKeyOf } from "./stories";

/* WHERE THE TESTS POINT — a dev SERVER per repo, an ADDRESS per story group.
 *
 * Those two are different questions and this file is where they stop being confused with each other. The daemon
 * runs one dev server per repository, so starting, watching and reading its state is a repo-level fact. But a
 * repository can serve more than one application — a monorepo's marketing site and its web app are two ports
 * behind one `pnpm dev` — and the group is the only thing in a stories tree that already says which is which. So
 * a run resolves one ADDRESS per (repo, group) pair, and the great majority of those addresses are simply "the
 * repo's dev server".
 *
 * A run may carry the web app's stories and the API's in the same fan-out, so this is a single `/panels` query
 * with per-repo accessors over it rather than a composable instantiated per repo: the view needs every repo's
 * state at once, and N queries for one list is N times the same request.
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

// What a repo can offer as a target, in the order the view reasons about it.
export type PanelState =
    // The daemon runs no dev server for this repo — an address has to come from the user.
    | "none"
    // It has one and it is not running. The offer is a Start button.
    | "stopped"
    // Spawned, port not answering yet: installing, compiling, or wedged. Not a target.
    | "starting"
    // The port answers. This is the only state that yields an address.
    | "ready";

/* THE TMUX SESSION THE DEV SERVER RUNS IN. `panel-<key>`, where the key is the repo id with its slashes
 * flattened — the daemon's PANEL_SESSION_PREFIX (processes/managed-processes.ts) over its panelKey
 * (panels/panels.ts). Session names are wire vocabulary the browser is expected to build; this is the same
 * string repo-apps builds for its own launches. */
export const panelSessionOf = (repo: string): string => `panel-${repo.replaceAll(`/`, `--`)}`;

/* A loopback address IS the repo's own dev server. The daemon serves nothing else on localhost, so `localhost:*`
 * remembered from a past run names the very process whose state we already have — it is not a second app. */
const LOOPBACK = /^https?:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?::|\/|$)/i;

/* WHERE ONE GROUP AIMS, or undefined when there is nothing to point at yet. Undefined is the gate: a run costs
 * one agent session per story, and every one of them would otherwise spend minutes rediscovering that the app is
 * down. Pure, because it is the single rule the whole surface is built on — see useTargets.test.ts.
 *
 * Typed wins, and a typed blank means blank: someone who clears the field is saying "not there", not "surprise me".
 * With nothing typed the group's own history is consulted before the dev server, which is what saves a marketing
 * site's group from being re-aimed every run.
 *
 * BUT ONLY A NON-LOOPBACK MEMORY COUNTS AS ELSEWHERE. A remembered `http://localhost:5173` is this repo's dev
 * server, and it is worth nothing while that server is stopped. Comparing the memory against `localUrl` instead —
 * which is undefined precisely when the server is down — read "differs from nothing" as a deliberate elsewhere and
 * let a fan-out be aimed at a dead port, the exact failure this gate exists to prevent. */
export const aimOf = (input: {
    readonly typed: string | undefined;
    readonly remembered: string | undefined;
    readonly state: PanelState;
    readonly localUrl: string | undefined;
}): string | undefined => {
    if (input.typed !== undefined) {
        return input.typed.trim() === `` ? undefined : input.typed.trim();
    }
    if (input.state === `none`) {
        // There is no dev server, so the only address this group has ever had is one somebody typed.
        return input.remembered;
    }
    return input.remembered !== undefined && !LOOPBACK.test(input.remembered) ? input.remembered : input.localUrl;
};

export function useTargets(
    /* The address each target key was last actually RUN against, newest run first — read straight off the run
     * manifests on disk rather than stored as a preference. A group aimed somewhere other than its repo's dev
     * server should be typed once, not once per run, and a run's own history is what remembers. */
    remembered: Ref<Readonly<Record<string, string>>>,
) {
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

    /* Where a group has been aimed BY HAND, keyed by targetKeyOf, and kept for groups whose stories are no longer
     * ticked: unticking a story and re-ticking it must not lose an address that was typed. Absent means the
     * default — which is derived on every read rather than seeded here, so a repo that gains a running dev server
     * while this view is open stops being stranded on a stale answer with no watcher to keep in sync. */
    const aimed = ref<Record<string, string>>({});

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

    // The dev server's address, or undefined when there is nothing serving to point at.
    const localUrl = (repo: string): string | undefined => {
        const panel = panelOf(repo);
        return stateOf(repo) === `ready` && panel?.port !== undefined ? `http://localhost:${panel.port}` : undefined;
    };

    const addressOf = (repo: string, group: string): string | undefined => {
        const target = targetKeyOf({ repo, group });
        return aimOf({ typed: aimed.value[target], remembered: remembered.value[target], state: stateOf(repo), localUrl: localUrl(repo) });
    };

    return {
        stateOf,
        localUrl,
        addressOf,
        // What a group's chip shows: nothing when it points at the repo's own dev server, because the heading
        // above it already says where that is and at what state.
        isElsewhere: (repo: string, group: string): boolean => {
            const address = addressOf(repo, group);
            return address !== undefined && address !== localUrl(repo);
        },
        // Undefined hands the group back to its repo's dev server; a blank string is the deliberate "not there"
        // an emptied field means, and stays blank.
        aimAt: (repo: string, group: string, url: string | undefined): void => {
            const target = targetKeyOf({ repo, group });
            const { [target]: _dropped, ...rest } = aimed.value;
            aimed.value = url === undefined ? rest : { ...rest, [target]: url };
        },
        isLoading: query.isLoading,
        error: computed(() => query.error.value?.message),
        // A panel may have been started from Preview since this list was read, and the poll only runs while
        // something is mid-start — so the page's own Refresh reaches here too.
        refresh: async (): Promise<void> => {
            await queryClient.invalidateQueries({ queryKey: key });
        },
        // The dev server's own terminal, in the shell's global panel. What a start actually does — install,
        // compile, bind, or fail — is only visible here, so nothing about it is hidden behind a status word.
        showLog: (repo: string): void => api.terminal.open(panelSessionOf(repo)),
        startPanel: async (repo: string): Promise<void> => {
            /* Open the panel BY NAME before the POST, then again after. The session does not exist until the
             * POST lands, and a panel opened with no name on an empty strip fills the gap with its own `web-*`
             * shell — naming it makes the panel wait for this session instead. The second call focuses it once
             * it is really there. Same sequence repo-apps uses, and for the same reason. */
            api.terminal.open(panelSessionOf(repo));
            await api.sandbox.json(`/panels/${encodeURIComponent(repo)}/start`, { method: `POST` });
            api.terminal.open(panelSessionOf(repo));
            await queryClient.invalidateQueries({ queryKey: key });
        },
    };
}
