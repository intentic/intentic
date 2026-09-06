/* A SESSION REFERENCE, READ BACK. One agentic session's id is the same string in four costumes, the id
 * itself, the branch it works on, the worktree directory that branch is checked out in, and the address of its
 * page, and which one you are holding depends only on where you copied it from. Git prints the branch, a log
 * prints the worktree path, a colleague pastes a link, the CLI wants the bare id.
 *
 * So the way back into the app accepts all four rather than asking the reader to convert between them, which
 * is a rule nobody should have to remember about a name they did not choose.
 *
 * THE COST OF BEING WRONG IS ASYMMETRIC, and it decides every rule below. Quick Open hands this every
 * keystroke of an ordinary file search: a missed reference costs one paste of the `agent/` prefix, while a
 * false one swaps a page of file results for a jump offer nobody asked for. So a PREFIX is what makes a
 * reference, the costume is the evidence, and a bare string only counts when it could not be anything else.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/* The tail a costume wraps. Ids are OPAQUE: a conversation started in a browser is a randomUUID, but a
 * workflow names its steps' sessions itself (`wf-<run>-<step>`), so nothing here may assume a shape. What it
 * does insist on is that the tail is one path segment, without that, `src/agents/AgentCard.vue` reads as a
 * link to an agent called AgentCard.vue, and the file palette stops finding files. */
const tailOf = (text: string, marker: string): string | undefined => {
    const at = text.lastIndexOf(marker);
    if (at === -1) {
        return undefined;
    }
    const tail = text.slice(at + marker.length);
    return tail === `` || /[/\s]/.test(tail) ? undefined : tail;
};

/**
 * The session id inside a pasted reference, or undefined when the text is not one.
 *
 * `known` is the roster's own answer to "is this an agent I have?", which is what lets a BARE non-uuid id
 * resolve, the identity panel offers the plain id for copying, and it would be a poor joke to hand someone a
 * string the palette then refuses. Absent, only uuid-shaped bare text counts.
 */
export const sessionIdFrom = (text: string, known?: (id: string) => boolean): string | undefined => {
    const trimmed = text.trim().replace(/\/+$/, ``);
    if (trimmed === ``) {
        return undefined;
    }
    // The branch, as git and the chip both spell it.
    if (trimmed.startsWith(`agent/`)) {
        return tailOf(trimmed, `agent/`);
    }
    // A link someone was sent. Only a real URL, so that a source path through a folder called `agents` stays a
    // file search.
    if (trimmed.includes(`://`)) {
        return tailOf(trimmed, `/agents/`);
    }
    // The worktree on disk, as a log or a terminal prints it, absolute, or it is not that path.
    if (trimmed.startsWith(`/`)) {
        return tailOf(trimmed, `/worktrees/`);
    }
    if (UUID.test(trimmed)) {
        return trimmed.toLowerCase();
    }
    return known?.(trimmed) === true ? trimmed : undefined;
};
