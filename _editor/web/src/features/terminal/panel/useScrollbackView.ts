import type { TerminalScrollback } from "@intentic/sandbox-contract";
import { clipboardOf } from "@intentic/ui";
import { t } from "@intentic/ui/i18n";
import type { MenuItem } from "primevue/menuitem";
import { computed, ref } from "vue";
import { commandShortcut } from "../../../shell/commands/useCommands";
import { copySelection, pasteIntoTerminal, type TerminalSession } from "../terminalSession";

// Right-click inside a terminal: the clipboard verbs, a split, and the pane's history beyond what an attach replays,
// as selectable plain text. tmux never sees the click, since the client is control-mode, and the menu acts on the
// session under the pointer rather than the focused one.

export interface ScrollbackViewHost {
    readonly sessionOf: (name: string) => TerminalSession | undefined;
    readonly read: (name: string) => Promise<TerminalScrollback>;
    readonly splitTab: ((name: string) => void) | undefined;
}

export const useScrollbackView = ({ sessionOf, read, splitTab }: ScrollbackViewHost) => {
    // The session whose history the dialog shows; undefined closes it.
    const scrollbackName = ref<string | undefined>(undefined);
    const scrollback = ref<TerminalScrollback | undefined>(undefined);
    const scrollbackFailed = ref(false);
    // Its own state rather than a spinner over stale text: the previous terminal's history under the next one's name
    // would be the worst lie this dialog could tell.
    const scrollbackPending = computed(() => scrollbackName.value !== undefined && scrollback.value === undefined && !scrollbackFailed.value);
    const scrollbackText = ref<HTMLElement>();
    const gridMenu = ref<{ show: (event: Event) => void } | undefined>();
    const gridTarget = ref<string | undefined>(undefined);
    // Sampled at open, not read live: `disabled` renders once, and xterm clears its selection on losing focus.
    const gridHasSelection = ref(false);

    const openScrollback = async (name: string): Promise<void> => {
        scrollbackName.value = name;
        scrollback.value = undefined;
        scrollbackFailed.value = false;
        try {
            const captured = await read(name);
            // Superseded while in flight: the dialog closed, or another terminal was asked for.
            if (scrollbackName.value === name) {
                scrollback.value = captured;
            }
        } catch {
            // The session ended between the click and the read, or the daemon went away: said, rather than spun forever.
            if (scrollbackName.value === name) {
                scrollbackFailed.value = true;
            }
        }
    };

    const closeScrollback = (): void => {
        scrollbackName.value = undefined;
        scrollback.value = undefined;
        scrollbackFailed.value = false;
    };

    // Through the dialog's own element, so a floating panel writes from the window the reader is actually in.
    const copyScrollback = async (): Promise<void> => {
        const text = scrollback.value?.text;
        if (text !== undefined) {
            await clipboardOf(scrollbackText.value).writeText(text);
        }
    };

    const onGridContextMenu = (event: MouseEvent): void => {
        const cell = event.target instanceof Element ? event.target.closest<HTMLElement>(`.term-cell`) : null;
        const name = cell?.dataset[`session`];
        const session = name === undefined ? undefined : sessionOf(name);
        if (name === undefined || session === undefined) {
            return;
        }
        event.preventDefault();
        gridTarget.value = name;
        gridHasSelection.value = session.term.hasSelection();
        gridMenu.value?.show(event);
    };

    const gridItems = computed<MenuItem[]>(() => {
        const name = gridTarget.value;
        const session = name === undefined ? undefined : sessionOf(name);
        if (name === undefined || session === undefined) {
            return [];
        }
        // No shortcut hints for Copy and Paste: Ctrl+Shift+C/V are the browser's own, and plain Ctrl+V already pastes.
        // Both hand the keyboard back to the terminal so the next keystroke does not land nowhere.
        const items: MenuItem[] = [
            {
                label: t(`ui.action.copy`),
                disabled: !gridHasSelection.value,
                command: () => {
                    copySelection(session);
                    session.term.focus();
                },
            },
            { label: t(`shared.paste`), command: () => pasteIntoTerminal(session) },
            { separator: true },
            { label: t(`terminal.terminalPanel.fullScrollback`), command: () => void openScrollback(name) },
        ];
        if (splitTab === undefined) {
            return items;
        }
        return [
            ...items,
            { separator: true },
            { label: t(`terminal.terminalPanel.splitTerminal`), shortcut: commandShortcut(`terminal.split`), command: () => splitTab(name) },
        ];
    });

    return {
        scrollbackName,
        scrollback,
        scrollbackFailed,
        scrollbackPending,
        scrollbackText,
        closeScrollback,
        copyScrollback,
        gridMenu,
        gridItems,
        onGridContextMenu,
    };
};
