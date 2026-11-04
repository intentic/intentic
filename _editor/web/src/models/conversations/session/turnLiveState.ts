import type { TurnFact } from "@intentic/sandbox-contract/events/agent-events";

// What a live turn shows beside its rows and drops when it settles: its runtime's own status lines, the pages it is
// still writing and the files it is still writing (TurnClient.agentStatus, .pageDrafts, .fileDrafts), each moved by one
// fact at a time.

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

/** A file the agent is still writing into a call's arguments, as far as its text has streamed (file_draft facts). */
export interface FileDraftView {
    readonly callId: string;
    /** Workspace-relative, as the call's card names it. */
    readonly path: string;
    /** `write`: `text` is the whole new content. `edit`: `text` replaces `old`. */
    readonly op: `write` | `edit`;
    readonly text: string;
    /** The text an edit replaces, once whole; undefined for a write, and for an edit whose old text was too long to send. */
    readonly old?: string;
    readonly replaceAll?: boolean;
    /** The draft outgrew what is streamed: its text stops here, and the file on disk is the answer. */
    readonly truncated?: boolean;
}

// A FileDraftView while one fact is folded into it, its optional fields set one statement each.
interface DraftBeingFolded {
    callId: string;
    path: string;
    op: FileDraftView[`op`];
    text: string;
    old?: string;
    replaceAll?: boolean;
    truncated?: boolean;
}

/**
 * The drafts after one file_draft fact, under withPageDraft's rules: a stretch starting where the held text ends
 * extends it, one starting earlier (an attach replaying the turn's facts) rewrites from there, one past the end waits.
 * `done` lets it go: the call settled, and the file on disk takes over.
 */
export const withFileDraft = (
    drafts: ReadonlyMap<string, FileDraftView>,
    fact: Extract<TurnFact, { kind: `file_draft` }>,
): ReadonlyMap<string, FileDraftView> => {
    const next = new Map(drafts);
    if (fact.done === true) {
        next.delete(fact.callId);
        return next;
    }
    const held = next.get(fact.callId);
    const text = held === undefined ? (fact.at === 0 ? fact.text : ``) : fact.at <= held.text.length ? held.text.slice(0, fact.at) + fact.text : held.text;
    const draft: DraftBeingFolded = { callId: fact.callId, path: fact.path, op: fact.op, text };
    const old = fact.old ?? held?.old;
    if (old !== undefined) {
        draft.old = old;
    }
    if (fact.replaceAll === true || held?.replaceAll === true) {
        draft.replaceAll = true;
    }
    if (fact.truncated === true || held?.truncated === true) {
        draft.truncated = true;
    }
    next.set(fact.callId, draft);
    return next;
};
