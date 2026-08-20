import { ref, watch, type Ref } from "vue";

/* AN EDITABLE DRAFT OF A SAVED VALUE, the settings-form shape: a text field seeded from the server's value,
 * owned by the user while they type, committed explicitly (blur, a Save button), and re-synced when the saved
 * value moves under it.
 *
 * The draft mirrors a SAVED value, and `seededFrom` remembers WHICH, the fix for a bug that reached the
 * settings page: seeding used to be guarded by "is the draft dirty?", and on first load an empty draft always
 * differs from a saved prompt, so the guard meant to protect an unsaved edit blocked the initial seed instead.
 * The row then showed a live Save button over an empty field, one click from silently wiping the value.
 * Comparing against the value the draft was seeded FROM tells the states apart: not-yet-seeded is `undefined`,
 * an untouched draft still equals its seed, and anything else is the user's own typing.
 *
 * So the rule is: seed on first load, and follow a change made in ANOTHER window, but never over an edit in
 * this one. `saved` returning undefined means "not loaded yet", never "empty", an empty saved value is ``. */
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
