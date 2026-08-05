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
 * `running` says the process exists, `servers` says what is answering, and only the second one means a test can
 * be pointed at it. Conflating them is what made "Start" look like it had done nothing.
 *
 * AND SERVING IS NOT ONE THING. The daemon reports every dev server it can attribute to the repo, so a repo whose
 * `pnpm dev` fans a turbo run out across packages arrives here as three addresses, not one. One server is the
 * repo's address and every group under it aims there unasked; several is not an ambiguity to resolve by picking
 * the lowest port, because the cost of guessing wrong is a fan-out of agent sessions walking marketing stories
 * through a sign-in screen. So several means each group says which, once — and the run manifests remember it. */

// While a start is in flight — and only then. Once every panel has settled (healthy, or never started) there is
// no transition left to watch, and this composable lives on a view that stays open.
const POLL_MS = 2000;

// What a repo can offer as a target, in the order the view reasons about it.
export type PanelState =
    // The daemon runs no dev server for this repo — an address has to come from the user.
    | "none"
    // It has one and it is not running. The offer is a Start button.
    | "stopped"
    // Spawned, nothing answering yet: installing, compiling, or wedged. Not a target.
    | "starting"
    // Something is answering. The only state that yields an address — though a repo serving several apps yields
    // one per GROUP rather than one for the repo.
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
 * A REPO SERVING ONE THING ANSWERS FOR EVERY GROUP UNDER IT; a repo serving three answers for none of them, and
 * each group carries its own pick. That is why the whole server LIST comes in rather than a single address.
 *
 * AND A REMEMBERED LOOPBACK ADDRESS IS ONLY WORTH KEEPING WHILE IT IS STILL BEING SERVED. `http://localhost:5173`
 * remembered from a past run names a port, not a place: if it is one of the addresses this repo is serving right
 * now it is the marketing site's own port, picked once and rightly not asked about again — and if it is not, it
 * is a dead socket, and pointing a fan-out at it is the exact failure this gate exists to prevent. (The rule used
 * to compare the memory against the repo's single address, which is undefined precisely when the server is down,
 * so "differs from nothing" read as a deliberate elsewhere and the fan-out went to the dead port anyway.) */
export const aimOf = (input: {
    readonly typed: string | undefined;
    readonly remembered: string | undefined;
    readonly state: PanelState;
    readonly servers: readonly string[];
}): string | undefined => {
    if (input.typed !== undefined) {
        return input.typed.trim() === `` ? undefined : input.typed.trim();
    }
    if (input.state === `none`) {
        // There is no dev server, so the only address this group has ever had is one somebody typed.
        return input.remembered;
    }
    // The repo's own address, when it has exactly one thing to offer.
    const only = input.servers.length === 1 ? input.servers[0] : undefined;
    if (input.remembered === undefined) {
        return only;
    }
    return !LOOPBACK.test(input.remembered) || input.servers.includes(input.remembered) ? input.remembered : only;
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

    // What the repo is actually serving, in the daemon's order (by port). Empty is the honest answer for a repo
    // that is stopped, still installing, or has no panel at all.
    const serversOf = (repo: string): readonly { url: string; dir?: string }[] => panelOf(repo)?.servers ?? [];

    /* Answering beats spawned, in both directions. A repo with something serving is `ready` even when the daemon
     * did not start it — a dev server run by hand in a terminal is exactly as walkable, and offering Start for it
     * would collide on the very ports it pinned. A repo the daemon spawned that is serving nothing yet is
     * `starting`, however long its install takes. */
    const stateOf = (repo: string): PanelState => {
        const panel = panelOf(repo);
        if (panel?.hasPanel !== true) {
            return `none`;
        }
        if (serversOf(repo).length > 0) {
            return `ready`;
        }
        return panel.running ? `starting` : `stopped`;
    };

    // THE REPO's address — the one every group under it inherits without being asked. Defined only when the repo
    // serves exactly one thing; with several there is no repo-level answer to give, and each group states its own.
    const localUrl = (repo: string): string | undefined => {
        const found = serversOf(repo);
        return found.length === 1 ? found[0]?.url : undefined;
    };

    const addressOf = (repo: string, group: string): string | undefined => {
        const target = targetKeyOf({ repo, group });
        return aimOf({
            typed: aimed.value[target],
            remembered: remembered.value[target],
            state: stateOf(repo),
            servers: serversOf(repo).map((server) => server.url),
        });
    };

    return {
        stateOf,
        serversOf,
        localUrl,
        addressOf,
        // What a group's chip shows: nothing when it points at the repo's own dev server, because the heading
        // above it already says where that is and at what state.
        isElsewhere: (repo: string, group: string): boolean => {
            const address = addressOf(repo, group);
            return address !== undefined && address !== localUrl(repo);
        },
        /* THIS GROUP HAS NOWHERE TO GO, AND THIS ROW IS WHERE IT IS FIXED. The chip is quiet by default — the
         * heading above already says where the repo's dev server is — so an un-aimed group has to say so out
         * loud, or the run refuses with its only remedy hidden behind a hover.
         *
         * A repo whose server is merely STOPPED OR STILL STARTING is deliberately not this. That blocks the run
         * too, but the fix is Start, Start lives on the heading, and raising the alarm here would put it where
         * the remedy isn't. What is left is the case that stranded a real run: a repo serving SEVERAL apps with
         * this group pointed at none of them — plainly up, green on its heading, and unrunnable until this row
         * says which app it walks. */
        needsAddress: (repo: string, group: string): boolean =>
            addressOf(repo, group) === undefined && ![`stopped`, `starting`].includes(stateOf(repo)),
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
