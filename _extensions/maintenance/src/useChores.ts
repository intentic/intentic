import { assessReport, type ChoreVerdict, CHORES } from "@intentic/sandbox-contract/chores";
import type { ProbeId } from "@intentic/sandbox-contract";
import { useQuery, useQueryClient } from "@tanstack/vue-query";
import { computed, ref, watch } from "vue";
import { choresReportQuery } from "./choresQuery";
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
 * push (contributes.files on .intentic/records/chores/) is what makes a probe finishing or a run landing appear at once,
 * which is the only case where promptness matters. */

const POLL_MS = 5 * 60_000;
/* How fast the panel asks while something is actually being measured. The slow poll above is right for standing
 * evidence and completely wrong for work in flight: a probe that finishes in eight seconds would leave the row
 * spinning for five minutes, which is a worse lie than the one this whole change exists to fix. Two seconds is
 * cheap because it only ever runs while the reader is watching a spinner they asked for. */
const MEASURING_POLL_MS = 2000;
/* How long a click is believed on its own, before the daemon has confirmed it in `running`. The gap is one
 * request, but it is the gap the button is judged on — the whole complaint was that pressing it changed nothing
 * — so the click marks the probe measuring immediately and this is only the backstop for an ack that never
 * arrives (the daemon restarted, the probe id went away). Long enough to cover a slow first poll. */
const UNCONFIRMED_MS = 15_000;

// Repo + probe, the key both halves of "what is measuring" agree on.
export const probeKey = (repo: string, id: string): string => `${repo}|${id}`;

/* A measurement in flight, as the panel needs to draw it. `startedAt` absent means it is waiting behind another
 * one — the runner has one lane across the sandbox — and the row says "queued" rather than counting up from a
 * start that has not happened. */
export interface MeasuringProbe {
    readonly repo: string;
    readonly id: ProbeId;
    readonly askedAt: number;
    readonly startedAt?: number | undefined;
}

export function useChores() {
    const api = host();
    const queryClient = useQueryClient();
    // The first key segment matches the manifest's `contributes.files` invalidation for .intentic/records/chores/, so a
    // probe the background runner just wrote reaches the panel without a poll.
    const reportKey = computed(() => api.sandbox.key(`maintenance-report`));

    // What THIS panel has asked for and not yet seen confirmed, so the click lands on screen in the same frame it
    // happened rather than one request later. Cleared by the reconciliation below, never by a timer alone.
    const asked = ref(new Map<string, number>());

    const query = useQuery({
        queryKey: reportKey,
        enabled: computed(() => api.sandbox.reachable()),
        /* Fast while anything is measuring, slow the rest of the time. Read off the query's OWN state rather
         * than the `measuring` computed below, which would be a cycle — and OR'd with this panel's unconfirmed
         * clicks, because the first moments after a press are precisely when the report has not yet heard about
         * the work and the reader most needs it to. */
        refetchInterval: (state) => (asked.value.size > 0 || (state.state.data?.running ?? []).length > 0 ? MEASURING_POLL_MS : POLL_MS),
        // The shared definition, so this panel, the rail badge's timer and the host's read-ahead all fill and
        // read ONE entry — see choresQuery. Opening this view usually finds it already answered.
        queryFn: () => choresReportQuery().queryFn(),
    });

    /* WHAT IS BEING MEASURED — the daemon's lane, plus this panel's own unconfirmed clicks.
     *
     * Both halves are needed and neither is enough. The daemon's list is the truth about work, but it arrives a
     * request late, which is exactly the window the reader is staring at the button in. The local list is
     * instant, but it is a wish, and a wish that outlived its request is how a row ends up spinning forever. So a
     * click shows immediately, the daemon's answer takes over the moment it lands, and an unconfirmed click
     * expires — the row falls back to the evidence rather than lying about it. */
    const measuring = computed<MeasuringProbe[]>(() => {
        const live = query.data.value?.running ?? [];
        const known = new Set(live.map((entry) => probeKey(entry.repo, entry.id)));
        const unconfirmed = [...asked.value].flatMap(([key, askedAt]) => {
            const [repo, id] = key.split(`|`);
            return known.has(key) || repo === undefined || id === undefined ? [] : [{ repo, id: id as ProbeId, askedAt }];
        });
        return [...live, ...unconfirmed];
    });

    /* Forget a click once the daemon has taken it over, once the probe has actually re-run, or once it is old
     * enough that no ack is coming. Written as a plain read-time prune rather than a watcher because it is a
     * question about the CURRENT report, and a watcher would answer it one tick after the render that needed it. */
    const settle = (): void => {
        const report = query.data.value;
        const live = new Set((report?.running ?? []).map((entry) => probeKey(entry.repo, entry.id)));
        const now = Date.now();
        const kept = [...asked.value].filter(([key, askedAt]) => {
            if (live.has(key)) {
                return false;
            }
            const [repo, id] = key.split(`|`);
            const ran = report?.repos.find((entry) => entry.repo === repo)?.probes.find((probe) => probe.id === id)?.ranAt ?? 0;
            return ran < askedAt && now - askedAt < UNCONFIRMED_MS;
        });
        if (kept.length !== asked.value.size) {
            asked.value = new Map(kept);
        }
    };

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

    /* Re-run one repository's probe now, ahead of its TTL. An ack: the daemon queues it and the result arrives
     * through the file push or the next poll — a jscpd sweep outlives any request.
     *
     * The probe is marked measuring BEFORE the request, not after. The round trip is short but it is not free,
     * and the press has to change the screen in the frame it happened — that is the whole of what "the button
     * does nothing" meant. If the ack fails, the mark comes straight back off and the caller shows the error. */
    const refreshProbe = async (repo: string, id: string): Promise<void> => {
        const key = probeKey(repo, id);
        asked.value = new Map([...asked.value, [key, Date.now()]]);
        try {
            await api.sandbox.json(`/chores/probe`, {
                method: `POST`,
                headers: { "content-type": `application/json` },
                body: JSON.stringify({ repo, id }),
            });
        } catch (failure) {
            asked.value = new Map([...asked.value].filter(([held]) => held !== key));
            throw failure;
        }
        // Ask again straight away rather than waiting out the interval: the report that comes back is the one
        // that carries this probe as running, which is what turns the optimistic mark into a confirmed one.
        await queryClient.invalidateQueries({ queryKey: reportKey.value });
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

    // Every report is the answer to "has my click been taken over yet", so settling rides on the data rather than
    // on a timer of its own — a probe that finished between two polls stops spinning on the poll that saw it.
    watch(() => query.dataUpdatedAt.value, settle, { immediate: true });

    return {
        report: computed(() => query.data.value),
        verdicts,
        byRepo,
        // What is being measured right now, this panel's own unconfirmed clicks included — the state every
        // surface that offers a re-measure draws its progress on.
        measuring,
        measuringKeys: computed(() => new Set(measuring.value.map((entry) => probeKey(entry.repo, entry.id)))),
        error: computed(() => query.error.value?.message),
        // isPending, not isLoading: true from mount until the FIRST report, INCLUDING the window where `enabled`
        // still gates the fetch on the sandbox handshake. isLoading is false in that window (nothing is in
        // flight), and a panel that trusts it renders "Nothing needs attention" over a report it has not read —
        // the one sentence this surface must never say wrongly.
        isPending: query.isPending,
        refresh: async (): Promise<void> => {
            await queryClient.invalidateQueries({ queryKey: reportKey.value });
        },
        refreshProbe,
        snooze,
    };
}
