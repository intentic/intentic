import { computed, type ComputedRef, ref, watch, type Ref } from "vue";

// An editable draft of a saved value: seeded on load, followed when the saved value changes elsewhere, but never
// overwritten mid-edit. `seededFrom` tells not-yet-seeded (undefined) from an untouched draft (still the same as it) from
// the user's own typing; `saved` returning undefined means not loaded yet, never empty. `same` is what "still the same"
// means for this value.
const followedDraft = (saved: () => string | undefined, same: (draft: string, seeded: string) => boolean): Ref<string> => {
    const draft = ref(``);
    let seededFrom: string | undefined;
    watch(
        saved,
        (value) => {
            if (value === undefined) {
                return;
            }
            if (seededFrom === undefined || same(draft.value, seededFrom)) {
                draft.value = value;
            }
            seededFrom = value;
        },
        { immediate: true },
    );
    return draft;
};

export function useDraft(saved: () => string | undefined): Ref<string> {
    return followedDraft(saved, (draft, seeded) => draft === seeded);
}

/** A draft of a text setting the app saves trimmed, and the stored value as a document editor should measure it. */
export interface TrimmedDraft {
    readonly draft: Ref<string>;
    /** What is saved, reading as the draft itself while the two differ only by the whitespace a save trims. */
    readonly stored: ComputedRef<string | undefined>;
}

// For a setting saved as `text.trim()`. The document editor's text ends in the gap after its last block, so the draft
// never equals what its own save wrote: measured raw, a finished save still read "Not saved yet" and its button stayed
// pressable, and 18 presses later the owner still did not know it had saved. Only ends are forgiven, never a change
// inside the text; the draft still follows a change made elsewhere while it holds nothing of its own.
export function useTrimmedDraft(saved: () => string | undefined): TrimmedDraft {
    const draft = followedDraft(saved, (text, seeded) => text.trim() === seeded.trim());
    const stored = computed(() => {
        const disk = saved();
        return disk !== undefined && draft.value.trim() === disk.trim() ? draft.value : disk;
    });
    return { draft, stored };
}
