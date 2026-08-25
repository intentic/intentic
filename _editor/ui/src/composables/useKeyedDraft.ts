import { computed, ref, type Ref, type WritableComputedRef } from "vue";

/* THE OTHER HALF OF useNoteDraft: the unsaved edits themselves, kept above a pane that is REUSED as the
 * selection moves. That pane takes the draft as a ref rather than owning one (see the note there), and what
 * every caller then needs is the same map: open a linked note to check a fact, come back, and the correction
 * being written is still there. Memory and Knowledge had each written it out, byte for byte.
 *
 * `undefined` DELETES rather than storing a blank, so "is there a draft for this key" is one question with one
 * answer, and a picker can say "Unsaved" beside the notes that have one. */
export const useKeyedDraft = (
    selected: Ref<string | undefined>,
): { draft: WritableComputedRef<string | undefined>; hasDraft: (key: string) => boolean } => {
    const drafts = ref(new Map<string, string>());
    const draft = computed<string | undefined>({
        get: () => (selected.value === undefined ? undefined : drafts.value.get(selected.value)),
        set: (value) => {
            if (selected.value === undefined) {
                return;
            }
            if (value === undefined) {
                drafts.value.delete(selected.value);
            } else {
                drafts.value.set(selected.value, value);
            }
        },
    });
    return { draft, hasDraft: (key) => drafts.value.has(key) };
};
