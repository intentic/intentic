import type { DraftSummary } from "@intentic-app/api-contract";
import { type ComputedRef, computed, type Ref, ref } from "vue";
import { type PostEdit, postEdit } from "./postText";

/* EDITING A DRAFT IN PLACE — the state behind the pencil, kept out of the page so it can be tested without one.
 *
 * IT SAVES AS YOU TYPE, and losing the Save button is the whole point rather than a side effect. The first
 * version had Save and Cancel appear under the post while the row's own Approve and Reject vanished, so a click
 * on the pencil rearranged four controls: you looked back at a row whose buttons had all moved and had to find
 * your place in it again. Nothing here is transactional enough to deserve that. A draft file is not a form
 * submission — it is the post, sitting in a queue, unpublished until a separate decision — so typing into it
 * writes it, exactly as the acceptance panel writes a story (StoryRow.vue, which is where this pattern is from).
 * The row keeps every control it had, in the same place, and only the words become editable.
 *
 * A BASELINE, SO READING IS NEVER WRITING. `written` is what last reached the daemon; an edit that comes back
 * to where it started writes nothing, and opening a post to re-read it before approving never touches the file.
 * That is also what makes the debounce safe to keep short.
 *
 * FLUSH IS PART OF THE CONTRACT, not a tidy-up. The gap between the last keystroke and the write is exactly
 * where Approve lives — someone fixes a word and immediately approves — and a post published from the copy the
 * list is holding would go out with that word still wrong. Every path that leaves the editor goes through
 * `flush` first: closing it, opening another one, and the approve click itself. */

// Long enough that ordinary typing is one write rather than thirty, short enough that the gap Approve has to
// close is never something a person could get ahead of. The acceptance panel's number, for the same job.
const SAVE_AFTER_MS = 700;

export interface DraftEdit {
    readonly isEditing: (draft: DraftSummary) => boolean;
    /** Open a draft for editing — flushing whatever was open before it. */
    readonly open: (draft: DraftSummary) => Promise<void>;
    /** Write anything pending and close the editor. */
    readonly close: () => Promise<void>;
    /** Write anything pending, leaving the editor open. Call before acting on a draft's text. */
    readonly flush: () => Promise<void>;
    readonly content: Ref<string>;
    readonly title: Ref<string>;
    /** Restart the debounce — bound to the fields' input. */
    readonly touch: () => void;
    /** The draft's length as it stands, counting unsaved keystrokes. */
    readonly liveLength: (draft: DraftSummary) => number;
    readonly anyOpen: ComputedRef<boolean>;
}

export const useDraftEdit = (write: (draft: DraftSummary, changes: PostEdit) => Promise<void>): DraftEdit => {
    const editingId = ref<string | undefined>(undefined);
    const content = ref(``);
    const title = ref(``);

    // The draft as the daemon last had it — the comparison baseline, advanced on every successful write so a
    // second flush with nothing new to say stays silent. Not a ref: no template reads it.
    let baseline: DraftSummary | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const flush = async (): Promise<void> => {
        clearTimeout(timer);
        timer = undefined;
        if (baseline === undefined) {
            return;
        }
        const changes = postEdit(baseline, { content: content.value, title: title.value });
        if (changes === undefined) {
            return;
        }
        const target = baseline;
        // Advance the baseline BEFORE awaiting: a keystroke landing mid-write must be measured against what is
        // on its way to disk, or the next flush re-sends the same change.
        baseline = { ...target, ...changes };
        await write(target, changes);
    };

    return {
        isEditing: (draft) => editingId.value === draft.id,
        open: async (draft) => {
            await flush();
            editingId.value = draft.id;
            baseline = draft;
            content.value = draft.content;
            title.value = draft.title ?? ``;
        },
        close: async () => {
            await flush();
            editingId.value = undefined;
            baseline = undefined;
        },
        flush,
        content,
        title,
        touch: () => {
            clearTimeout(timer);
            timer = setTimeout(() => void flush(), SAVE_AFTER_MS);
        },
        // Reading the field rather than the row is what keeps the footer's count honest while typing — it is
        // the one fact on the row that has to move with the words, since it is the reason a post can fail.
        liveLength: (draft) => (editingId.value === draft.id ? content.value.length : draft.content.length),
        anyOpen: computed(() => editingId.value !== undefined),
    };
};
