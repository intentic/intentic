import type { Doors } from "../doors";

// The issues inbox the vendored issues extension reads: bug reports a visitor's browser sent from the owner's own site.
// The demo's sandbox has been sent none yet, so the inbox is there and empty, as a new one is.
export const issuesDoors = {
    list: () => ({ issues: [], invalid: [] }),
} satisfies Doors<`issues`>;
