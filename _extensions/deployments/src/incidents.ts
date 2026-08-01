import type { DeployAlert } from "@intentic/sandbox-contract";

/* WHAT REACHES THE RAIL, and the several things that deliberately do not.
 *
 * The rule this whole surface is written against is the extension API's: a badge "must mean something happened
 * here that you don't already know about, never here is a statistic". ciStreaks.ts is the worked example and
 * it is emphatic — a count of failed CI runs is a LEVEL, and on a repo measured at 75 failures in its last 100
 * pipelines the tile is simply always lit, which says nothing anyone can act on and trains the eye to stop
 * seeing the rail at all.
 *
 * The naive deployments badge is that trap verbatim: COUNT THE THINGS NOT RUNNING. A deployment stopped on
 * purpose lights the rail forever, and the number is a level rather than an event.
 *
 * So this counts EDGES — and unlike CI, we do not have to derive them. Komodo's alert log already records the
 * transition: `ContainerStateChange {from, to}`, `ServerUnreachable`, `BuildFailed`, each with an open
 * timestamp and a `resolved` flag it closes when the condition clears. That is precisely the record ciStreaks
 * had to reconstruct from a runs list, so the badge here needs no local history at all — only a decision about
 * which transitions are addressed to the owner, and whether they have looked since.
 *
 * WHAT IS SILENT, and why each one would be a bug:
 *   • every RESOLVED alert — a container-state alert closing IS the recovery, not news of a breakage
 *   • image updates as `danger` — a routine version bump must not spend the colour that means production is
 *     down, and `update_available` is never zero for long on an active registry
 *   • AutoUpdated / ScheduleRun / Test / None — things the system did on purpose, addressed to nobody
 *   • Komodo being unreachable — handled OUTSIDE this file (see attention.ts): "we cannot see production" is
 *     not "production is broken", and reading it as danger would be crying wolf on every network blip
 */

export type IncidentTone = "danger" | "warning" | "info";

export interface Incident {
    readonly alert: DeployAlert;
    readonly tone: IncidentTone;
    // One line, already phrased for a human: what, where, and which way it moved.
    readonly summary: string;
}

/* Container and stack states that mean BROKEN when something moved into them. `exited` is deliberately here
 * while it is NOT an unhealthy chip in the resource list, and the difference is the whole edge-vs-level point:
 * a container sitting exited says nothing (it may have been stopped on purpose), but a container that
 * TRANSITIONED into exited stopped while it was meant to be running. The alert carries the transition; the
 * list only carries the state. */
const BROKEN_STATES = new Set(["exited", "dead", "restarting", "unhealthy"]);

// Alert variants that are a breakage in themselves, whatever they carry. Komodo names the resource kind in the
// variant, so `BuildFailed` and friends need no further interpretation.
const FAILURE_TYPES = new Set(["ServerUnreachable", "SwarmUnhealthy", "BuildFailed", "RepoBuildFailed", "ProcedureFailed", "ActionFailed"]);

// Threshold alerts: real, but they flap, and a host at 91% memory is a risk being carried rather than an
// outage. Disk is the one that turns into an outage if ignored, which is exactly why it belongs on the rail
// as a warning rather than nowhere.
const THRESHOLD_TYPES = new Set(["ServerCpu", "ServerMem", "ServerDisk"]);

const UPDATE_TYPES = new Set(["DeploymentImageUpdateAvailable", "StackImageUpdateAvailable", "ResourceSyncPendingUpdates"]);

const STATE_CHANGE_TYPES = new Set(["ContainerStateChange", "StackStateChange"]);

// Where it happened, as a suffix — " on prod-1", or nothing when the alert names no host.
const where = (alert: DeployAlert): string => (alert.server === undefined ? `` : ` on ${alert.server}`);

const named = (alert: DeployAlert): string => alert.resource ?? alert.server ?? `something`;

// Plain words, because "ContainerStateChange" is not a sentence anyone can act on. Unknown variants fall
// through to their own tag rather than being swallowed — a variant we have not met is exactly the one worth
// showing, and showing it badly beats not showing it.
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

/* One alert's tier, or undefined when it is not the owner's business.
 *
 * A state change is judged by where it LANDED, not by its severity level: Komodo's own level is configurable
 * per alerter and an operator who tuned it down still needs the board to agree with itself. Landing back in
 * `running` is a recovery — which arrives as a resolved alert anyway, and is filtered before this. */
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

// Every open alert that is somebody's business, newest first. Resolved ones are dropped here rather than in
// the caller: a closed alert is history, and history belongs in the view's log, not in the incident strip.
export const incidents = (alerts: readonly DeployAlert[]): Incident[] =>
    alerts
        .filter((alert) => !alert.resolved)
        .flatMap((alert) => {
            const tone = incidentTone(alert);
            return tone === undefined ? [] : [{ alert, tone, summary: summarize(alert) }];
        })
        .toSorted((a, b) => b.alert.ts - a.alert.ts);

// An incident the owner has not looked at since it opened. One they HAVE seen stays silent, which is what
// keeps the badge meaningful through an outage that lasts days — the incident stays visibly in the panel, the
// rail just stops repeating itself.
export const unseenIncidents = (all: readonly Incident[], seenAt: number | undefined): Incident[] =>
    all.filter((incident) => incident.alert.ts > (seenAt ?? 0));

const RANK: Record<IncidentTone, number> = { danger: 0, warning: 1, info: 2 };

// The worst tier present, and only that tier. One tile carries one number, so mixing "2 down" with "6 updates
// available" into an 8 would make the count mean nothing — the outage is what the owner is being called for.
export const topTier = (all: readonly Incident[]): Incident[] => {
    const worst = all.reduce<IncidentTone | undefined>(
        (best, incident) => (best === undefined || RANK[incident.tone] < RANK[best] ? incident.tone : best),
        undefined,
    );
    return worst === undefined ? [] : all.filter((incident) => incident.tone === worst);
};

// What the rail says. Named while there is only one of them, on ciStreaks' reasoning: "api exited on prod-1"
// is a fact someone can act on and "1" is not. The host renders it after the view's own name, so it reads as
// the continuation of a label rather than a sentence that repeats it.
export const incidentTooltip = (all: readonly Incident[]): string => {
    const [only] = all;
    if (all.length === 1 && only !== undefined) {
        return only.summary;
    }
    const kind = all[0]?.tone === `info` ? `updates available` : `needing you`;
    return `${all.length} ${kind}`;
};
