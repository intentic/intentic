import { DEV_SANDBOX_IMAGE } from "@intentic/sandbox-contract/policy/overlay-lint";
import type { RunnerParity } from "@intentic/sandbox-contract/protocol/doors/runner-protocol";

// Whether a runner's build matches the parent's, since both run turns through the same daemon code. Reported, never
// enforced: an outdated runner still runs, this only decides a badge and update button. `unknown` is real: a
// never-connected runner has nothing to compare, and a build from a checkout names no particular build.

export interface ParityFacts {
    readonly image: string;
    // What `image` was composed from (SANDBOX_BASE_IMAGE); empty or absent when `image` is the base itself.
    readonly baseImage?: string | undefined;
    readonly channel?: string | undefined;
    readonly overlayHash?: string | undefined;
}

// The build a side runs, by the image it was composed FROM. Its own `image` is no measure once an overlay is applied:
// that tag carries the container's slug (`intentic-sandbox-env-<slug>:<hash>`), so a runner built from the parent's
// approved overlay on the parent's own base still never shares it, and read as outdated for good (2026-10, omen).
// The overlay is compared on its own axis below, by hash.
const baseOf = (facts: ParityFacts): string => (facts.baseImage !== undefined && facts.baseImage !== "" ? facts.baseImage : facts.image);

// A tag built from a checkout names whatever that machine's checkout held when it was built: two of them on two
// machines are different builds under one name, and either may be ahead. `""` and "dev" are a hand-started dev box.
const fromCheckout = (base: string): boolean => base === "" || base === "dev" || base === DEV_SANDBOX_IMAGE;

export const runnerParity = (parent: ParityFacts, reported: ParityFacts | undefined): RunnerParity => {
    if (reported === undefined || reported.image === "") {
        return "unknown";
    }
    const parentBase = baseOf(parent);
    const runnerBase = baseOf(reported);
    // Nothing an update could bring level either: `ic` refuses to move a checkout build onto the published image.
    if (fromCheckout(parentBase) || fromCheckout(runnerBase)) {
        return "unknown";
    }
    // Base, channel and overlay hash decide the code; absent-vs-absent agrees, absent-vs-present does not.
    const same = parentBase === runnerBase && (parent.channel ?? "") === (reported.channel ?? "") && (parent.overlayHash ?? "") === (reported.overlayHash ?? "");
    return same ? "current" : "outdated";
};
