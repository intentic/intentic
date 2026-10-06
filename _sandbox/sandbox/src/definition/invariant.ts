import type { InvariantCheck } from "../invariants/invariants.js";

/* No runtime invariant: a sandbox definition is never stored or held running. It is derived from the live stores at the moment it is asked for (an export, a runner's hello, a drift line), and applied once, item by item, through each item's own write path; whatever it landed is then the capability, settings and repo stores' to keep, and the coverage of .intentic/config/ by DEFINITION_SOURCES and DEFINITION_WORKSPACE is a static fact definition-coverage.test.ts holds. */

export const owner = "definition";

export const checks = (): readonly InvariantCheck[] => [];
