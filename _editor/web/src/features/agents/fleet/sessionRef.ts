// A session reference read back: one session's id appears in four costumes (id, branch, worktree path, page link)
// depending on where it was copied from, so the way back into the app accepts all four. A prefix is what makes a
// reference, since a missed one costs a paste while a false one swaps real results for an unwanted jump.

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// The tail a costume wraps. Ids are opaque, so nothing here may assume a shape; it must be one path segment, or a
// source path could read as an agent link.
const tailOf = (text: string, marker: string): string | undefined => {
    const at = text.lastIndexOf(marker);
    if (at === -1) {
        return undefined;
    }
    const tail = text.slice(at + marker.length);
    return tail === `` || /[/\s]/.test(tail) ? undefined : tail;
};

/**
 * The session id inside a pasted reference, or undefined when the text is not one. `known` lets a bare non-uuid id
 * resolve; without it, only uuid-shaped bare text counts.
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
    // A link someone was sent: only a real URL, so a source path through a folder called `agents` stays a file search.
    if (trimmed.includes(`://`)) {
        return tailOf(trimmed, `/agents/`);
    }
    // The worktree on disk, as a log or terminal prints it: absolute, or it isn't that path.
    if (trimmed.startsWith(`/`)) {
        return tailOf(trimmed, `/worktrees/`);
    }
    if (UUID.test(trimmed)) {
        return trimmed.toLowerCase();
    }
    return known?.(trimmed) === true ? trimmed : undefined;
};
