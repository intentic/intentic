import { computed, type ComputedRef, ref, watch } from "vue";

// Save-timing state machine, no DOM: ships on `@intentic/ui/markdown-document` so tests reach it without a component.
// Reading a document must never write it; `stored` is the caller's copy of what disk says, so writing only happens when
// the text actually differs from it.

/**
 * `auto` writes on a debounce and on the way out: right for a document that IS the file.
 * `explicit` waits to be told: right for a document read at the start of every turn.
 * `none` never writes on its own: the document is one field of a form, and the form's submit is the save.
 */
export type SavePolicy = "auto" | "explicit" | "none";

export interface SaveDraftInput {
    policy: () => SavePolicy;
    /** The document as it stands right now. */
    text: () => string;
    /** The document as it stands on disk, or undefined when the caller does not track it. */
    stored: () => string | undefined;
    /** Is a write in flight. */
    saving: () => boolean;
    /** Write this text. */
    write: (text: string) => void;
}

export interface SaveDraft {
    /** Does what is on screen differ from disk. False whenever the caller has not said what disk holds. */
    dirty: ComputedRef<boolean>;
    /** The one status vocabulary: `Unsaved` · `Not saved yet` · `Saving…` · `Saved` · nothing. */
    status: ComputedRef<string>;
    /** The document changed. Schedules a write under `auto`, and nothing under the other two. */
    touched: () => void;
    /** Write it now, unless we know nothing changed. */
    commit: () => void;
    /** The surface is going away: the last sentence is written, under `auto` only. */
    leave: () => void;
}

// Long enough that a sentence is one write, not fifteen; short enough to never race the timer on the way out.
export const SAVE_AFTER_MS = 700;

export const useSaveDraft = (input: SaveDraftInput): SaveDraft => {
    const dirty = computed(() => {
        const disk = input.stored();
        return disk !== undefined && input.text() !== disk;
    });

    let timer: ReturnType<typeof setTimeout> | undefined;

    // Writes unless we know nothing changed. Without `stored`, the caller hasn't said what disk holds, so the request
    // always goes through — which is what makes `none` work: the caller decides.
    const commit = (): void => {
        clearTimeout(timer);
        timer = undefined;
        const disk = input.stored();
        if (disk === undefined || input.text() !== disk) {
            input.write(input.text());
        }
    };

    const touched = (): void => {
        clearTimeout(timer);
        timer = undefined;
        if (input.policy() === `auto` && input.text() !== input.stored()) {
            timer = setTimeout(commit, SAVE_AFTER_MS);
        }
    };

    // Every way out (unmount, route change) reaches here. Flushes only under `auto`; under `explicit` the reader chose
    // not to save, and writing it anyway would be the surprise that policy avoids.
    const leave = (): void => {
        clearTimeout(timer);
        timer = undefined;
        if (input.policy() === `auto`) {
            commit();
        }
    };

    // "Saved" is a recent event, not a standing fact: matching disk because nothing changed isn't "saved", so this is
    // set only on a finished write.
    const justSaved = ref(false);
    watch(input.saving, (now, before) => {
        if (before === true && !now) {
            justSaved.value = true;
        }
    });
    watch(dirty, (now) => {
        if (now) {
            justSaved.value = false;
        }
    });

    const status = computed<string>(() => {
        if (input.policy() === `none`) {
            return ``;
        }
        if (input.saving()) {
            return `Saving…`;
        }
        if (dirty.value) {
            // Two promises: `auto` is about to write it, `explicit` won't until told; conflating them costs a prompt.
            return input.policy() === `auto` ? `Unsaved` : `Not saved yet`;
        }
        return justSaved.value ? `Saved` : ``;
    });

    return { dirty, status, touched, commit, leave };
};
