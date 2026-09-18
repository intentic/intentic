// Line edits the pane would otherwise swallow, retyped as bytes every line editor binds. xterm encodes
// Ctrl+Backspace as ^H, which zle and readline both read as backward-delete-char — one character, not a word; it
// emits nothing at all for Cmd+arrows; and it names Home/End the xterm way, while the pane's TERM (tmux-256color)
// names them \x1b[1~ and \x1b[4~, so neither form is bound in the shell.

const EDIT_KEYS: Readonly<Record<string, string>> = {
    // backward-kill-word in zle and readline; werase to a tty still in canonical mode.
    "ctrl+Backspace": `\x17`,
    // Apple's Cmd+Delete. ^U is kill-to-line-start in readline and kill-whole-line in zle, so a mid-line cursor
    // loses the tail too in zsh.
    "meta+Backspace": `\x15`,
    "meta+ArrowLeft": `\x01`,
    "meta+ArrowRight": `\x05`,
    // khome/kend as tmux-256color's terminfo names them, so vim and less match the shell.
    Home: `\x1b[1~`,
    End: `\x1b[4~`,
};

// Bytes this keydown types instead of xterm's own encoding, or undefined to leave the key to xterm. Shift or a
// second modifier never matches, so a selection or scrollback chord keeps its meaning; Cmd counts only on Apple,
// where the same physical key elsewhere belongs to the window manager.
export const editKeyBytes = (event: KeyboardEvent, isMac: boolean): string | undefined => {
    if (event.shiftKey || event.altKey || (event.metaKey && !isMac) || (event.ctrlKey && event.metaKey)) {
        return undefined;
    }
    const prefix = event.ctrlKey ? `ctrl+` : event.metaKey ? `meta+` : ``;
    return EDIT_KEYS[`${prefix}${event.key}`];
};
