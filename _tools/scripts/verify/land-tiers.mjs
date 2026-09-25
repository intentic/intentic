// What one land added to the main tree, read against the commit it landed on: the push gate's cheap tiers, run while the
// conversation that landed it can still be sent back, each finding a unit (failure-units.mjs) charged to that land. The
// measurement is measure-change.mjs's, the same one the push takes of its range; this names its findings as the router
// reads them.
import { measureChange } from "./measure-change.mjs";

export { LINTABLE } from "./measure-change.mjs";

// Every finding the tree added since `from`, as units: lint (the root rules whole, the plugin tier by what was added) and
// rustfmt over the files it touched, tidy and the ratchet over the range. `verdicts` are the checks' answers the caller
// already has for this tree.
export const landTiers = (root, from, { verdicts } = {}) => measureChange(root, from, { verdicts }).map(({ unit }) => unit);
