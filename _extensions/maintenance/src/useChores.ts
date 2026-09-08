import { assessReport, type ChoreVerdict, CHORES } from "@intentic/sandbox-contract/chores";
import type { ProbeId } from "@intentic/sandbox-contract";
import { useQuery, useQueryClient } from "@tanstack/vue-query";
import { computed, ref, watch } from "vue";
import { choresReportQuery } from "./choresQuery";
import { host } from "./host";

// One request (`GET /chores`) carries every repository's cached probes and ledger; verdicts are computed here in the
// browser, not the daemon, so the rail badge and this panel share one computation and cannot disagree:
// the daemon measures: it has a filesystem, a shell, a resident index
// the browser decides: it ships with the product and can be updated

const POLL_MS = 5 * 60_000;
// Poll rate while a probe is in flight; only runs while the reader watches a spinner they asked for.
const MEASURING_POLL_MS = 2000;
// How long an unconfirmed click is trusted before falling back; backstop for an ack that never arrives.
const UNCONFIRMED_MS = 15_000;

// Repo + probe, the key both halves of "what is measuring" agree on.
const probeKey = (repo: string, id: string): string => `${repo}|${id}`;

// A measurement in flight. `startedAt` absent means queued behind another (one runner lane sandbox-wide); the row says
// 'queued' rather than counting from nothing.
export interface MeasuringProbe {
    readonly repo: string;
    readonly id: ProbeId;
    readonly askedAt: number;
    readonly startedAt?: number | undefined;
}

export function useChores() {
    const api = host();
    const queryClient = useQueryClient();
    // Matches the manifest's `contributes.files` invalidation, so a fresh probe reaches the panel unpolled.
    const reportKey = computed(() => api.sandbox.key(`maintenance-report`));

    // Unconfirmed clicks from this panel, shown before the daemon confirms; cleared only by reconciliation.
    const asked = ref(new Map<string, number>());

    const query = useQuery({
        queryKey: reportKey,
        enabled: computed(() => api.sandbox.reachable()),
        // Fast while measuring; reads the query's own state, not `measuring` (a cycle), OR'd with unconfirmed clicks.
        refetchInterval: (state) => (asked.value.size > 0 || (state.state.data?.running ?? []).length > 0 ? MEASURING_POLL_MS : POLL_MS),
        // Shared definition: this panel, the rail badge and the host's read-ahead all fill and read one entry.
        queryFn: () => choresReportQuery().queryFn(),
    });

    // Daemon's list (truth, but a request late) plus this panel's unconfirmed clicks (instant, but a wish). A click
    // shows immediately, the daemon's answer takes over, and an unconfirmed one expires rather than spinning forever.
    const measuring = computed<MeasuringProbe[]>(() => {
        const live = query.data.value?.running ?? [];
        const known = new Set(live.map((entry) => probeKey(entry.repo, entry.id)));
        const unconfirmed = [...asked.value].flatMap(([key, askedAt]) => {
            const [repo, id] = key.split(`|`);
            return known.has(key) || repo === undefined || id === undefined ? [] : [{ repo, id: id as ProbeId, askedAt }];
        });
        return [...live, ...unconfirmed];
    });

    // Drops a click once the daemon has taken it over, the probe re-ran, or no ack arrived in time. A read-time prune,
    // not a watcher, which would answer a tick late.
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

    // Re-derived every render, not memoised: cadence and snooze lapsing depend on elapsed time, and a stale claim
    // overnight would be wrong.
    const verdicts = computed<ChoreVerdict[]>(() => (query.data.value === undefined ? [] : assessReport(query.data.value, Date.now())));

    // Repo to its verdicts, in CHORES' reading order; repos stay in `GET /chores`'s own discovery order (workspace root
    // first).
    const byRepo = computed(() =>
        (query.data.value?.repos ?? []).map(({ repo }) => ({
            repo,
            verdicts: CHORES.flatMap((chore) => verdicts.value.filter((verdict) => verdict.repo === repo && verdict.chore.id === chore.id)),
            probes: query.data.value?.repos.find((entry) => entry.repo === repo)?.probes ?? [],
        })),
    );

    // Requests one probe re-run; an ack only, the result lands via file push or the next poll. Marked measuring before
    // the request so the press changes the screen immediately; a failed ack rolls it back.
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
        // Invalidates immediately, so the next report can confirm the optimistic mark right away.
        await queryClient.invalidateQueries({ queryKey: reportKey.value });
    };

    // Snoozes a chore, or un-snoozes it (a past date); written as a ledger row, where the chore's current truth already
    // lives.
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
                // Evidence's digest, so new evidence is never covered by an old snooze on stale evidence.
                digest: verdict.digest,
                snoozedUntil: until,
            }),
        });
        await queryClient.invalidateQueries({ queryKey: reportKey.value });
    };

    // Settles on every new report, not its own timer; a finished probe stops spinning on the poll that saw it.
    watch(() => query.dataUpdatedAt.value, settle, { immediate: true });

    return {
        report: computed(() => query.data.value),
        verdicts,
        byRepo,
        // Includes this panel's unconfirmed clicks; a flat list, not a keyed set: rows only need a start time.
        measuring,
        error: computed(() => query.error.value?.message),
        // isPending, not isLoading: true even while `enabled` still gates the fetch on the sandbox handshake.
        isPending: query.isPending,
        refresh: async (): Promise<void> => {
            await queryClient.invalidateQueries({ queryKey: reportKey.value });
        },
        refreshProbe,
        snooze,
    };
}
