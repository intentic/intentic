import { computed, nextTick, type Ref, watch } from "vue";
import { withShortcut } from "../../../../shell/commands/useCommands";

// Which pane the keyboard is in, and where the caret goes: working in a pane raises it as the focused one, only the
// focused pane's close button teaches the shortcut, and the caret lands in the composer when the shell asks for it (a
// New agent) or the chat connects, never on a phone (its keyboard would pop unasked) nor in a pane not focused.

export interface PaneFocusHost {
    readonly focused: () => boolean;
    // Raises this pane as the focused one; the panel decides what that means.
    readonly raise: () => void;
    // The shell-wide ask for the caret, a counter since asking twice is still two asks (useChat-tabs.composerFocus).
    readonly composerFocus: Readonly<Ref<number>>;
    readonly connected: Readonly<Ref<boolean>>;
    readonly mobile: Readonly<Ref<boolean>>;
    readonly input: Readonly<Ref<HTMLTextAreaElement | null>>;
    // Sizes the box to what it holds before the caret lands in it.
    readonly grow: () => void;
}

// Ends the column, not the conversation: the chat stays in the rail.
const CLOSE_PANE = `Close this pane: the chat stays open`;

export const usePaneFocus = (pane: PaneFocusHost) => {
    // The ask names no conversation, and the tab it opened took the focus, so only the focused pane answers it.
    watch(pane.composerFocus, () => {
        if (!pane.focused()) {
            return;
        }
        void nextTick(() => {
            pane.grow();
            const field = pane.input.value;
            field?.focus();
            // A composer that arrives already filled keeps the caret where the sentence stops, not in front of it.
            field?.setSelectionRange(field.value.length, field.value.length);
        });
    });
    watch(
        pane.connected,
        (connected) => {
            if (!connected) {
                return;
            }
            void nextTick(() => {
                pane.grow();
                if (!pane.mobile.value && pane.focused()) {
                    pane.input.value?.focus();
                }
            });
        },
        { immediate: true },
    );
    return {
        // A click in the focused pane never re-seats it: only a pane not holding the focus raises itself.
        takeFocus: (): void => {
            if (!pane.focused()) {
                pane.raise();
            }
        },
        // Only the focused pane's button teaches `chat.closePane`, since the shortcut acts on the focused pane.
        closeHint: computed(() => (pane.focused() ? withShortcut(CLOSE_PANE, `chat.closePane`) : CLOSE_PANE)),
    };
};
