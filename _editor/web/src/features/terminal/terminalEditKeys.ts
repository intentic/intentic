import { definePreference } from "@intentic/ui/preference";
import type { Ref } from "vue";

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

// Whether Option is the shell's Meta on a Mac (⌥B and ⌥F a word back and forward, ⌥. the last argument) rather than the
// key that types ∫, ƒ and ≥: Terminal.app's and iTerm's own switch, off by default as theirs is. Ignored elsewhere, where
// Alt already is Meta.
export const optionIsMeta: Ref<boolean> = definePreference<boolean>({
    key: `ui-terminal-option-meta`,
    read: (raw) => raw === `on`,
    write: (value) => (value ? `on` : null),
});
