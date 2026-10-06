import { PROCESS_ROLES, type ProcessRole, type SandboxMetrics } from "@intentic/sandbox-contract";
import { definePreference } from "@intentic/ui/preference";
import { computed, type ComputedRef, type InjectionKey, type Ref } from "vue";
import { rpcQuery } from "../../../client/sandbox/rpcQuery";
import { useSandboxQuery } from "../../../client/sandbox/useSandboxQuery";
import { supportsRoute } from "../../../client/sandbox/useDaemonRoutes";

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
    const { query } = useSandboxQuery({
        ...rpcQuery(`system.metrics`, undefined, { unpersisted: true }),
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

// One conversation's processes, the agent's own and everything it started, as the reading names them.
export interface SessionShare {
    readonly id: string;
    readonly rssBytes: number;
    readonly cpuPercent: number | undefined;
    readonly processes: number;
}

// The conversations holding the most memory, heaviest first, the busier on CPU first where two hold the same: what
// "By session" lists, which answers where the memory went in one look instead of a scan across three lanes of cards.
export const heaviestSessions = (sessions: SandboxMetrics[`sessions`]): SessionShare[] =>
    Object.entries(sessions)
        .map(([id, session]) => ({ id, rssBytes: session.rssBytes, cpuPercent: session.cpuPercent, processes: session.processes }))
        .toSorted((left, right) => right.rssBytes - left.rssBytes || (right.cpuPercent ?? 0) - (left.cpuPercent ?? 0));

// A conversation holding this share of the sandbox's memory limit is heavy: its figure is tinted on its card and in the
// panel. Memory, not CPU, since memory is what runs out (the gate that holds a turn and the kernel's OOM killer both
// read it), while a busy CPU only makes work queue.
export const HEAVY_SESSION_SHARE = 0.25;

export const sessionHeavy = (rssBytes: number, sandbox: SandboxMetrics[`sandbox`]): boolean =>
    sandbox.memoryLimitBytes > 0 && rssBytes >= HEAVY_SESSION_SHARE * sandbox.memoryLimitBytes;

// Past this share of a limit, a figure is worth the reader's attention before the kernel decides for them.
export const NEAR_LIMIT = 0.9;
// Pressure, in percent of the last ten seconds, worth a place on the line at all: below it nothing is waiting.
export const PRESSURE_WORTH_SHOWING = 1;
// Pressure at which work is stalling rather than merely queuing now and then.
export const PRESSURE_STALLING = 10;
