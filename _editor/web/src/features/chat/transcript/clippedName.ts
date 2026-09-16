import { computed, type ComputedRef, type Ref, ref, watch } from "vue";

// How an attachment's filename is drawn where there is not room for all of it. One definition for every chip that
// draws one, so a picture, a sound and a log all cut a name in the same place.

// Middle ellipsis: what tells one attachment from the next is usually a timestamp or a hash at the END, which is
// exactly what a trailing `truncate` eats. The tail rides along at fixed width while the head does the truncating.
const TAIL_CHARS = 9;

export interface ClippedName {
    /** Bind to the head's own element: whether the head is cut is measured there, never guessed from a length. */
    readonly nameBox: Ref<HTMLElement | undefined>;
    readonly nameHead: ComputedRef<string>;
    /** Empty for a name short enough that keeping an ending separate would only split it pointlessly. */
    readonly nameTail: ComputedRef<string>;
    readonly clipped: Ref<boolean>;
}

export const useClippedName = (name: () => string): ClippedName => {
    const split = computed(() => (name().length > TAIL_CHARS + 6 ? TAIL_CHARS : 0));

    // Whether the head is actually cut, which only the box can answer. `text-overflow: ellipsis` is not used to answer
    // it: it keeps the space the last fitting character could not use INSIDE the clipping box, and that space lands
    // between the mark and the ending — a word-sized gap in the middle of a filename. The mark rides on the ending.
    const nameBox = ref<HTMLElement>();
    const clipped = ref(false);
    watch(
        nameBox,
        (element, _previous, onCleanup) => {
            clipped.value = false;
            if (element === undefined) {
                return;
            }
            const sync = (): void => {
                clipped.value = Math.round(element.scrollWidth) > Math.round(element.clientWidth);
            };
            const observer = new ResizeObserver(sync);
            observer.observe(element);
            sync();
            onCleanup(() => observer.disconnect());
        },
        { immediate: true, flush: `post` },
    );

    return {
        nameBox,
        nameHead: computed(() => (split.value === 0 ? name() : name().slice(0, -split.value))),
        nameTail: computed(() => (split.value === 0 ? `` : name().slice(-split.value))),
        clipped,
    };
};
