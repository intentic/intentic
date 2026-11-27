import type { ViewBadge } from "@intentic/extension-api";
import { sandboxPoll } from "@intentic/extension-api";
import type { AgentRunBooking, AgentRunChoice } from "@intentic/extension-ui";
import { runPickOf } from "@intentic/sandbox-contract/schemas/agent";
import type { FixResume } from "@intentic/sandbox-contract/state/fix-attempt-plan";
import { useMutation, useQuery, useQueryClient } from "@tanstack/vue-query";
import { computed } from "vue";
import { host } from "./host";
import { t } from "./i18n.js";
import { attentionOf } from "./owed";
import { type Finding, type FixRequest, type FixResponse, routes, type Snapshot } from "./wire";

/* THE VIEW'S DATA: the backend's snapshot (src/server, the last round of reading PostHog joined with the agents on it),
   and the presses. The badge reads the same snapshot on its own poll from activation, so the tile is live while the
   view is closed, and a press refreshes both. */

// The backend reads PostHog every ten minutes; a minute here is only how soon an agent's change of stance shows.
const POLL_MS = 60_000;

export const snapshotQuery = () => ({
    queryKey: host().sandbox.key(`product-health`, `snapshot`),
    queryFn: (): Promise<Snapshot> => host().backend.json<Snapshot>(routes.snapshot),
});

const post = <T>(path: string, body: FixRequest | { readonly origin: string } | undefined): Promise<T> =>
    host().backend.json<T>(path, { method: `POST`, headers: { "content-type": `application/json` }, body: JSON.stringify(body ?? {}) });

// The badge: what the findings owe the reader (owed.ts), never cleared by looking.
const { state: badge, start: startBadge, refresh: refreshBadge } = sandboxPoll<ViewBadge | undefined>({
    host,
    everyMs: POLL_MS,
    initial: () => undefined,
    read: async (api) => {
        const snapshot = await api.sandbox.fetch(snapshotQuery());
        const attention = attentionOf(snapshot.findings, Date.now());
        if (attention.owed === 0) {
            return undefined;
        }
        const tooltip = [t(`badge.owed`, { count: attention.owed }, attention.owed), attention.handled === 0 ? undefined : t(`badge.handled`, { count: attention.handled })]
            .filter((part) => part !== undefined)
            .join(` · `);
        return { count: attention.owed, tooltip, tone: attention.tone };
    },
});
export { badge, startBadge };

/** What a press of the fix button asks: the caret's pick (or the standing model, for a booked run), its verb, its booking. */
export const fixRequestOf = (pick: AgentRunChoice | undefined, standing: AgentRunChoice, mode: FixResume | undefined, booking: AgentRunBooking | undefined): FixRequest => {
    const named = pick ?? (booking !== undefined && standing.model !== `` ? standing : undefined);
    return {
        pick: named === undefined ? undefined : runPickOf(named),
        mode,
        sendAt: booking?.sendAt,
        sendAtReopen: booking?.sendAtReopen,
    };
};

export interface FixPress {
    readonly finding: Finding;
    readonly request: FixRequest;
}

export function useHealth() {
    const api = host();
    const queryClient = useQueryClient();
    const spec = snapshotQuery();
    const { data, error, isPending } = useQuery({ ...spec, enabled: computed(() => api.sandbox.reachable()), refetchInterval: POLL_MS });
    const settle = async (): Promise<void> => {
        await queryClient.invalidateQueries({ queryKey: spec.queryKey });
        refreshBadge();
    };
    const press = (verb: `resolve` | `dismiss` | `snooze`) =>
        useMutation({ mutationFn: (finding: Finding) => post<{ readonly ok: true }>(routes.finding(finding.id, verb), undefined), onSettled: settle });

    return {
        snapshot: computed(() => data.value),
        error: computed(() => error.value?.message),
        isPending,
        refresh: useMutation({
            mutationFn: () => post<Snapshot>(routes.refresh, undefined),
            onSuccess: (snapshot) => queryClient.setQueryData(spec.queryKey, snapshot),
            onSettled: settle,
        }),
        fix: useMutation({ mutationFn: ({ finding, request }: FixPress) => post<FixResponse>(routes.finding(finding.id, `fix`), request), onSettled: settle }),
        resolve: press(`resolve`),
        dismiss: press(`dismiss`),
        snooze: press(`snooze`),
        wire: useMutation({
            mutationFn: (connection: string) => post<{ readonly created: number }>(routes.wire(connection), { origin: api.sandbox.origin() ?? window.location.origin }),
            onSettled: settle,
        }),
    };
}
