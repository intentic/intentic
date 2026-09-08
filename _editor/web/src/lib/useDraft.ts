import { ref, watch, type Ref } from "vue";

// An editable draft of a saved value: seeded on load, followed when the saved value changes elsewhere, but never
// overwritten mid-edit. `seededFrom` tells not-yet-seeded (undefined) from an untouched draft (still equal to it) from
// the user's own typing; `saved` returning undefined means not loaded yet, never empty.
export function useDraft(saved: () => string | undefined): Ref<string> {
    const draft = ref(``);
    let seededFrom: string | undefined;
    watch(
        saved,
        (value) => {
            if (value === undefined) {
                return;
            }
            if (seededFrom === undefined || draft.value === seededFrom) {
                draft.value = value;
            }
            seededFrom = value;
        },
        { immediate: true },
    );
    return draft;
}
