import { type IncidentAttempt, transcriptIncidents } from "@intentic/sandbox-contract/events/refusal-incidents";
import type { ChatMessage } from "./transcript";

/* ONE PROBLEM, ONE ROW, as the chat draws it (the contract's refusal-incidents.ts finds the runs). A run is drawn as its
   last row, which is the latest word on it: the move that got the turn through, the re-send in flight, or the refusal
   still standing. The rows before it are not drawn, and every refused attempt sits behind the drawn row's details. A
   person's own switch in the composer (`switched`, written by this window) ends a run as the sandbox's move does. */

/** What the drawn row stands for: each refused attempt, and whether the run ended on what got it through. */
export interface ChatIncident {
    readonly attempts: readonly IncidentAttempt[];
    readonly resolved: boolean;
}

export interface ChatIncidents {
    // The incident each drawn row stands for, by the row's id.
    readonly drawn: ReadonlyMap<number, ChatIncident>;
    // The rows folded into the row drawn after them, by id: not drawn at all.
    readonly folded: ReadonlySet<number>;
}

const NONE: ChatIncidents = { drawn: new Map(), folded: new Set() };

// A switch that ends a run of refusals: this window's own line for a person's pick (`switched`), or the record's own row
// for a turn that went out on another provider, account or loop (the daemon's `switched` notice, which takes the place of
// this window's line once the turn goes). A model swap stays on the same account, so it ends nothing.
const switched = (message: ChatMessage): boolean =>
    message.switched === true || (message.noticeCode?.code === `switched` && message.noticeCode.params?.[`segment`] !== `model`);

const sameAttempts = (left: readonly IncidentAttempt[], right: readonly IncidentAttempt[]): boolean =>
    left.length === right.length && left.every((attempt, index) => attempt.at === right[index]!.at && attempt.said === right[index]!.said);

const sameIncident = (left: ChatIncident | undefined, right: ChatIncident): left is ChatIncident =>
    left !== undefined && left.resolved === right.resolved && sameAttempts(left.attempts, right.attempts);

/**
 * The incidents in `messages`. `previous` is the last answer for the same transcript, asked again on every frame of a
 * streamed turn: an incident that did not change comes back as the same object, and an answer that did not change as the
 * same answer, so the rows keyed on them are not drawn again.
 */
export const incidentsOf = (messages: readonly ChatMessage[], previous: ChatIncidents = NONE): ChatIncidents => {
    const found = transcriptIncidents(messages, switched);
    if (found.length === 0) {
        return previous.drawn.size === 0 ? previous : NONE;
    }
    const drawn = new Map<number, ChatIncident>();
    const folded = new Set<number>();
    for (const { from, to, attempts, resolved } of found) {
        const id = messages[to]!.id;
        const incident = { attempts, resolved };
        const was = previous.drawn.get(id);
        drawn.set(id, sameIncident(was, incident) ? was : incident);
        for (let index = from; index < to; index += 1) {
            folded.add(messages[index]!.id);
        }
    }
    const unchanged =
        drawn.size === previous.drawn.size &&
        folded.size === previous.folded.size &&
        [...drawn].every(([id, incident]) => previous.drawn.get(id) === incident) &&
        [...folded].every((id) => previous.folded.has(id));
    return unchanged ? previous : { drawn, folded };
};
