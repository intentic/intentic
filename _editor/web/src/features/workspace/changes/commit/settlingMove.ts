import { ref, watch, type Ref } from "vue";

// An index move whose effect the panel only sees once the rescan it asked for has come back: a chip's staging returns
// before the review says what it staged. `moving` spans the press to that read's end, so what reads the review (the
// Commit press's face and count) can hold its last answer instead of showing the half-way one between the two.

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

export const useSettlingMove = (fetching: Ref<boolean>) => {
    const moving = ref(false);
    const run = async (move: () => Promise<void>): Promise<void> => {
        moving.value = true;
        try {
            await move();
            await readSettled(fetching);
        } finally {
            moving.value = false;
        }
    };
    return { moving, run };
};
