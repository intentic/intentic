import { PROCESS_ROLES, type ProcessRole, type SandboxMetrics } from "@intentic/sandbox-contract/schemas/metrics";
import { definePreference } from "@intentic/ui/preference";
import { computed, type ComputedRef, type InjectionKey, type Ref } from "vue";
import { rpcQuery } from "../../client/sandbox/rpcQuery";
import { useSandboxQuery } from "../../client/sandbox/useSandboxQuery";
import { supportsRoute } from "../../client/sandbox/useDaemonRoutes";

// The sandbox's opt-in CPU, memory and disk readout ("geek metrics"), in the status bar and on the board's cards. Off
// means never asked for: the daemon measures only inside a request, so with the query disabled nothing anywhere is
// collected, not merely hidden.

export const showLiveMetrics: Ref<boolean> = definePreference<boolean>({
    key: `ui-agents-live-metrics`,
    read: (raw) => raw === `on`,
    write: (value) => (value ? `on` : `off`),
});

// How often an open board asks; the daemon answers requests under a second apart from one reading, so two windows
// cost what one does.
export const LIVE_METRICS_POLL_MS = 3_000;

// Provided by the desktop shell, so a card never starts a read of its own. A phone provides nothing: its cards draw no
// share and nothing is measured for it (features/agents/board/AgentsView.vue).
export const LIVE_METRICS_KEY: InjectionKey<ComputedRef<SandboxMetrics | undefined>> = Symbol(`liveMetrics`);

// Called once per window, by the desktop shell for its status bar. A hidden tab is never polled. A refused read (a guest, an older daemon) stops
// asking until the reader comes back to it.
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

// WHAT A CARD HOLDS, NOT WHAT ONE CONVERSATION DOES. The daemon measures per conversation (each process is stamped with the
// conversation it works for), but the board draws a family as one card: the children a conversation spawned and their
// children, the fresh sessions opened on its work, a workflow run's steps. Each of those has processes of its own, so a
// card that read only its own conversation's entry said an orchestrator with four working children held what its one
// runtime process did. Here every conversation's figures fold into the card it is drawn under (`cardOf`, which the board's
// own fold answers: models/fleet/board/metricsCards.ts), so the card and the panel's list say what the family holds, and
// only what stands as a card of its own on the board is counted on its own. A subagent the runtime ran in-process needs no
// folding: it is the parent's own process.

// One card's share of a reading: its conversation's processes and those of everything grouped under it.
export interface CardUsage {
    readonly rssBytes: number;
    // Undefined while none of its conversations has a CPU figure yet (a first reading).
    readonly cpuPercent: number | undefined;
    readonly processes: number;
    // The grouped conversations besides the card's own that hold processes now, and what they hold between them.
    readonly grouped: number;
    readonly groupedRssBytes: number;
}

// A workflow run's card, keyed apart from any conversation's id, since a run is a card with no conversation of its own.
export const runCardKey = (runId: string): string => `run:${runId}`;

// Every card's usage, by the card each conversation is drawn under; a conversation no card groups is its own card.
export const cardUsages = (sessions: SandboxMetrics[`sessions`], cardOf: (conversationId: string) => string = (id) => id): Map<string, CardUsage> => {
    const cards = new Map<string, CardUsage>();
    for (const [id, session] of Object.entries(sessions)) {
        const card = cardOf(id);
        const held = cards.get(card) ?? { rssBytes: 0, cpuPercent: undefined, processes: 0, grouped: 0, groupedRssBytes: 0 };
        const own = card === id;
        cards.set(card, {
            rssBytes: held.rssBytes + session.rssBytes,
            cpuPercent: session.cpuPercent === undefined ? held.cpuPercent : (held.cpuPercent ?? 0) + session.cpuPercent,
            processes: held.processes + session.processes,
            grouped: held.grouped + (own ? 0 : 1),
            groupedRssBytes: held.groupedRssBytes + (own ? 0 : session.rssBytes),
        });
    }
    return cards;
};

// The board's cards as the reading folds into them, with what the panel needs to name and open a run's card. Provided
// by the desktop shell beside LIVE_METRICS_KEY; where nothing provides it, every conversation is its own card.
export interface CardMetrics {
    readonly usage: ReadonlyMap<string, CardUsage>;
    // A run's card, by runCardKey: its name, and the conversation a press on its row opens (a step's chat).
    readonly runs: ReadonlyMap<string, { readonly title: string; readonly opens: string | undefined }>;
}

export const CARD_METRICS_KEY: InjectionKey<ComputedRef<CardMetrics | undefined>> = Symbol(`cardMetrics`);

const NO_RUNS: CardMetrics[`runs`] = new Map();

// The cards of a reading: as the provider grouped them, else one card per conversation.
export const cardMetricsOf = (reading: SandboxMetrics, grouped: CardMetrics | undefined): CardMetrics =>
    grouped ?? { usage: cardUsages(reading.sessions), runs: NO_RUNS };

// One card's figures, as "By session" lists them.
export interface SessionShare extends CardUsage {
    // The card's key: its conversation's id, or a run's runCardKey.
    readonly id: string;
}

// The cards holding the most memory, heaviest first, the busier on CPU first where two hold the same: what "By session"
// lists, which answers where the memory went in one look instead of a scan across three lanes of cards.
export const heaviestSessions = (usage: ReadonlyMap<string, CardUsage>): SessionShare[] =>
    [...usage]
        .map(([id, card]) => ({ id, ...card }))
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
