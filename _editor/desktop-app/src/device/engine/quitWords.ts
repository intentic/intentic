import { invoke } from "@tauri-apps/api/core";
import { activeLocale, t } from "@intentic/ui/i18n";
import { watch } from "vue";

// THE QUIT QUESTION ABOUT A MOVE, IN THE READER'S LANGUAGE (issue #48, 2026-11-20). A quit that would stop a setup's move
// between engines asks first in a native dialog (windows/quit.rs), and the app's side has no translations: every window
// hands it the words as it starts and again when the language changes, as drives.ts does for a drive's notification.

/** The question, as windows/quit.rs `MoveWords` takes it. */
export interface QuitMoveWords {
    readonly title: string;
    readonly message: string;
    readonly wait: string;
    readonly quit: string;
    readonly cancel: string;
}

/** Hand the app the words; it refuses ones a dialog cannot carry, or three answers it could not tell apart. */
const quitMoveWords = (words: QuitMoveWords): Promise<void> => invoke(`quit_move_words`, { words });

/** The question's words, in the reader's language now. */
const moveQuitWords = (): QuitMoveWords => ({
    title: t(`desktop.quitMove.title`),
    message: t(`desktop.quitMove.message`),
    wait: t(`desktop.quitMove.wait`),
    quit: t(`desktop.quitMove.quit`),
    cancel: t(`ui.action.cancel`),
});

const handOver = async (): Promise<void> => {
    try {
        await quitMoveWords(moveQuitWords());
    } catch (error) {
        console.error(`[device] the quit question's words could not be handed over:`, error);
    }
};

let started: Promise<void> | undefined;

/** Hand the app the words now and after every language change: once per window. */
export const startQuitWords = (): Promise<void> =>
    (started ??= (() => {
        watch(activeLocale, () => void handOver());
        return handOver();
    })());
