import type { ActivityEvent, ActivityStatus } from "@intentic/sandbox-contract";
import { formatDayMonth } from "@intentic/extension-ui/format";
import { t } from "./i18n";

// Collapses the daemon's event-per-append log into EPISODES (one turn, message, or event) and SOURCES (who set it off);
// pure functions over a fetched page, no request, no clock, no Vue. `provider` is the runtime that served a turn; the
// caller is `origin.provider` or nobody (the user).

// A rail entry: bounded by how many things can call the agent, not by how much traffic they send, so the rail stays a
// short list while the timeline doesn't.
export interface Source {
    readonly key: string;
    // connections: something outside the browser calling in, maybe with live gateway state.
    // direct: the user, typing; the one source that isn't a connection.
    readonly group: "connections" | "direct";
    readonly label: string;
    // Live state for a source the daemon currently holds a connection for; absent for one known only from the log.
    readonly gateway?: ActivityStatus["connections"][number]["gateway"];
    readonly lastError?: string;
    readonly episodes: number;
    readonly failed: number;
    readonly lastAt?: number;
}

// One thing that happened; `events` keeps the raw rows so a row can expand to exactly what the daemon wrote.
export interface Episode {
    readonly key: string;
    readonly sourceKey: string;
    // When the group began (its oldest event), not when it finished.
    readonly at: number;
    readonly kind: "turn" | "message" | "event";
    readonly label: string;
    // Whether the label is a real name or a clipped preview; only a real name makes `detail` worth showing too.
    readonly titled?: boolean;
    // Humanised event type; only on a single-event episode, where the label is its content instead.
    readonly typeName?: string;
    readonly detail?: string;
    // The runtime that served a turn; a facet of the row, not a source of its own.
    readonly runtime?: string;
    readonly channelId?: string;
    readonly author?: string;
    // The transcript this opens, when there is one to open.
    readonly sessionId?: string;
    readonly automationIds?: readonly string[];
    readonly failed: boolean;
    readonly error?: string;
    readonly durationMs?: number;
    readonly costUsd?: number;
    // Provider calls the turn made, folded into the wake's own row instead of their own.
    readonly outbound: number;
    readonly events: readonly ActivityEvent[];
}

// Reserved keys for non-provider callers, safe from collision since a provider key can't be spelled these.
// The user, typing; the one source that isn't a connection.
export const DIRECT = `you`;
// Provider-less automation wakes (cron, webhook): something called, but no connection received it.
export const SCHEDULE = `schedule`;

// A source's display name, from `names` (the listener manifests' own labels and the reserved keys' translated words,
// useSourceNames), else the key capitalized: a runtime ("claude") or a provider whose extension is gone.
export const sourceLabel = (key: string, names: ReadonlyMap<string, string> = new Map()): string =>
    names.get(key) ?? key.charAt(0).toUpperCase() + key.slice(1);

const isTurn = (event: ActivityEvent): boolean => event.type.startsWith(`turn.`);

// A turn files under whatever woke it, falling back to the user; everything else files under its provider.
// Provider-less non-turns are automation nothing external triggered, filed as a schedule rather than the user's work.
export const sourceKeyOf = (event: ActivityEvent): string => {
    if (isTurn(event)) {
        return event.origin?.provider ?? DIRECT;
    }
    return event.provider ?? SCHEDULE;
};

// Built when read, so the words follow the language on screen rather than the one the page booted in.
const typeLabels = (): Readonly<Record<string, string>> => ({
    "message.received": t(`episodes.type.messageReceived`),
    "voice_transcript.received": t(`episodes.type.voiceTranscriptReceived`),
    "voice_utterance.received": t(`episodes.type.voiceUtteranceReceived`),
    "message.send": t(`episodes.type.messageSend`),
    "message.edit": t(`episodes.type.messageEdit`),
    "messages.read": t(`episodes.type.messagesRead`),
    "reaction.add": t(`episodes.type.reactionAdd`),
    "reaction.remove": t(`episodes.type.reactionRemove`),
    "api.call": t(`episodes.type.apiCall`),
    "gateway.login_failed": t(`episodes.type.gatewayLoginFailed`),
    "dispatch.failed": t(`episodes.type.dispatchFailed`),
    "voice.session_started": t(`episodes.type.voiceSessionStarted`),
    "voice.session_ended": t(`episodes.type.voiceSessionEnded`),
    "automation.run": t(`episodes.type.automationRun`),
    "automation.pending": t(`episodes.type.automationPending`),
    // A dependency install the daemon starts when a change leaves the installed tree behind (bootstrap/deps-coordination.ts).
    "deps.install_started": t(`episodes.type.depsInstallStarted`),
    "deps.install_failed": t(`episodes.type.depsInstallFailed`),
    // The rest were the steps of the check that ran over the main tree after every land, retired with it: nothing emits
    // them any more, and they keep their labels because the activity history still holds rows of them.
    "deps.install_lost": t(`episodes.type.depsInstallLost`),
    "deps.verify_green": t(`episodes.type.depsVerifyGreen`),
    "deps.verify_red": t(`episodes.type.depsVerifyRed`),
    "deps.verify_skipped": t(`episodes.type.depsVerifySkipped`),
    "deps.verify_lost": t(`episodes.type.depsVerifyLost`),
    "deps.fix_unarmed": t(`episodes.type.depsFixUnarmed`),
    "turn.started": t(`episodes.type.turnStarted`),
    "turn.plan": t(`episodes.type.turnPlan`),
    "turn.error": t(`episodes.type.turnError`),
    "turn.completed": t(`episodes.type.turnCompleted`),
});

export const typeLabel = (type: string): string => typeLabels()[type] ?? type;

// First line only, clipped short: a prompt can run to 2,000 characters, a row is one line tall.
const headline = (text: string): string => {
    const line = text.split(`\n`).find((candidate) => candidate.trim() !== ``) ?? ``;
    return line.length > 120 ? `${line.slice(0, 119)}…` : line;
};

const numberFrom = (extra: ActivityEvent["extra"], key: string): number | undefined => {
    const value = extra?.[key];
    return typeof value === `number` ? value : undefined;
};

const firstOf = <T>(events: readonly ActivityEvent[], pick: (event: ActivityEvent) => T | undefined): T | undefined => {
    for (const event of events) {
        const value = pick(event);
        if (value !== undefined) {
            return value;
        }
    }
    return undefined;
};

// Who a row is about: the relayed sender (`origin.author`), the message's own author, or the verified actor (an email
// or `token:<label>`). One answer for both a folded turn and a single event.
const whoAsked = (event: ActivityEvent): string | undefined => event.origin?.author ?? event.author ?? event.actor;

// One turn's events, oldest first, folded into one episode. Label falls back through conversation title, then the
// prompt's first line (the auto-namer may not have run yet), then a bare 'Turn' for a one-shot with no conversation.
const turnEpisode = (turnId: string, events: readonly ActivityEvent[]): Episode => {
    const lifecycle = events.filter(isTurn);
    const outbound = events.filter((event) => event.direction === `out`);
    const started = lifecycle.find((event) => event.type === `turn.started`);
    const completed = lifecycle.find((event) => event.type === `turn.completed`);
    const failure = events.find((event) => event.outcome === `error`);
    const prompt = started?.content;
    const durationMs = numberFrom(completed?.extra, `durationMs`);
    return {
        key: turnId,
        sourceKey: sourceKeyOf(events[0] as ActivityEvent),
        at: (events[0] as ActivityEvent).at,
        kind: `turn`,
        label: firstOf(events, (event) => event.title) ?? (prompt === undefined ? t(`episodes.turn`) : headline(prompt)),
        // `titled` only when the label is a real name; a label clipped from the prompt itself is not a second fact.
        ...(firstOf(events, (event) => event.title) !== undefined ? { titled: true } : {}),
        ...(prompt !== undefined ? { detail: prompt } : {}),
        ...(firstOf(lifecycle, (event) => event.provider) !== undefined ? { runtime: firstOf(lifecycle, (event) => event.provider) } : {}),
        ...(firstOf(events, (event) => event.origin?.channelId) !== undefined
            ? { channelId: firstOf(events, (event) => event.origin?.channelId) }
            : {}),
        ...(firstOf(events, whoAsked) !== undefined ? { author: firstOf(events, whoAsked) } : {}),
        ...(firstOf(events, (event) => event.sessionId) !== undefined ? { sessionId: firstOf(events, (event) => event.sessionId) } : {}),
        ...(firstOf(events, (event) => event.automationIds) !== undefined ? { automationIds: firstOf(events, (event) => event.automationIds) } : {}),
        failed: failure !== undefined,
        ...(failure?.error !== undefined ? { error: failure.error } : {}),
        // Prefers the runtime's own measurement; falls back to the span between marks for an aborted turn.
        ...(durationMs !== undefined
            ? { durationMs }
            : completed !== undefined && started !== undefined
              ? { durationMs: completed.at - started.at }
              : {}),
        ...(numberFrom(completed?.extra, `costUsd`) !== undefined ? { costUsd: numberFrom(completed?.extra, `costUsd`) } : {}),
        outbound: outbound.length,
        // Already oldest-first: `toEpisodes` groups in write order.
        events,
    };
};

// An event with no turn: an inbound message, a gateway failure, an automation run, or a pre-turnId row. Labelled from
// its content when there is any, with the type demoted to a secondary fact.
const looseEpisode = (event: ActivityEvent): Episode => ({
    key: event.id,
    sourceKey: sourceKeyOf(event),
    at: event.at,
    kind: event.direction === `in` ? `message` : `event`,
    label: event.content === undefined ? typeLabel(event.type) : headline(event.content),
    ...(event.content !== undefined ? { typeName: typeLabel(event.type) } : {}),
    ...(event.content !== undefined ? { detail: event.content } : {}),
    // Only shown for a turn event; on a channel event, `provider` just repeats the row's own source.
    ...(isTurn(event) && event.provider !== undefined ? { runtime: event.provider } : {}),
    ...(event.channelId !== undefined ? { channelId: event.channelId } : {}),
    ...(whoAsked(event) !== undefined ? { author: whoAsked(event) } : {}),
    ...(event.sessionId !== undefined ? { sessionId: event.sessionId } : {}),
    ...(event.automationIds !== undefined ? { automationIds: event.automationIds } : {}),
    failed: event.outcome === `error`,
    ...(event.error !== undefined ? { error: event.error } : {}),
    outbound: event.direction === `out` ? 1 : 0,
    events: [event],
});

// Newest first, matching the order the daemon serves and a feed is read in.
export const toEpisodes = (events: readonly ActivityEvent[]): Episode[] => {
    const turns = new Map<string, ActivityEvent[]>();
    const loose: Episode[] = [];
    // Grouped oldest first, so a turn's own array reads forwards and `at` is its start.
    for (const event of [...events].toReversed()) {
        if (event.turnId === undefined) {
            loose.push(looseEpisode(event));
            continue;
        }
        const group = turns.get(event.turnId);
        if (group === undefined) {
            turns.set(event.turnId, [event]);
            continue;
        }
        group.push(event);
    }
    return [...loose, ...[...turns].map(([turnId, group]) => turnEpisode(turnId, group))].toSorted((a, b) => b.at - a.at);
};

// Every source in the log, unioned with every currently-held connection, so a quiet-but-connected bot still appears.
// Sorted by most recent activity, not alphabetically.
export const toSources = (
    episodes: readonly Episode[],
    connections: readonly ActivityStatus["connections"][number][],
    names: ReadonlyMap<string, string> = new Map(),
): Source[] => {
    const tally = new Map<string, { episodes: number; failed: number; lastAt: number }>();
    for (const episode of episodes) {
        const current = tally.get(episode.sourceKey) ?? { episodes: 0, failed: 0, lastAt: 0 };
        tally.set(episode.sourceKey, {
            episodes: current.episodes + 1,
            failed: current.failed + (episode.failed ? 1 : 0),
            lastAt: Math.max(current.lastAt, episode.at),
        });
    }
    // Per provider: worst bot state wins; `pairing` ranks just above disconnected.
    const RANK: Readonly<Record<ActivityStatus["connections"][number]["gateway"], number>> = {
        disconnected: 0,
        pairing: 1,
        connecting: 2,
        idle: 3,
        ready: 4,
    };
    const live = new Map<string, ActivityStatus["connections"][number]>();
    for (const connection of connections) {
        const held = live.get(connection.provider);
        if (held !== undefined && RANK[held.gateway] <= RANK[connection.gateway]) {
            continue;
        }
        live.set(connection.provider, connection);
    }
    const sources: Source[] = [];
    for (const key of new Set([...tally.keys(), ...live.keys()])) {
        const counts = tally.get(key);
        const state = live.get(key);
        sources.push({
            key,
            group: key === DIRECT ? `direct` : `connections`,
            label: sourceLabel(key, names),
            ...(state !== undefined ? { gateway: state.gateway } : {}),
            ...(state?.lastError !== undefined ? { lastError: state.lastError } : {}),
            episodes: counts?.episodes ?? 0,
            failed: counts?.failed ?? 0,
            ...(counts !== undefined ? { lastAt: counts.lastAt } : {}),
        });
    }
    return sources.toSorted((a, b) => (b.lastAt ?? 0) - (a.lastAt ?? 0) || a.label.localeCompare(b.label));
};

// Matches against what the row shows plus the ids it hides, so a pasted session id or channel name still finds it.
export const matches = (episode: Episode, query: string): boolean => {
    const needle = query.trim().toLowerCase();
    if (needle === ``) {
        return true;
    }
    return [
        episode.label,
        episode.detail,
        episode.author,
        episode.channelId,
        episode.sessionId,
        episode.error,
        episode.runtime,
        ...(episode.automationIds ?? []),
    ]
        .join(` `)
        .toLowerCase()
        .includes(needle);
};

// "Today"/"Yesterday" for the two most recent days; a date, not a relative count, for anything older.
const dayLabel = (at: number, now: number): string => {
    const midnight = new Date(now).setHours(0, 0, 0, 0);
    if (at >= midnight) {
        return t(`episodes.today`);
    }
    return at >= midnight - 86_400_000 ? t(`episodes.yesterday`) : formatDayMonth(at);
};

// Episodes grouped into consecutive day runs, order preserved; the timeline renders these as sections.
export const byDay = (episodes: readonly Episode[], now: number): { label: string; episodes: Episode[] }[] => {
    const days: { label: string; episodes: Episode[] }[] = [];
    for (const episode of episodes) {
        const label = dayLabel(episode.at, now);
        const open = days.at(-1);
        if (open?.label === label) {
            open.episodes.push(episode);
            continue;
        }
        days.push({ label, episodes: [episode] });
    }
    return days;
};
