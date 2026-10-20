import type { TurnFact } from "@intentic/sandbox-contract/events/agent-events";

// What a live turn shows beside its rows and drops when it settles: its runtime's own status lines and the pages it is
// still writing (TurnClient.agentStatus, .pageDrafts), each moved by one fact at a time.

/** One status entry a runtime's extension set: its words, and who set them when the runtime said. */
export interface AgentStatusEntry {
    readonly text: string;
    readonly source?: string;
}

/** The entries after one agent_status fact: replaced or added by key, removed when it clears. */
export const withAgentStatus = (
    entries: ReadonlyMap<string, AgentStatusEntry>,
    fact: Extract<TurnFact, { kind: `agent_status` }>,
): ReadonlyMap<string, AgentStatusEntry> => {
    const next = new Map(entries);
    if (fact.text === null || fact.text.trim() === ``) {
        next.delete(fact.key);
    } else {
        next.set(fact.key, fact.source === undefined ? { text: fact.text } : { text: fact.text, source: fact.source });
    }
    return next;
};

/** A page the agent is still writing, as far as its markup has streamed (page_draft facts); live state only. */
export interface PageDraftView {
    readonly html: string;
    readonly title?: string;
}

/**
 * The drafts after one page_draft fact. A stretch starting where the held markup ends extends it; one starting earlier
 * (an attach replaying the turn's facts) rewrites from there; one starting past the end means a stretch was missed, and
 * the draft waits as it is rather than drawing a gap. `done` lets it go: the page itself has taken over.
 */
export const withPageDraft = (
    drafts: ReadonlyMap<string, PageDraftView>,
    fact: Extract<TurnFact, { kind: `page_draft` }>,
): ReadonlyMap<string, PageDraftView> => {
    const next = new Map(drafts);
    if (fact.done === true) {
        next.delete(fact.callId);
        return next;
    }
    const held = next.get(fact.callId) ?? { html: `` };
    const html = fact.at <= held.html.length ? held.html.slice(0, fact.at) + fact.text : held.html;
    const title = fact.title ?? held.title;
    next.set(fact.callId, title === undefined ? { html } : { html, title });
    return next;
};
