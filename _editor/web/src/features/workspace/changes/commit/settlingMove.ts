import { type Ref, shallowRef, watch } from "vue";

// An index move whose effect the panel only sees once the rescan it asked for has come back: a chip's staging returns
// before the review says what it staged. The move holds what the press reading the review (Commit's face and count)
// said as it began, from the press to that read's end, instead of the half-way answer between the two.

// No rescan outlasts this; a batch refused before it was sent asks for none, and must not hold the face for good.
const READ_WAIT_MS = 3_000;

// Ends when a read seen in flight finishes. The read's end, not a change in the rows: an answer equal to the last is kept
// as the same data, which is how a chip that staged nothing new is answered.
const readSettled = (fetching: Ref<boolean>): Promise<void> =>
    new Promise((resolve) => {
        let asked = fetching.value;
        const done = (): void => {
            stop();
            clearTimeout(timer);
            resolve();
        };
        const stop = watch(fetching, (reading) => {
            if (reading) {
                asked = true;
            } else if (asked) {
                done();
            }
        });
        const timer = setTimeout(done, READ_WAIT_MS);
    });

/**
 * A move that holds `face` (what the press reading the review said as the move began) from the press to the read's end:
 * `held` is the one record of it, so the press draws it rather than keeping a value of its own.
 */
export const useSettlingMove = <F>(fetching: Ref<boolean>) => {
    const held = shallowRef<F | undefined>(undefined);
    const run = async (face: F, move: () => Promise<void>): Promise<void> => {
        held.value = face;
        try {
            await move();
            await readSettled(fetching);
        } finally {
            held.value = undefined;
        }
    };
    return { held, run };
};
