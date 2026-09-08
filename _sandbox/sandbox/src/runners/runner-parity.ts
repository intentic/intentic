import type { RunnerParity } from "@intentic/sandbox-contract";

// Whether a runner's build matches the parent's, since both run turns through the same daemon code. Reported, never
// enforced: an outdated runner still runs, this only decides a badge and update button. `unknown` is real: a
// never-connected runner or an image-less dev parent has nothing to compare.

export interface ParityFacts {
    readonly image: string;
    readonly channel?: string | undefined;
    readonly overlayHash?: string | undefined;
}

// Normalises an empty image to "dev", so two hand-started dev boxes (the same build by construction) don't read as a
// mismatch.
const named = (image: string): string => (image === "" ? "dev" : image);

export const runnerParity = (parent: ParityFacts, reported: ParityFacts | undefined): RunnerParity => {
    if (reported === undefined || reported.image === "") {
        return "unknown";
    }
    if (named(parent.image) === "dev") {
        return "unknown";
    }
    // Image, channel and overlay hash decide the code; absent-vs-absent agrees, absent-vs-present does not.
    const same = named(parent.image) === named(reported.image) && (parent.channel ?? "") === (reported.channel ?? "") && (parent.overlayHash ?? "") === (reported.overlayHash ?? "");
    return same ? "current" : "outdated";
};
