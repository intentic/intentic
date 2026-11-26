import { accountKey, storedValue, storeValue } from "@intentic/ui/storage";

/* WHETHER THIS PERSON DICTATES, so a hover over the mic loads the speech model ahead only for someone likely to press it
   (2026-11-26). Every hover and focus used to prepare the model, and on the owner's laptop, its memory nearly gone, the
   sandbox's speech process then held 856 MB for ten minutes after a composer opened only to type in. Now a person whose
   words were written by dictation lately keeps that head start, and everyone else loads the model on the press, with
   the phrases they speak meanwhile waiting for it as they always could (useVoiceInput.ts).

   Kept with the signed-in account, like the editor's other traces of how a person works (commitDraftPaceKey): two people
   sharing a browser do not warm the model for each other, and signing out forgets it. */

/** When this person's dictated words were last written, in epoch milliseconds. */
export const DICTATED_KEY = accountKey(`intentic.voice.dictatedAt`);

/** How lately a person must have dictated for a hover over the mic to load the model ahead of their press. */
export const RECENT_DICTATION_MS = 7 * 24 * 60 * 60_000;

export interface DictationHabit {
    /** This person dictated lately: a hover may load the model ahead of the press it promises. */
    readonly recent: () => boolean;
    /** Words of theirs were just written by dictation. */
    readonly dictated: () => void;
}

/** The seams a habit reads and writes: the browser's storage and clock unless a test hands its own. */
export interface DictationHabitDeps {
    readonly now?: () => number;
    readonly read?: (key: string) => string | undefined;
    readonly write?: (key: string, value: string) => void;
}

export const dictationHabit = ({ now = Date.now, read = storedValue, write = storeValue }: DictationHabitDeps = {}): DictationHabit => ({
    recent: () => {
        const at = Number(read(DICTATED_KEY));
        // A value from a clock that ran ahead counts too: it is still a person who dictates.
        return Number.isFinite(at) && at > 0 && now() - at < RECENT_DICTATION_MS;
    },
    dictated: () => write(DICTATED_KEY, String(now())),
});

/** `write`, noting that this person dictates whenever it is handed words (a phrase heard as silence is none). */
export const notingDictation =
    <Rest extends readonly unknown[]>(habit: DictationHabit, write: (text: string, ...rest: Rest) => void) =>
    (text: string, ...rest: Rest): void => {
        if (text !== ``) {
            habit.dictated();
        }
        write(text, ...rest);
    };
