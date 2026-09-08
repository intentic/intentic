// Which tab strip (workspace, chat, terminal) a keyboard shortcut acts on. Each surface registers its command with
// `when: "tabSurface == '<surface>'"`, a per-event context key published by contextKeys.ts; the workspace is the
// fallback, not a peer, for chrome or <body> focus.

export type TabSurface = `chat` | `terminal` | `workspace`;

// Terminal panels use `.term`, chat panels use `.chat-panel`. Terminal is tested first so a prompt nested inside
// another surface still resolves to terminal.
export const tabSurfaceOf = (event: KeyboardEvent): TabSurface => {
    const { target } = event;
    if (!(target instanceof Element)) {
        return `workspace`;
    }
    if (target.closest(`.term`) !== null) {
        return `terminal`;
    }
    return target.closest(`.chat-panel`) === null ? `workspace` : `chat`;
};
