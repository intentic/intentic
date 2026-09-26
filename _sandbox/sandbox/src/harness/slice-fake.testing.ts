import type { Services } from "../composition.js";

// What each slice's route fake (`<slice>.testing.ts`, beside the slice it stands in for) is built from. Not part of the
// build.
export interface SliceFakeContext {
    // The suite's own history root: its config's, or testConfig's.
    readonly historyRoot: string;
    // The finished services, read at call time, so a fake answers through whatever else the suite overrode.
    readonly self: () => Services;
}
