import { PROCESS_ROLES, type ProcessRole, type SandboxMetrics, SandboxMetricsSchema } from "@intentic/sandbox-contract";
import { definePreference } from "@intentic/ui/preference";
import { computed, type ComputedRef, type InjectionKey, type Ref } from "vue";
import { LIVE_METRICS } from "../../../lib/queryKeys";
import { UNPERSISTED } from "../../../lib/queryPersistence";
import { sandboxJson } from "../../sandbox/client/sandboxClient";
import { useSandboxQuery } from "../../sandbox/client/useSandboxQuery";
import { supportsRoute } from "../../sandbox/overview/useDaemonRoutes";

// The Agents board's opt-in CPU and memory readout ("geek metrics"). Off means never asked for: the daemon measures
// only inside a request, so with the query disabled nothing anywhere is collected, not merely hidden.

export const showLiveMetrics: Ref<boolean> = definePreference<boolean>({
    key: `ui-agents-live-metrics`,
    read: (raw) => raw === `on`,
    write: (value) => (value ? `on` : `off`),
});

// How often an open board asks; the daemon answers requests under a second apart from one reading, so two windows
// cost what one does.
export const LIVE_METRICS_POLL_MS = 3_000;

// Provided by the board, so a card drawn anywhere else never starts a read of its own.
export const LIVE_METRICS_KEY: InjectionKey<ComputedRef<SandboxMetrics | undefined>> = Symbol(`liveMetrics`);

// Called by the board alone: leaving it drops the only observer, which stops the polling, and a hidden tab is never
// polled. A refused read (a guest, an older daemon) stops asking until the board is opened again.
export function useLiveMetrics(): ComputedRef<SandboxMetrics | undefined> {
    const { query } = useSandboxQuery<SandboxMetrics>({
        queryKey: LIVE_METRICS.of(UNPERSISTED),
        queryFn: async () => SandboxMetricsSchema.parse(await sandboxJson(`/system/metrics`)),
        enabled: computed(() => showLiveMetrics.value && supportsRoute(`system.metrics`)),
        refetchInterval: (current) => (current.state.status === `error` ? false : LIVE_METRICS_POLL_MS),
        staleTime: 0,
        retry: false,
    });
    return computed(() => (showLiveMetrics.value ? query.data.value : undefined));
}

export interface RoleShare {
    readonly role: ProcessRole;
    readonly rssBytes: number;
}

// The kinds holding the most memory, heaviest first; what "memory by kind" names before it runs out of room.
export const heaviestRoles = (roles: SandboxMetrics[`roles`], limit: number): RoleShare[] =>
    PROCESS_ROLES.flatMap((role) => {
        const group = roles[role];
        return group === undefined || group.rssBytes === 0 ? [] : [{ role, rssBytes: group.rssBytes }];
    })
        .toSorted((left, right) => right.rssBytes - left.rssBytes)
        .slice(0, limit);

// Past this share of a limit, a figure is worth the reader's attention before the kernel decides for them.
export const NEAR_LIMIT = 0.9;
// Pressure, in percent of the last ten seconds, worth a place on the line at all: below it nothing is waiting.
export const PRESSURE_WORTH_SHOWING = 1;
// Pressure at which work is stalling rather than merely queuing now and then.
export const PRESSURE_STALLING = 10;
