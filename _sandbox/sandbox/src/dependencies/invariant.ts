import type { InvariantCheck } from "../invariants/invariants.js";

/* WHY THERE IS NOTHING TO CHECK HERE.
 *
 * No runtime invariant: this subsystem is two judgements and a lookup. `successors` is a curated list,
 * `workspace-pins` is a read of the manifests already in the tree, and `registry-freshness` asks npm through
 * an on-disk cache that is advisory by construction: a miss costs a lookup, an entry that cannot be written is
 * a miss next time, and nothing else in the daemon keeps a record of what it holds. There is no second record
 * for any of it to disagree with, and no state that outlives the tool call that asked. */

export const owner = "dependencies";

export const checks = (): readonly InvariantCheck[] => [];
