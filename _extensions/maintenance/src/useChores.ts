import { assessReport, type ChoreVerdict, CHORES } from "@intentic/sandbox-contract/chores";
import { type ChoresReport, ChoresReportSchema } from "@intentic/sandbox-contract";
import { useQuery, useQueryClient } from "@tanstack/vue-query";
import { computed } from "vue";
import { host } from "./host";

/* The evidence, and what it means. One request — `GET /chores` carries every repository's cached probe results,
 * its resident signals and the ledger — and then @intentic/sandbox-contract/chores turns that into verdicts HERE, in the
 * browser, which is the seam the whole design rests on:
 *
 *   the daemon measures        it is the thing with a filesystem, a shell and a resident index
 *   the browser decides        it is the thing that ships with the product, and can be updated
 *
 * A sandbox daemon is baked into an image the owner updates when they feel like it, so a daemon that also
 * computed verdicts would be arguing with the browser about what needs doing every time the chore book changed.
 * It also means the rail badge (attention.ts) and this panel run the SAME function over the SAME report — the
 * number on the tile and the reason in the panel are one computation, and cannot drift apart.
 *
 * The poll is slow because nothing here is urgent: probes refresh on a daily-to-weekly TTL, so a panel that
 * re-read every few seconds would be asking a question whose answer changes twice a week. The daemon's own file
 * push (contributes.files on .intentic/chores/) is what makes a probe finishing or a run landing appear at once,
 * which is the only case where promptness matters. */

const POLL_MS = 5 * 60_000;

export function useChores() {
    const api = host();
    const queryClient = useQueryClient();
    // The first key segment matches the manifest's `contributes.files` invalidation for .intentic/chores/, so a
    // probe the background runner just wrote reaches the panel without a poll.
    const reportKey = computed(() => api.sandbox.key(`maintenance-report`));

    const query = useQuery({
        queryKey: reportKey,
        enabled: computed(() => api.sandbox.reachable()),
        refetchInterval: POLL_MS,
        queryFn: async (): Promise<ChoresReport> => ChoresReportSchema.parse(await api.sandbox.json(`/chores`)),
    });

    /* Re-derived on every render tick rather than memoised against a clock: two of the verdicts depend on elapsed
     * time (a survey's cadence, a snooze lapsing), and a panel left open overnight that still claims a chore is
     * snoozed is lying about the only fact the reader came to check. */
    const verdicts = computed<ChoreVerdict[]>(() => (query.data.value === undefined ? [] : assessReport(query.data.value, Date.now())));

    // Repo → its verdicts, in the book's own order (the chore book's CHORES array is a product decision about reading
    // order, not the order they happened to be written in), and repos in the daemon's discovery order with the
    // workspace root first — which is what `GET /chores` already returns.
    const byRepo = computed(() =>
        (query.data.value?.repos ?? []).map(({ repo }) => ({
            repo,
            verdicts: CHORES.flatMap((chore) => verdicts.value.filter((verdict) => verdict.repo === repo && verdict.chore.id === chore.id)),
            probes: query.data.value?.repos.find((entry) => entry.repo === repo)?.probes ?? [],
        })),
    );

    // Re-run one repository's probe now, ahead of its TTL. An ack: the daemon runs it in the background, and the
    // result arrives through the file push or the next poll — a jscpd sweep outlives any request.
    const refreshProbe = async (repo: string, id: string): Promise<void> => {
        await api.sandbox.json(`/chores/probe`, {
            method: `POST`,
            headers: { "content-type": `application/json` },
            body: JSON.stringify({ repo, id }),
        });
    };

    // Snooze a chore, or take a snooze back (a date in the past). Written as a ledger row because that is where
    // "what is currently true about this chore" already lives; nothing else in the row changes.
    const snooze = async (verdict: ChoreVerdict, until: number): Promise<void> => {
        await api.sandbox.json(`/chores/ledger`, {
            method: `POST`,
            headers: { "content-type": `application/json` },
            body: JSON.stringify({
                repo: verdict.repo,
                chore: verdict.chore.id,
                ranAt: verdict.lastRun?.ranAt ?? 0,
                runId: verdict.lastRun?.runId ?? ``,
                outcome: verdict.lastRun?.outcome ?? `reported`,
                // The digest of the evidence being snoozed, so that NEW evidence is not covered by an old snooze:
                // "not this quarter" said about four outdated majors should not also silence a critical advisory
                // that arrives next week.
                digest: verdict.digest,
                snoozedUntil: until,
            }),
        });
        await queryClient.invalidateQueries({ queryKey: reportKey.value });
    };

    return {
        report: computed(() => query.data.value),
        verdicts,
        byRepo,
        error: computed(() => query.error.value?.message),
        isLoading: query.isLoading,
        refresh: async (): Promise<void> => {
            await queryClient.invalidateQueries({ queryKey: reportKey.value });
        },
        refreshProbe,
        snooze,
    };
}
