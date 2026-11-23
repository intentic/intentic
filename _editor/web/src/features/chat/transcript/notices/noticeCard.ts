import type { IconName } from "@intentic/ui";
import { formatClock } from "@intentic/ui/format";
import type { ChatIncident } from "../../../../models/conversations/transcript/chatIncidents";
import type { ChatMessage } from "../../../../models/conversations/transcript/transcript";
import { noticeIconOf } from "./noticeLook";

/* WHAT A NOTICE ROW KEEPS BEHIND ITS ONE LINE, laid out for the card a hover or a press raises (NoticeCard.vue): the
   wakes an incident turned away, one entry per sender however often it was re-sent, and its refused attempts as times.
   A notice row is one line, always (2026-11-23: seven subagents reporting into one wall drew seventy lines); whatever
   else it has to say is here, a hover away. */

/** How a wake ended, as its entry's word says it. */
export type WakeState = `failed` | `finished` | `message` | `fired` | `gaveUp` | `given` | `declined`;

/** One sender among the wakes an incident turned away. */
export interface WakeEntry {
    readonly key: string;
    readonly icon: IconName;
    readonly label: string;
    readonly state: WakeState;
    // How many times its words reached the wall: a wake is said again with every re-send of the turn it opened.
    readonly count: number;
    // The conversation that sent it, which its entry opens: another agent's only.
    readonly agentId?: string;
}

const stateOf = (wake: ChatMessage): WakeState => {
    if (wake.agentWords !== undefined) {
        if (wake.agentWords.kind === `peer`) {
            return `message`;
        }
        return wake.agentWords.failed === true ? `failed` : `finished`;
    }
    if (wake.watchWake !== undefined) {
        return wake.watchWake.outcome === `met` ? `fired` : `gaveUp`;
    }
    return wake.needWake?.outcome === `met` ? `given` : `declined`;
};

type WakeSender = Pick<WakeEntry, `key` | `label` | `agentId`>;

// Who sent it, and by what it is known: one key per sender, so a report re-sent with the turn counts once.
const senderOf = (wake: ChatMessage): WakeSender => {
    if (wake.agentWords !== undefined) {
        return { key: `agent:${wake.agentWords.from}`, label: wake.agentWords.title ?? wake.agentWords.from, agentId: wake.agentWords.from };
    }
    if (wake.watchWake !== undefined) {
        return { key: `watch:${wake.watchWake.note}`, label: wake.watchWake.note };
    }
    return { key: `need:${wake.needWake?.id ?? wake.id}`, label: wake.needWake?.title ?? wake.text };
};

/** The wakes, one entry per sender in the order they first arrived, each with its latest word on how it ended. */
export const wakeEntries = (wakes: readonly ChatMessage[]): WakeEntry[] => {
    const entries = new Map<string, WakeEntry>();
    for (const wake of wakes) {
        const sender = senderOf(wake);
        const was = entries.get(sender.key);
        entries.set(sender.key, { ...sender, icon: noticeIconOf(wake, false), state: stateOf(wake), count: (was?.count ?? 0) + 1 });
    }
    return [...entries.values()];
};

// Where a label's own name starts after a lead several share: a colon, a dash or a slash and the space after it.
const LEAD_END = /(?::|\s[—–-]|\s\/)\s/g;

/** The lead every entry's label shares ("Optimizations slice: "), said once over the list rather than on every row,
 *  or `` where they share none or there is only one. */
export const sharedLead = (entries: readonly WakeEntry[]): string => {
    const first = entries[0]?.label;
    if (first === undefined || entries.length < 2) {
        return ``;
    }
    let lead = ``;
    for (const match of first.matchAll(LEAD_END)) {
        const candidate = first.slice(0, match.index + match[0].length);
        if (entries.every((entry) => entry.label.startsWith(candidate) && entry.label.length > candidate.length)) {
            lead = candidate;
        }
    }
    return lead;
};

/** The glyph a run of wakes is counted under on the row: theirs where they are all one kind, else another agent's. */
export const wakesIcon = (entries: readonly WakeEntry[]): IconName => {
    const first = entries[0]?.icon ?? `users`;
    return entries.every((entry) => entry.icon === first) ? first : `users`;
};

// Past this many, the attempts' times are said as the first and the last.
const TIMES_SHOWN = 4;

/** When each attempt was refused, as clocks: every one while they are few, the first and the last past that. */
export const attemptTimes = (incident: ChatIncident): string[] => {
    const times = incident.attempts.flatMap((attempt) => (attempt.at === undefined ? [] : [formatClock(attempt.at)]));
    return times.length <= TIMES_SHOWN ? times : [times[0]!, `…`, times.at(-1)!];
};

/** The words attempts were refused in that the card does not already quote: a refusal reworded mid-run, said once each. */
export const otherWords = (incident: ChatIncident, quoted: string | undefined): string[] => [
    ...new Set(incident.attempts.map((attempt) => attempt.said.trim()).filter((said) => said !== `` && said !== quoted?.trim())),
];

/** Everything the card says, as text for a bug report or a support ticket: every attempt with its moment, every wake. */
export const cardCopy = (parts: {
    readonly line: string;
    readonly said?: string | undefined;
    readonly incident?: ChatIncident | undefined;
    readonly sent?: string | undefined;
}): string => {
    const { line, said, incident, sent } = parts;
    const attempts = (incident?.attempts ?? []).map((attempt) => (attempt.at === undefined ? attempt.said : `${formatClock(attempt.at)} ${attempt.said}`));
    const wakes = wakeEntries(incident?.wakes ?? []).map((entry) => `${entry.label} (${entry.state}${entry.count > 1 ? ` ×${entry.count}` : ``})`);
    return [line, said, ...attempts, ...wakes, sent].filter((part): part is string => part !== undefined && part !== ``).join(`\n`);
};
