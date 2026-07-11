import type { ResourceType } from "@intentic/resources";
import type { Providers } from "./provider.js";
import type { ReadinessProbe } from "./readiness.js";

// Inputs after $secret/$ref substitution: still a value tree, but with no $ref/$secret nodes left.
// A bare ref becomes the dependency's id string; an output ref becomes its resolved value.
export type ResolvedInputs = Readonly<Record<string, unknown>>;

export type Action = "create" | "update" | "noop";

export interface Step {
    readonly id: string;
    readonly type: ResourceType;
    readonly action: Action;
    readonly reason?: string; // present for "update"
}

export interface Orphan {
    readonly id: string;
    readonly type: ResourceType;
}

// An orphan plus the inputs its provider's `delete` acts on (from the ListedResource that found it).
// Inputs carry connection secrets — plumb entries to pruneOrphans or strip to Orphan, never serialize.
export interface OrphanEntry extends Orphan {
    readonly inputs: Readonly<Record<string, unknown>>;
    readonly protected?: boolean;
}

export interface PlanOutcome {
    readonly steps: readonly Step[];
}

export interface ApplyOutcome {
    readonly steps: readonly Step[];
    readonly outputs: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
}

export interface PrunedResource {
    readonly id: string;
    readonly type: ResourceType;
}

export interface PruneOutcome {
    // Resources removed from desired state that were torn down.
    readonly deleted: readonly PrunedResource[];
    // Resources removed from desired state whose provider has no `delete` — left in place (logged).
    readonly skipped: readonly PrunedResource[];
}

// Structured lifecycle events the engine emits as it runs — the machine-readable counterpart to `log`
// (which carries providers' free-form strings). A driver (the CLI, a control plane) renders these into a
// live progress stream; the final result is built from the returned outcomes, not from events.
export type EngineEvent =
    | {
          readonly kind: "node";
          readonly phase: "apply" | "plan";
          readonly state: "start" | "done";
          readonly id: string;
          readonly type: ResourceType;
          readonly action?: Action;
          readonly reason?: string;
      }
    | { readonly kind: "readiness"; readonly state: "waiting" | "ready"; readonly id: string; readonly url: string }
    | { readonly kind: "iteration"; readonly n: number; readonly converged: boolean }
    | {
          readonly kind: "prune";
          readonly state: "deleted" | "skipped";
          readonly id: string;
          readonly type: ResourceType;
          // Why a skipped resource was left in place: "no-delete" (provider cannot tear it down) or "protected".
          readonly reason?: "no-delete" | "protected";
      }
    | { readonly kind: "orphan"; readonly id: string; readonly type: ResourceType };

export interface EngineConfig {
    readonly providers: Providers;
    readonly env?: Readonly<Record<string, string | undefined>>; // default: process.env
    readonly probe?: ReadinessProbe; // default: httpProbe
    readonly log?: (message: string) => void; // default: console.log — providers' free-form messages
    readonly onEvent?: (event: EngineEvent) => void; // default: no-op — structured lifecycle events
}
