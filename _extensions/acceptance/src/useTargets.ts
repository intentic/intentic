import { type PanelSummary, PanelsListSchema } from "@intentic/sandbox-contract";
import { useQuery, useQueryClient } from "@tanstack/vue-query";
import { computed, type Ref, ref } from "vue";
import { host } from "./host";
import { targetKeyOf } from "./stories";

// One dev server per repo, one address per (repo, group) pair; a repo can serve several apps, so the group states
// which. A single `/panels` query with per-repo accessors, since a run spans many repos. Loopback is the answer inside
// the sandbox; the preview URL is never a fallback, since a stopped panel answers it with a 502.

// Polls only while a panel is starting; nothing left to watch once every panel has settled.
const POLL_MS = 2000;

// What a repo can offer as a target, in the order the view reasons about it.
export type PanelState =
    // No dev server for this repo; an address must come from the user.
    | "none"
    // Has a dev server, not running; the offer is Start.
    | "stopped"
    // Spawned but nothing answering yet: installing, compiling, or wedged.
    | "starting"
    // Something is answering; the only state that yields an address, one per group when a repo serves several apps.
    | "ready";

// Tmux session name for a repo's dev server: `panel-<repo>` with slashes flattened, matching the daemon's
// PANEL_SESSION_PREFIX over panelKey.
export const panelSessionOf = (repo: string): string => `panel-${repo.replaceAll(`/`, `--`)}`;

// A loopback address always names this repo's own dev server; the daemon serves nothing else on localhost.
const LOOPBACK = /^https?:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?::|\/|$)/i;

// Resolves one address for (repo, group): typed wins (blank means nothing); else the group's own live remembered pick;
// else the repo's own server if it alone serves the repo; otherwise undefined.
export const aimOf = (input: {
    readonly typed: string | undefined;
    readonly remembered: string | undefined;
    readonly state: PanelState;
    readonly servers: readonly { readonly url: string; readonly dir?: string }[];
}): string | undefined => {
    if (input.typed !== undefined) {
        return input.typed.trim() === `` ? undefined : input.typed.trim();
    }
    if (input.state === `none`) {
        // No dev server; the only address this group could have is one that was remembered.
        return input.remembered;
    }
    // The repo's own address: exactly one server, bound at the repo root (no `dir`).
    const only = input.servers.length === 1 ? input.servers[0] : undefined;
    const inheritable = only !== undefined && only.dir === undefined ? only.url : undefined;
    if (input.remembered === undefined) {
        return inheritable;
    }
    return !LOOPBACK.test(input.remembered) || input.servers.some((server) => server.url === input.remembered) ? input.remembered : inheritable;
};

export function useTargets(
    // Last address each target key was actually run against, read from the run manifests, not a stored preference.
    remembered: Ref<Readonly<Record<string, string>>>,
) {
    const api = host();
    const queryClient = useQueryClient();
    const key = api.sandbox.key(`acceptance`, `panels`);

    const query = useQuery({
        queryKey: key,
        enabled: computed(() => api.sandbox.reachable()),
        queryFn: async (): Promise<PanelSummary[]> => PanelsListSchema.parse(await api.sandbox.json(`/panels`)).panels,
        // Reads the query's own data; a vue-query option runs during setup, before an outer const would exist.
        refetchInterval: (state) => ((state.state.data ?? []).some((panel) => panel.running && !panel.healthy) ? POLL_MS : false),
    });

    // Group addresses typed by hand, keyed by `targetKeyOf`; absent means the default, derived live.
    const aimed = ref<Record<string, string>>({});

    const panelOf = (repo: string): PanelSummary | undefined => query.data.value?.find((entry) => entry.repo === repo);

    // What the repo is serving, in the daemon's order; empty is honest for a stopped, installing, or panel-less repo.
    // Each server carries its terminal, absent when it answers from outside this sandbox.
    const serversOf = (repo: string): readonly { url: string; dir?: string; session?: string }[] => panelOf(repo)?.servers ?? [];

    // The repo's one server, when it has exactly one; only then does the repo itself have an address to give.
    const soleServer = (repo: string): { url: string; dir?: string; session?: string } | undefined => {
        const found = serversOf(repo);
        return found.length === 1 ? found[0] : undefined;
    };

    // Answering beats spawned: a repo with anything serving is `ready` even if the daemon didn't start it. One the
    // daemon spawned but nothing answers yet is `starting`, however long the install takes.
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

    // The repo's address, shown on the heading; defined only when the repo serves exactly one thing, not per group.
    const localUrl = (repo: string): string | undefined => soleServer(repo)?.url;

    const addressOf = (repo: string, group: string): string | undefined => {
        const target = targetKeyOf({ repo, group });
        return aimOf({
            typed: aimed.value[target],
            remembered: remembered.value[target],
            state: stateOf(repo),
            // Whole servers, not just addresses: the `dir` on each says repo-level or one app's.
            servers: serversOf(repo),
        });
    };

    return {
        stateOf,
        serversOf,
        localUrl,
        addressOf,
        // Terminal behind the repo's one address, undefined when there's nothing to open; the daemon says which session
        // serves each address, so this never guesses.
        terminalOf: (repo: string): string | undefined => soleServer(repo)?.session,
        // True when a group's address differs from the repo's own; that one is already shown by the heading.
        isElsewhere: (repo: string, group: string): boolean => {
            const address = addressOf(repo, group);
            return address !== undefined && address !== localUrl(repo);
        },
        // True only when a repo serving several apps has this group aimed at none of them; a stopped or starting repo
        // is not this, since Start on the heading is the fix.
        needsAddress: (repo: string, group: string): boolean =>
            addressOf(repo, group) === undefined && ![`stopped`, `starting`].includes(stateOf(repo)),
        // `undefined` restores the repo's dev server; an emptied field (blank string) means nothing, deliberately.
        aimAt: (repo: string, group: string, url: string | undefined): void => {
            const target = targetKeyOf({ repo, group });
            const { [target]: _dropped, ...rest } = aimed.value;
            aimed.value = url === undefined ? rest : { ...rest, [target]: url };
        },
        isLoading: query.isLoading,
        error: computed(() => query.error.value?.message),
        // Lets the page force a refetch outside the poll, e.g. after a panel is started elsewhere.
        refresh: async (): Promise<void> => {
            await queryClient.invalidateQueries({ queryKey: key });
        },
        startPanel: async (repo: string): Promise<void> => {
            // Opens the named panel before the POST so it waits for this session instead of filling an empty strip with
            // its own shell; the second call focuses it once the session exists.
            api.terminal.open(panelSessionOf(repo));
            await api.sandbox.json(`/panels/${encodeURIComponent(repo)}/start`, { method: `POST` });
            api.terminal.open(panelSessionOf(repo));
            await queryClient.invalidateQueries({ queryKey: key });
        },
    };
}
