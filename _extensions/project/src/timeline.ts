import type { AgentSummary, Snapshot } from "@intentic/sandbox-contract";

// The project's "What's new": the daemon's own timeline of the tree (every visible restore point) as the spine, with
// the sentence an assistant's landing was given folded onto the point that landing made. Pure: reads two lists and
// returns rows; nothing here asks the daemon.

export type TimelineKind = "assistant" | "you" | "restored" | "before-restore";

export interface TimelineRow {
    // The restore point's id, which is what going back and reading the diff take.
    readonly id: string;
    readonly at: number;
    readonly kind: TimelineKind;
    // One line, in the maker's words: what was asked, or what the assistant did, or "Your edits".
    readonly title: string;
    // The drafted subject of the landing this point holds, when an agent's record supplies one.
    readonly subject?: string;
    readonly agentId?: string;
}

// How far apart a landing's record and the checkpoint it made may sit and still be the same event; a land cuts its
// checkpoint at once, so this is generous.
const SAME_EVENT_MS = 3 * 60_000;

const KIND_OF: Record<Snapshot["trigger"], TimelineKind> = {
    turn: `assistant`,
    user: `you`,
    restore: `restored`,
    "pre-restore": `before-restore`,
    interval: `you`,
};

const TITLE_OF: Record<TimelineKind, string> = {
    assistant: `The assistant made changes`,
    you: `Your edits`,
    restored: `Went back to an earlier version`,
    "before-restore": `Before going back`,
};

// A prompt as a row title: its first line, cut so a paragraph pasted into the composer does not become the row.
const MAX_TITLE = 120;
export const firstLine = (text: string): string => {
    const line = text.split(`\n`).find((candidate) => candidate.trim() !== ``)?.trim() ?? ``;
    return line.length > MAX_TITLE ? `${line.slice(0, MAX_TITLE - 1).trimEnd()}…` : line;
};

// Agents whose landing has a drafted sentence, newest first; each is spent on at most one checkpoint.
const landings = (agents: readonly AgentSummary[]): { at: number; subject: string; id: string }[] =>
    agents
        .filter((agent) => agent.landedMessage !== undefined)
        .map((agent) => ({ at: agent.updatedAt, subject: agent.landedMessage!.subject, id: agent.id }))
        .toSorted((left, right) => right.at - left.at);

// Each landing goes to the turn checkpoint nearest it in time, within the window, and to only one; a checkpoint takes
// at most one landing. Nearest rather than first seen, since two turns minutes apart both sit within the window of
// the landing between them.
const assign = (snapshots: readonly Snapshot[], agents: readonly AgentSummary[]): Map<string, { subject: string; id: string }> => {
    const turns = snapshots.filter((snapshot) => snapshot.trigger === `turn`);
    const taken = new Set<string>();
    const assigned = new Map<string, { subject: string; id: string }>();
    for (const landing of landings(agents)) {
        let best: Snapshot | undefined;
        for (const turn of turns) {
            const gap = Math.abs(turn.at - landing.at);
            if (gap <= SAME_EVENT_MS && !taken.has(turn.id) && (best === undefined || gap < Math.abs(best.at - landing.at))) {
                best = turn;
            }
        }
        if (best !== undefined) {
            taken.add(best.id);
            assigned.set(best.id, { subject: landing.subject, id: landing.id });
        }
    }
    return assigned;
};

export const timelineRows = (snapshots: readonly Snapshot[], agents: readonly AgentSummary[]): TimelineRow[] => {
    const assigned = assign(snapshots, agents);
    return snapshots
        .filter((snapshot) => snapshot.trigger !== `interval`)
        .map((snapshot): TimelineRow => {
            const kind = KIND_OF[snapshot.trigger];
            const title = snapshot.label === undefined || snapshot.label.trim() === `` ? TITLE_OF[kind] : firstLine(snapshot.label);
            const landing = assigned.get(snapshot.id);
            return landing === undefined
                ? { id: snapshot.id, at: snapshot.at, kind, title }
                : { id: snapshot.id, at: snapshot.at, kind, title, subject: landing.subject, agentId: landing.id };
        });
};

// Day headings for a list newest first: "Today", "Yesterday", else the date; `now` is a parameter so a test can pin it.
export const dayOf = (at: number, now: number, locale?: string): string => {
    const day = (ms: number): string => new Date(ms).toDateString();
    if (day(at) === day(now)) {
        return `Today`;
    }
    if (day(at) === day(now - 86_400_000)) {
        return `Yesterday`;
    }
    return new Intl.DateTimeFormat(locale, { day: `numeric`, month: `long`, ...(new Date(at).getFullYear() === new Date(now).getFullYear() ? {} : { year: `numeric` }) }).format(
        new Date(at),
    );
};

export interface TimelineDay {
    readonly day: string;
    readonly rows: readonly TimelineRow[];
}

export const byDay = (rows: readonly TimelineRow[], now: number, locale?: string): TimelineDay[] => {
    const days: TimelineDay[] = [];
    for (const row of rows) {
        const day = dayOf(row.at, now, locale);
        const last = days.at(-1);
        if (last !== undefined && last.day === day) {
            days[days.length - 1] = { day, rows: [...last.rows, row] };
        } else {
            days.push({ day, rows: [row] });
        }
    }
    return days;
};
