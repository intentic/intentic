import type { FleetAgent } from "../fleet/useAgents-fleet";

// The filter's id tier: a query that is one token is read as a handle as well as words, since that is the shape of every
// id (`crisp-basin-z86j`), branch (`agent/crisp-basin-z86j`), session id (a UUID) and link
// (`…/agents/crisp-basin-z86j?sandbox=…`) there is to paste. Named whole, any of them finds its card. A PIECE of an id
// finds it only when the piece has a `-` or `_` in it: ids are built from common words (`sage`, `ridge`), and a search
// for one of them in a transcript must not pull in every card whose id happens to hold it. Case never counts here,
// whatever `Aa` says, because an id is the same id however it was pasted.

// A query read as a handle: all of it, and its last path segment, which is the id in a branch, a path or a link.
export interface Handle {
    readonly whole: string;
    readonly tail: string;
}

// What a handle found on one agent, as the card draws it.
export interface IdMatch {
    // The identifier it matched, as the card spells it.
    readonly text: string;
    // The part of `text` to mark, lowercased as markSegments folds it.
    readonly mark: string;
    // The query named this agent whole, not a piece of its id.
    readonly exact: boolean;
}

// Shorter pieces of an id match too much to mean anything (`-b` is in most of them).
const MIN_PIECE = 3;
// What joins the words of an id, and so marks a piece of one (CONVERSATION_ID allows both).
const JOINER = /[-_]/u;

// Undefined when the query reads only as words: it is empty or has a space in it.
export const handleOf = (query: string): Handle | undefined => {
    const whole = query.trim().toLowerCase();
    if (whole === `` || /\s/u.test(whole)) {
        return undefined;
    }
    const path = whole.split(/[?#]/u)[0] ?? ``;
    const tail = path.replace(/\/+$/u, ``).split(`/`).pop() ?? ``;
    return { whole, tail };
};

const whole = (text: string): IdMatch => ({ text, mark: text.toLowerCase(), exact: true });

// Its id (in any of the spellings above), its branch or its session id named whole, else a joined piece of its id.
export const idMatchOf = (agent: Pick<FleetAgent, `id` | `branch` | `sessionId`>, handle: Handle): IdMatch | undefined => {
    const id = agent.id.toLowerCase();
    if (handle.tail === id) {
        return whole(agent.id);
    }
    if (agent.branch !== undefined && handle.whole === agent.branch.toLowerCase()) {
        return whole(agent.branch);
    }
    if (agent.sessionId !== undefined && handle.whole === agent.sessionId.toLowerCase()) {
        return whole(agent.sessionId);
    }
    if (handle.tail.length >= MIN_PIECE && JOINER.test(handle.tail) && id.includes(handle.tail)) {
        return { text: agent.id, mark: handle.tail, exact: false };
    }
    return undefined;
};
