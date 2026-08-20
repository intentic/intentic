import { CI_POLL_INTERVAL_MS, type CiRepo, CiRunsResponseSchema } from "@intentic/sandbox-contract";
import { useQuery } from "@tanstack/vue-query";
import { computed, type Ref } from "vue";
import { host } from "./host";

/* HOW a pipeline trigger actually gets its events, the one thing about a `ci` automation that is not visible
 * from the automation itself.
 *
 * A `ci` trigger depends on two things nobody agreed to when they created it: at least one workspace repo
 * whose remote maps to a connected GitHub/GitLab account, and a webhook the daemon could register on it. When
 * either is missing the row still reads as armed. That is the worst state an automation can be in, a
 * scheduled one that never fires at least has an empty run history saying so, but "nothing happened" is also
 * exactly what a healthy pipeline trigger looks like on a week when CI stayed green.
 *
 * So the form says which of the three it is, in the words that matter to the person reading:
 *   ok      , instant, over the provider's webhook
 *   polling , the webhook could not be registered, so runs are polled instead (slower, still works)
 *   none    , no repo maps to a connected account, so this will never fire
 *
 * Read from GET /ci/runs, which already carries per-repo `hookWarning` for the Pipelines view, the reconciler
 * writes that warning once and both surfaces read it, rather than each deciding for itself what a missing hook
 * means. */

const POLL_MINUTES = Math.round(CI_POLL_INTERVAL_MS / 60_000);

export type CiDeliveryState = `ok` | `polling` | `none`;

export interface CiDelivery {
    readonly state: CiDeliveryState;
    readonly summary: string;
    // The reconciler's own words for the first unwired repo, the manual recipe (URL + secret + where to paste
    // it) for an owner who would rather fix the webhook than be polled. Absent unless state is `polling`.
    readonly detail?: string;
}

const describe = (repos: readonly CiRepo[], repoFilter: string): CiDelivery => {
    // A trigger narrowed to one repo is answered about THAT repo: the workspace's other repos being wired says
    // nothing about whether this automation will fire.
    const scoped = repoFilter === `` ? repos : repos.filter((repo) => repo.repo === repoFilter);
    if (scoped.length === 0) {
        return {
            state: `none`,
            summary:
                repoFilter === ``
                    ? `No workspace repo maps to a connected GitHub or GitLab account, so nothing can fire this yet.`
                    : `No repo named "${repoFilter}" maps to a connected GitHub or GitLab account, so nothing can fire this.`,
        };
    }
    const unwired = scoped.filter((repo) => repo.hookWarning !== undefined);
    if (unwired.length === 0) {
        return { state: `ok`, summary: `Fires within seconds — the provider delivers each finished pipeline straight to this sandbox.` };
    }
    const names = unwired.map((repo) => repo.repo).join(`, `);
    const first = unwired[0]?.hookWarning;
    return {
        state: `polling`,
        summary:
            unwired.length === scoped.length
                ? `Webhooks aren't set up, so pipelines are polled instead: this fires within ${POLL_MINUTES} minutes rather than instantly.`
                : `Wired for ${scoped.length - unwired.length} of ${scoped.length} repos. ${names} ${unwired.length === 1 ? `is` : `are`} polled instead — those fire within ${POLL_MINUTES} minutes.`,
        ...(first !== undefined ? { detail: first } : {}),
    };
};

// `repo` is the trigger's channelId (blank ⇒ every mapped repo). Only fetches while a caller is actually
// looking at a CI trigger, the automations page has no other reason to hold the CI picture.
export function useCiDelivery(active: Ref<boolean>, repo: Ref<string>) {
    const api = host();
    const query = useQuery({
        queryKey: api.sandbox.key(`ci-delivery`),
        queryFn: async (): Promise<CiRepo[]> => CiRunsResponseSchema.parse(await api.sandbox.json(`/ci/runs`)).repos,
        enabled: computed(() => active.value && api.sandbox.reachable()),
    });
    return {
        // Undefined until the first answer lands, the form shows nothing rather than guessing `none`, which
        // would read as "this is broken" for the second it takes to find out.
        delivery: computed<CiDelivery | undefined>(() =>
            query.data.value === undefined ? undefined : describe(query.data.value, repo.value.trim()),
        ),
    };
}
