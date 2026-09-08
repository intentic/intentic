import type { DeployAlert } from "./contract";

// A badge must mean something happened, never a running statistic (counting stopped resources would light the rail
// forever). This counts edges instead: Komodo's alert log already timestamps and resolves each transition, so no local
// history is needed, only which transitions are addressed to the owner and whether they've been seen.
// resolved alerts: closing is the recovery, not news
// image updates as danger: a routine bump, not a breakage
// AutoUpdated/ScheduleRun/Test/None: the system's own doing
// Komodo unreachable: handled in attention.ts, not a breakage

export type IncidentTone = "danger" | "warning" | "info";

export interface Incident {
    readonly alert: DeployAlert;
    readonly tone: IncidentTone;
    // One line, already phrased for a human: what, where, and which way it moved.
    readonly summary: string;
}

// States meaning broken when transitioned into; sitting in `exited` says nothing, transitioning into it does.
const BROKEN_STATES = new Set(["exited", "dead", "restarting", "unhealthy"]);

// Breakage in themselves, whatever they carry; Komodo already names the resource kind in the variant.
const FAILURE_TYPES = new Set(["ServerUnreachable", "SwarmUnhealthy", "BuildFailed", "RepoBuildFailed", "ProcedureFailed", "ActionFailed"]);

// Real but flappy; a risk being carried, not an outage, though disk left unattended does become one.
const THRESHOLD_TYPES = new Set(["ServerCpu", "ServerMem", "ServerDisk"]);

const UPDATE_TYPES = new Set(["DeploymentImageUpdateAvailable", "StackImageUpdateAvailable", "ResourceSyncPendingUpdates"]);

const STATE_CHANGE_TYPES = new Set(["ContainerStateChange", "StackStateChange"]);

// Where it happened, as a suffix, " on prod-1", or nothing when the alert names no host.
const where = (alert: DeployAlert): string => (alert.server === undefined ? `` : ` on ${alert.server}`);

const named = (alert: DeployAlert): string => alert.resource ?? alert.server ?? `something`;

// Plain words: a raw variant tag like "ContainerStateChange" isn't a sentence anyone can act on. Unknown variants fall
// through to their own tag rather than being swallowed; showing one badly beats not showing it.
const summarize = (alert: DeployAlert): string => {
    if (alert.type === `ServerUnreachable`) {
        return `${named(alert)} is unreachable`;
    }
    if (STATE_CHANGE_TYPES.has(alert.type)) {
        const from = alert.from === undefined ? `` : `${alert.from} → `;
        return `${named(alert)} ${from}${alert.to ?? `changed state`}${where(alert)}`;
    }
    if (UPDATE_TYPES.has(alert.type)) {
        return `${named(alert)} has a newer image${where(alert)}`;
    }
    if (FAILURE_TYPES.has(alert.type)) {
        return `${named(alert)} failed${where(alert)}`;
    }
    if (THRESHOLD_TYPES.has(alert.type)) {
        // ServerCpu/ServerMem/ServerDisk → "cpu", "mem", "disk".
        return `${named(alert)} is high on ${alert.type.replace(`Server`, ``).toLowerCase()}`;
    }
    return `${named(alert)}: ${alert.type}${where(alert)}`;
};

// Alert's tier, or undefined when it's not the owner's business. A state change is judged by where it landed, not
// Komodo's own configurable severity level, so a tuned-down alerter can't disagree with the board.
export const incidentTone = (alert: DeployAlert): IncidentTone | undefined => {
    if (STATE_CHANGE_TYPES.has(alert.type)) {
        return alert.to !== undefined && BROKEN_STATES.has(alert.to) ? `danger` : undefined;
    }
    if (FAILURE_TYPES.has(alert.type)) {
        return `danger`;
    }
    if (THRESHOLD_TYPES.has(alert.type)) {
        return `warning`;
    }
    return UPDATE_TYPES.has(alert.type) ? `info` : undefined;
};

// Every open alert that's somebody's business, newest first. Resolved ones drop here, not in the caller: a closed alert
// is history, which belongs in the log, not the incident strip.
export const incidents = (alerts: readonly DeployAlert[]): Incident[] =>
    alerts
        .filter((alert) => !alert.resolved)
        .flatMap((alert) => {
            const tone = incidentTone(alert);
            return tone === undefined ? [] : [{ alert, tone, summary: summarize(alert) }];
        })
        .toSorted((a, b) => b.alert.ts - a.alert.ts);

// Incidents opened after the owner last looked. A seen one stays silent on the rail (but still visible in the panel),
// so a days-long outage doesn't just repeat the badge.
export const unseenIncidents = (all: readonly Incident[], seenAt: number | undefined): Incident[] =>
    all.filter((incident) => incident.alert.ts > (seenAt ?? 0));

const RANK: Record<IncidentTone, number> = { danger: 0, warning: 1, info: 2 };

// Worst tier present, and only that tier: one tile carries one number, so mixing "2 down" with "6 updates" into an 8
// would mean nothing.
export const topTier = (all: readonly Incident[]): Incident[] => {
    const worst = all.reduce<IncidentTone | undefined>(
        (best, incident) => (best === undefined || RANK[incident.tone] < RANK[best] ? incident.tone : best),
        undefined,
    );
    return worst === undefined ? [] : all.filter((incident) => incident.tone === worst);
};

// What the rail says: named when there's exactly one, since "api exited on prod-1" is actionable and "1" isn't.
// Rendered after the view's own name, so it reads as a continuation, not a repeat.
export const incidentTooltip = (all: readonly Incident[]): string => {
    const [only] = all;
    if (all.length === 1 && only !== undefined) {
        return only.summary;
    }
    const kind = all[0]?.tone === `info` ? `updates available` : `needing you`;
    return `${all.length} ${kind}`;
};
