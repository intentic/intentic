// Which tab strip (workspace, chat, terminal) a keyboard shortcut acts on. Each surface registers its command with
// `when: "tabSurface == '<surface>'"`, a per-event context key published by contextKeys.ts; the workspace is the
// fallback, not a peer, for chrome or <body> focus.

export type TabSurface = `chat` | `side` | `terminal` | `workspace`;

// Terminal panels use `.term`, chat panels use `.chat-panel`, the side panel's tabs `.side-tabs`. Terminal is tested
// first so a prompt nested inside another surface still resolves to terminal, and the chat before the side panel, since
// the chat lives in it.
export const tabSurfaceOf = (event: KeyboardEvent): TabSurface => {
    const { target } = event;
    if (!(target instanceof Element)) {
        return `workspace`;
    }
    if (target.closest(`.term`) !== null) {
        return `terminal`;
    }
    if (target.closest(`.chat-panel`) !== null) {
        return `chat`;
    }
    return target.closest(`.side-tabs`) === null ? `workspace` : `side`;
};
