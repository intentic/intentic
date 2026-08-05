import type { ActivityEvent, ActivityStatus } from "@intentic/sandbox-contract";
import { formatDayMonth } from "@intentic/extension-ui/format";

/* THE AUDIT LOG READ AS THINGS THAT HAPPENED, not as rows that were appended.
 *
 * The daemon's log is deliberately event-per-append: a turn writes `turn.started`, maybe `turn.plan`, maybe
 * `turn.error`, then `turn.completed`, plus one row per outbound provider call it made. That is the right shape
 * to WRITE (each append is one fact, and a crash mid-turn loses nothing) and the wrong shape to READ — five rows
 * saying "a turn ran" is five times the scrolling and none of the answer. Measured on a real log: 1,929 events
 * for 837 turns, every one of them titled "Turn started"/"Turn completed" over a session UUID.
 *
 * So this module collapses events into EPISODES (one turn, one inbound message, one health event) and events
 * into SOURCES (who set it off). Both are pure functions over the fetched page — no request, no clock, no Vue —
 * because the interesting logic here is the grouping and grouping is exactly what is worth testing.
 *
 * WHO SET IT OFF is the axis the whole view hangs on, and it is NOT the event's `provider`. On a turn, `provider`
 * is the runtime that SERVED it (claude/codex/gemini/kimi); the thing that CALLED is `origin.provider`, or
 * nobody, which means the user typed it. Filing turns under their runtime is what made the old view claim to be
 * about Discord while showing 1,600 rows of the user's own work. */

// A rail entry. Bounded by how many things can call the agent — never by how much traffic they send, which is
// the whole reason the rail can stay a list while the timeline cannot.
export interface Source {
    readonly key: string;
    // connections: something outside the browser calls in (and may have live gateway state).
    // direct: the user, typing. Kept apart because it is the one source that is not a connection at all.
    readonly group: "connections" | "direct";
    readonly label: string;
    // Live gateway state, for a source the daemon is actually holding a connection for. Absent on a source known
    // only from the log (a provider that has gone quiet, or one that never had a gateway).
    readonly gateway?: ActivityStatus["connections"][number]["gateway"];
    readonly lastError?: string;
    readonly episodes: number;
    readonly failed: number;
    readonly lastAt?: number;
}

// One thing that happened. `events` keeps the raw rows so the row can expand to exactly what the daemon wrote —
// the audit trail must stay inspectable, or collapsing it is hiding it.
export interface Episode {
    readonly key: string;
    readonly sourceKey: string;
    // When it BEGAN (the oldest event in the group), so the timeline orders by when the work started rather than
    // by when it happened to finish.
    readonly at: number;
    readonly kind: "turn" | "message" | "event";
    readonly label: string;
    // The daemon's own event type, humanised — carried only by a single-event episode, where the label is the
    // event's content and the type is the other half of what happened. A turn's row states its kind by shape.
    readonly typeName?: string;
    readonly detail?: string;
    // The runtime that served a turn — a facet of the row, deliberately not a source of its own.
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
    // Provider calls the turn made — the "and then it replied" half of a wake, folded into the wake's own row.
    readonly outbound: number;
    readonly events: readonly ActivityEvent[];
}

/* Two reserved source keys for the callers that are not providers. Safe against collision because a provider key
 * comes from a capability's `provider` config or a listener trigger, and neither can be spelled these. */
// The user, typing. The one source that is not a connection at all.
export const DIRECT = `you`;
// Provider-less automation wakes (a cron fire, a webhook): something called, but no connection received it.
export const SCHEDULE = `schedule`;

const SOURCE_LABELS: Readonly<Record<string, string>> = {
    discord: `Discord`,
    slack: `Slack`,
    webchat: `Web chat`,
    imap: `Email`,
    [DIRECT]: `You`,
    [SCHEDULE]: `Schedule`,
};

export const sourceLabel = (key: string): string => SOURCE_LABELS[key] ?? key.charAt(0).toUpperCase() + key.slice(1);

const isTurn = (event: ActivityEvent): boolean => event.type.startsWith(`turn.`);

/* Which source an event belongs to. A turn goes to whatever WOKE it and falls back to the user; everything else
 * goes to the provider that carried it. The provider-less remainder is an automation nothing external triggered,
 * which is a schedule or a webhook — filed as such rather than dropped into the user's own work. */
export const sourceKeyOf = (event: ActivityEvent): string => {
    if (isTurn(event)) {
        return event.origin?.provider ?? DIRECT;
    }
    return event.provider ?? SCHEDULE;
};

const TYPE_LABELS: Readonly<Record<string, string>> = {
    "message.received": `Message received`,
    "voice_transcript.received": `Voice transcript`,
    "voice_utterance.received": `Voice utterance`,
    "message.send": `Message sent`,
    "message.edit": `Message edited`,
    "messages.read": `Messages read`,
    "reaction.add": `Reaction added`,
    "reaction.remove": `Reaction removed`,
    "api.call": `API call`,
    "gateway.login_failed": `Gateway login failed`,
    "dispatch.failed": `Dispatch failed`,
    "voice.session_started": `Voice session started`,
    "voice.session_ended": `Voice session ended`,
    "automation.run": `Automation run`,
    "automation.pending": `Automation held for approval`,
    // The dependency verifier's chain (workspace/verify-deps.ts): every step after a land drifts the tree
    // leaves one of these, which is what makes the install→checks→fix chain auditable after the fact.
    "deps.install_failed": `Dependency install failed`,
    "deps.install_lost": `Dependency install unwatched`,
    "deps.verify_green": `Checks green`,
    "deps.verify_red": `Checks failed`,
    "deps.verify_skipped": `No checks to run`,
    "deps.verify_lost": `Checks unwatched`,
    "deps.fix_unarmed": `Fix available, nothing armed`,
    "turn.started": `Turn started`,
    "turn.plan": `Plan proposed`,
    "turn.error": `Turn error`,
    "turn.completed": `Turn completed`,
};

export const typeLabel = (type: string): string => TYPE_LABELS[type] ?? type;

// First line only, and short: a prompt is up to 2,000 characters and a row is one line tall.
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

/* One turn's events → one episode. `events` is that turn's rows, oldest first.
 *
 * The label walks three fallbacks because each one is a real state of a real turn: a titled conversation has a
 * name; a brand-new one does not yet (the auto-namer runs concurrently with the turn, so its first events are
 * written before it has one) and the prompt's first line is the best thing anybody could show; a turn with
 * neither is an internal one-shot with no conversation at all. */
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
        label: firstOf(events, (event) => event.title) ?? (prompt === undefined ? `Turn` : headline(prompt)),
        ...(prompt !== undefined ? { detail: prompt } : {}),
        ...(firstOf(lifecycle, (event) => event.provider) !== undefined ? { runtime: firstOf(lifecycle, (event) => event.provider) } : {}),
        ...(firstOf(events, (event) => event.origin?.channelId) !== undefined
            ? { channelId: firstOf(events, (event) => event.origin?.channelId) }
            : {}),
        ...(firstOf(events, (event) => event.origin?.author) !== undefined ? { author: firstOf(events, (event) => event.origin?.author) } : {}),
        ...(firstOf(events, (event) => event.sessionId) !== undefined ? { sessionId: firstOf(events, (event) => event.sessionId) } : {}),
        ...(firstOf(events, (event) => event.automationIds) !== undefined ? { automationIds: firstOf(events, (event) => event.automationIds) } : {}),
        failed: failure !== undefined,
        ...(failure?.error !== undefined ? { error: failure.error } : {}),
        // Prefer what the runtime measured; fall back to the span between the marks, which is all an aborted
        // turn (no completion frame) ever has.
        ...(durationMs !== undefined
            ? { durationMs }
            : completed !== undefined && started !== undefined
              ? { durationMs: completed.at - started.at }
              : {}),
        ...(numberFrom(completed?.extra, `costUsd`) !== undefined ? { costUsd: numberFrom(completed?.extra, `costUsd`) } : {}),
        outbound: outbound.length,
        // Already oldest-first (toEpisodes groups in write order), which is the order a turn's story reads in.
        events,
    };
};

/* An event that belongs to no turn: an inbound message, a gateway failure, an automation run — and every event
 * already on disk from before turns carried an id.
 *
 * What it says comes from its CONTENT when it has any, with the type demoted to a chip beside it. A row reading
 * "Turn started" over a hidden prompt is the old view's central failure repeated: the type is the least
 * informative thing on the row, and it is the one thing the row was spending its whole width on. */
const looseEpisode = (event: ActivityEvent): Episode => ({
    key: event.id,
    sourceKey: sourceKeyOf(event),
    at: event.at,
    kind: event.direction === `in` ? `message` : `event`,
    label: event.content === undefined ? typeLabel(event.type) : headline(event.content),
    ...(event.content !== undefined ? { typeName: typeLabel(event.type) } : {}),
    ...(event.content !== undefined ? { detail: event.content } : {}),
    // On a turn event `provider` is the runtime that served it, worth showing. On a channel event it is the
    // channel — already the row's source, so repeating it would just be noise.
    ...(isTurn(event) && event.provider !== undefined ? { runtime: event.provider } : {}),
    ...(event.channelId !== undefined ? { channelId: event.channelId } : {}),
    ...(event.author !== undefined ? { author: event.author } : {}),
    ...(event.sessionId !== undefined ? { sessionId: event.sessionId } : {}),
    ...(event.automationIds !== undefined ? { automationIds: event.automationIds } : {}),
    failed: event.outcome === `error`,
    ...(event.error !== undefined ? { error: event.error } : {}),
    outbound: event.direction === `out` ? 1 : 0,
    events: [event],
});

// Newest first, matching the order the daemon serves and the order a feed is read in.
export const toEpisodes = (events: readonly ActivityEvent[]): Episode[] => {
    const turns = new Map<string, ActivityEvent[]>();
    const loose: Episode[] = [];
    // Oldest first while grouping, so each turn's own array is in the order the turn wrote it — which is what
    // lets `at` be the start and the raw list read forwards.
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

/* The rail. Every source the log knows about, UNIONED with every connection the daemon is currently holding —
 * a Discord bot that has been quiet all day still has to appear, because "connected and silent" is an answer to
 * the question the rail is asked, and a source that only exists in the log (a provider since disconnected) still
 * has history worth reaching. Sorted by most recent activity within each group, so the rail reorders itself
 * around whatever is live rather than around an alphabet. */
export const toSources = (episodes: readonly Episode[], connections: readonly ActivityStatus["connections"][number][]): Source[] => {
    const tally = new Map<string, { episodes: number; failed: number; lastAt: number }>();
    for (const episode of episodes) {
        const current = tally.get(episode.sourceKey) ?? { episodes: 0, failed: 0, lastAt: 0 };
        tally.set(episode.sourceKey, {
            episodes: current.episodes + 1,
            failed: current.failed + (episode.failed ? 1 : 0),
            lastAt: Math.max(current.lastAt, episode.at),
        });
    }
    // A provider with several bots reports one connection each; the rail is per PROVIDER, so the worst state wins
    // — a rail row that reads "ready" while one of its two bots is down would be the one lie that matters here.
    const RANK: Readonly<Record<ActivityStatus["connections"][number]["gateway"], number>> = {
        disconnected: 0,
        connecting: 1,
        idle: 2,
        ready: 3,
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
            label: sourceLabel(key),
            ...(state !== undefined ? { gateway: state.gateway } : {}),
            ...(state?.lastError !== undefined ? { lastError: state.lastError } : {}),
            episodes: counts?.episodes ?? 0,
            failed: counts?.failed ?? 0,
            ...(counts !== undefined ? { lastAt: counts.lastAt } : {}),
        });
    }
    return sources.toSorted((a, b) => (b.lastAt ?? 0) - (a.lastAt ?? 0) || a.label.localeCompare(b.label));
};

// Free-text match over what the row actually shows plus the ids it hides — someone pasting a session id from a
// bug report should find the turn, and someone typing a channel name should find the conversation.
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

// Day dividers. "Today"/"Yesterday" beat a date for the two days that carry almost all of the traffic, and a
// date is clearer than "6 days ago" for everything older.
export const dayLabel = (at: number, now: number): string => {
    const midnight = new Date(now).setHours(0, 0, 0, 0);
    if (at >= midnight) {
        return `Today`;
    }
    return at >= midnight - 86_400_000 ? `Yesterday` : formatDayMonth(at);
};

// Episodes grouped into consecutive day runs, order preserved — the timeline renders these as its sections.
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
