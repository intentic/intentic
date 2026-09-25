import type { ResourceBudget } from "../../workload/resource-budget.js";
import type { LiveMetrics } from "./live-metrics.js";
import type { PerfTracker } from "./perf.js";

// This container's resources: operation timing, live metrics and the budget that judges room.
export interface ResourcesSlice {
    // Every expensive path measures itself here, so a slow report names the op instead of an unattributed stall.
    readonly perf: PerfTracker;
    // Cardinalities behind heap growth in the resource series; stays allocation-light, called every minute.
    readonly resourceOwners: () => Readonly<Record<string, unknown>>;
    // CPU and memory per conversation and for the sandbox, measured only when GET /system/metrics asks.
    readonly liveMetrics: LiveMetrics;
    // The one judge of room (workload/resource-budget.ts): the turn door, a child waiting for room, the
    // heavy-command queue's socket and the editor's gauge all read its snapshot. A service so a test can say what the box
    // has: the reading is of live cgroup files, and a suite on a genuinely full machine would refuse its own fixtures.
    readonly resources: ResourceBudget;
}
