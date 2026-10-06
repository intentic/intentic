import type { InvariantCheck } from "../invariants/invariants.js";

/* No runtime invariant: this subsystem reads what the image carries (the feature packs under image-packs/ and their bake stamps, the binaries on PATH), all of it fixed when the container starts and read the same way on every call. It holds no state of its own that could come to disagree with anything. */

export const owner = "image";

export const checks = (): readonly InvariantCheck[] => [];
