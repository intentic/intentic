import { CI_POLL_INTERVAL_MS, type CiRepo } from "@intentic/sandbox-contract";
import { useQuery } from "@tanstack/vue-query";
import { computed, type Ref } from "vue";
import { host } from "./host";
import { t } from "./i18n.js";

// How a `ci` trigger actually gets events: it needs a workspace repo mapped to a connected account and a webhook the
// daemon could register; either missing still reads as armed. State comes from GET /ci/runs's hookWarning:
// ok: webhook delivers within seconds
// polling: webhook failed to register, runs are polled instead
// none: no repo maps to a connected account, this will never fire

const POLL_MINUTES = Math.round(CI_POLL_INTERVAL_MS / 60_000);

export type CiDeliveryState = `ok` | `polling` | `none`;

export interface CiDelivery {
    readonly state: CiDeliveryState;
    readonly summary: string;
    // Manual webhook setup recipe for the first unwired repo; present only when state is `polling`.
    readonly detail?: string;
}

const describe = (repos: readonly CiRepo[], repoFilter: string): CiDelivery => {
    // Narrowed to one repo when the trigger has one; other repos' wiring doesn't affect this answer.
    const scoped = repoFilter === `` ? repos : repos.filter((repo) => repo.repo === repoFilter);
    if (scoped.length === 0) {
        return {
            state: `none`,
            summary: repoFilter === `` ? t(`useCiDelivery.noRepoMaps`) : t(`useCiDelivery.namedRepoDoesNotMap`, { repo: repoFilter }),
        };
    }
    const unwired = scoped.filter((repo) => repo.hookWarning !== undefined);
    if (unwired.length === 0) {
        return { state: `ok`, summary: t(`useCiDelivery.firesWithinSecondsProvider`) };
    }
    const names = unwired.map((repo) => repo.repo).join(`, `);
    const first = unwired[0]?.hookWarning;
    return {
        state: `polling`,
        summary:
            unwired.length === scoped.length
                ? t(`useCiDelivery.allPolled`, { minutes: POLL_MINUTES })
                : t(
                      `useCiDelivery.partlyPolled`,
                      { wired: scoped.length - unwired.length, total: scoped.length, names, minutes: POLL_MINUTES },
                      unwired.length,
                  ),
        ...(first !== undefined ? { detail: first } : {}),
    };
};

// `repo` is the trigger's channelId (blank ⇒ every mapped repo); fetches only while a caller is actively viewing a CI
// trigger.
export function useCiDelivery(active: Ref<boolean>, repo: Ref<string>) {
    const api = host();
    const query = useQuery({
        queryKey: api.sandbox.key(`ci-delivery`),
        queryFn: async (): Promise<CiRepo[]> => (await api.sandbox.rpc.ci.runs()).repos,
        enabled: computed(() => active.value && api.sandbox.reachable()),
    });
    return {
        // Undefined until the first answer lands, rather than guessing `none` and reading as broken.
        delivery: computed<CiDelivery | undefined>(() =>
            query.data.value === undefined ? undefined : describe(query.data.value, repo.value.trim()),
        ),
    };
}
