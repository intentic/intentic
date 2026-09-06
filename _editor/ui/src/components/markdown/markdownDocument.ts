import { computed, type ComputedRef, ref, watch } from "vue";

/* WHEN A MARKDOWN DOCUMENT GETS WRITTEN, as a state machine with no DOM in it.
 *
 * This is the half of <MarkdownDocument> that four surfaces used to own a copy of, and it is a sidecar rather
 * than sixty lines inside the component for the reason every camelCase file in this directory is one: it is
 * the part with decisions in it, and a decision that can only be exercised by mounting a `contenteditable` is
 * a decision nobody exercises. It ships on the `@intentic/ui/markdown-document` subpath so a node-environment
 * test can reach it without the component barrel; the suite is
 * `_editor/web/src/composables/markdownDocument.test.ts`. What it replaced, measured: the acceptance panel's 700ms debounce with a `written`
 * baseline and a four-state ref; the note pane's Cancel/Save with an "unsaved" badge; two prompt pages with a
 * `dirty` computed and a Save button that appeared and vanished; and the safety policy, which had a Save
 * button and no status at all. Four implementations, four vocabularies, and three of them wrote on blur while
 * the fourth wrote on a timer.
 *
 * THE ONE RULE UNDER ALL OF IT: reading a document must never write it. That is what `stored` is for — the
 * caller's copy of what disk says — and why a caller that hands one over can never have an untouched file
 * saved out from under it by a debounce, a blur or an unmount.
 */

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

/* Long enough that a sentence is one write rather than fifteen, short enough that leaving the surface is never
 * a race with the timer. The acceptance panel's number, which is the one arrived at by use. */
export const SAVE_AFTER_MS = 700;

export const useSaveDraft = (input: SaveDraftInput): SaveDraft => {
    const dirty = computed(() => {
        const disk = input.stored();
        return disk !== undefined && input.text() !== disk;
    });

    let timer: ReturnType<typeof setTimeout> | undefined;

    /* WRITE THIS, and the one thing that can stop it is KNOWING nothing changed: opening a document to read it
     * must never write it, and a debounce that fires on an untouched file is the commonest way that happens. A
     * caller that does not hand over `stored` has not told us what disk says, so the request goes through and
     * the caller decides — which is also what makes Ctrl-S work under `none`, where saving is the caller's
     * whole job (the workspace's file viewer, a form's own submit). */
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

    /* CLOSING THE SURFACE MUST NOT BE WHAT LOSES THE LAST SENTENCE. Every way out reaches here: a panel
     * folding, a route changing, the whole view unmounting. Under `explicit` there is deliberately nothing to
     * flush — the reader chose not to save, and writing it for them on the way out is exactly the surprise
     * that policy exists to avoid. */
    const leave = (): void => {
        clearTimeout(timer);
        timer = undefined;
        if (input.policy() === `auto`) {
            commit();
        }
    };

    /* "SAVED" IS A THING THAT JUST HAPPENED, not a standing fact, so it is remembered rather than derived: a
     * document that matches disk because nobody has touched it is not "saved", it is simply the file, and a
     * surface that says so on arrival is telling the reader about work they did not do. Set when a write
     * finishes, cleared the moment anything is typed again. */
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
            // Two words for two promises: under `auto` it is about to be written, under `explicit` it will not
            // be until you say so, and a reader who cannot tell those apart is a reader who loses a prompt.
            return input.policy() === `auto` ? `Unsaved` : `Not saved yet`;
        }
        return justSaved.value ? `Saved` : ``;
    });

    return { dirty, status, touched, commit, leave };
};
