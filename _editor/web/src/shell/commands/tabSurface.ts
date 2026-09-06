/* Which tab strip a keyboard shortcut acts on. The desktop shell carries three at once, the workspace's editor
 * tabs, the chat's conversations, the terminal panel's sessions, and they share ONE family of chords
 * (Ctrl+Shift+X / , / . / Backspace to close, Alt+PageUp/PageDown to cycle) rather than spending three chords on
 * every verb: a developer holds "close this tab", not "close this FILE tab". The gate below is what makes one
 * chord unambiguous, each surface registers its own command with `when: "tabSurface == '<its surface>'"`, and
 * boundCommand runs the registration whose surface owns the focus. It's the convention F2/rename already
 * followed, and the reason the keybindings settings UI leaves `when`-gated commands out of its conflict warning.
 * `tabSurface` reaches a condition as a per-event context key, published by contextKeys.ts at dispatch.
 *
 * The workspace is the FALLBACK, not a peer: a keystroke from the shell's chrome, or with focus parked on
 * <body>, acts on the editor tabs, where the family acted before the chat and terminal joined it. That keeps
 * the rule sayable in one line ("closes act on the workspace unless you're typing in the chat or a terminal")
 * with no last-focused state to guess at.
 *
 * A panel floating in a window of its own needs nothing special here: it runs its own copy of the app
 * (composables/floating.ts), so its keystrokes dispatch against its own document and resolve against the same
 * roots. */

export type TabSurface = `chat` | `terminal` | `workspace`;

// The panels' own root classes. ChatPanel's `.chat-panel`, TerminalPanel's `.term`. The terminal is tested
// first: it is a sibling of the other two in today's shell, but a prompt hosted inside another surface would
// still want its own keys.
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
