import { budgetOn } from "../../agent/run/turn/turn-plan.testing.js";
import { createLogger } from "../../logger.js";
import { testConfig } from "../../testing.js";
import { createPerfTracker } from "./perf.js";
import type { ResourcesSlice } from "./resources-slice.js";

// The resources slice as route suites stand it up (harness/route-services.testing.ts). Not part of the build.

export const resourcesSliceFake = () =>
    ({
        // A box with room, stated rather than measured, for the admission gate every turn route passes through. The
        // real reading is of live cgroup files, and since it counts swap (workload/resource-budget.ts) a
        // suite running on a machine that is genuinely full refuses turns these tests are asserting the shape of.
        resources: budgetOn(),
        // Real tracker: in-memory, unref'd summary timer, and request middleware records through it on every route.
        perf: createPerfTracker(createLogger(testConfig)),
    }) satisfies Partial<ResourcesSlice>;
