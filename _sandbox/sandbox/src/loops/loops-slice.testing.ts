import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type { SliceFakeContext } from "../harness/slice-fake.testing.js";
import type { LoopsOwnMembers } from "./loops-slice.js";
import { fileLoopDesignsStore, fileLoopsStore } from "./loops-store.js";

// The loops half of the slice as route suites stand it up (harness/route-services.testing.ts): the real stores, over files
// of these services' own under the suite's history root, so no two suites read each other's loops. Not part of the build.
export const loopsSliceFake = (context: SliceFakeContext): LoopsOwnMembers => {
    const dir = join(context.historyRoot, "loops", randomUUID());
    return { loops: fileLoopsStore(join(dir, "loops.json")), loopDesigns: fileLoopDesignsStore(join(dir, "loop-designs.json")) };
};
