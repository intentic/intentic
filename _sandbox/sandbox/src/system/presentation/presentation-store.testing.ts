import { type HeldPresentation, type PresentationStore, sameCopy } from "./presentation-store.js";

// The presentation copy in memory, by the file store's rules (a copy that says the same is not written again), with how
// many times it was written, for a suite that must not touch the disk.
export const memoryPresentationStore = (initial?: HeldPresentation): PresentationStore & { readonly writes: () => number } => {
    let held = initial;
    let writes = 0;
    return {
        read: async () => held,
        keep: async (next) => {
            if (held !== undefined && sameCopy(held, next)) {
                return held;
            }
            held = next;
            writes += 1;
            return next;
        },
        forget: async () => {
            held = undefined;
        },
        writes: () => writes,
    };
};
