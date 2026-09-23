import { t } from "@intentic/ui/i18n";
import { computed, onScopeDispose, ref, watch } from "vue";

// The touch extra-keys row: a soft keyboard has no Esc, Tab, Ctrl or arrows, so a scrollable row injects them straight
// into the active session. Ctrl arms, and the next printable key sends its control code: the only reliable way to reach
// Ctrl+C, D or Z without a physical modifier. A fine pointer never draws the row.

// A printable character's control code (c to \x03, d to \x04, …); anything outside the letters passes through.
export const controlCode = (ch: string): string => {
    const code = ch.toUpperCase().charCodeAt(0);
    return code >= 64 && code <= 95 ? String.fromCharCode(code - 64) : ch;
};

export const useTouchKeys = (sendInput: (data: string) => void) => {
    const ctrlArmed = ref(false);
    const onArmedKeydown = (event: KeyboardEvent): void => {
        if (event.key.length !== 1) {
            return;
        }
        event.preventDefault();
        event.stopPropagation();
        sendInput(controlCode(event.key));
        ctrlArmed.value = false;
    };
    watch(ctrlArmed, (armed) => {
        if (armed) {
            window.addEventListener(`keydown`, onArmedKeydown, true);
        } else {
            window.removeEventListener(`keydown`, onArmedKeydown, true);
        }
    });
    onScopeDispose(() => window.removeEventListener(`keydown`, onArmedKeydown, true));

    const EXTRA_KEYS = computed((): readonly { label: string; data: string }[] => [
        { label: t(`terminal.terminalPanel.esc`), data: `\x1b` },
        { label: t(`terminal.terminalPanel.tab`), data: `\t` },
        { label: `/`, data: `/` },
        { label: `-`, data: `-` },
        { label: `|`, data: `|` },
        { label: `~`, data: `~` },
        { label: `↑`, data: `\x1b[A` },
        { label: `↓`, data: `\x1b[B` },
        { label: `←`, data: `\x1b[D` },
        { label: `→`, data: `\x1b[C` },
    ]);

    return { ctrlArmed, EXTRA_KEYS };
};
