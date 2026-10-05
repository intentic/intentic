import type { ResourceType } from "@intentic/resources";
import type { Providers } from "./provider.js";
import type { ReadinessProbe } from "./readiness.js";

// Inputs after $secret/$ref substitution: a value tree with no $ref/$secret nodes left. A bare ref becomes the
// dependency's id string; an output ref becomes its resolved value.
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

// An orphan plus the inputs its provider's `delete` acts on.
export interface OrphanEntry extends Orphan {
    readonly inputs: Readonly<Record<string, unknown>>;
    readonly protected?: boolean;
}

// A scan source `list` could not read (an unreachable host, a zone not found): the scan is incomplete there.
export interface ScanSkip {
    readonly source: string;
    readonly reason: string;
}

// What a stamped scan found outside the graph, split by rule 6's ownership answers.
export interface OrphanScan {
    // Stamped with this intent's owner and absent from the graph: what pruneOrphans may delete.
    readonly orphans: readonly OrphanEntry[];
    // Stamped without an owner (before owners existed, or by an intent that had none) and absent from the graph:
    // reported, never pruned. A person adopts one by declaring it, or removes it by hand.
    readonly unowned: readonly Orphan[];
    // Stamped by another intent: not this one's to judge, only counted.
    readonly foreign: number;
    // Live resources stamped with this intent's owner, in the graph or not: positive evidence it was applied before.
    readonly owned: number;
    readonly skipped: readonly ScanSkip[];
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

// Why prune left a resource in place: its provider cannot delete, it is protected, or its delete failed for want of
// secrets no longer set (it stays pending, and the next apply with them set retries it).
export type SkipReason = "no-delete" | "protected" | "missing-secret";

export interface SkippedResource extends PrunedResource {
    readonly reason: SkipReason;
    // For "missing-secret": the secret keys the delete could not resolve.
    readonly missing?: readonly string[];
}

export interface PruneOutcome {
    // Resources removed from desired state that were torn down.
    readonly deleted: readonly PrunedResource[];
    // Resources removed from desired state and left in place, each with why (logged).
    readonly skipped: readonly SkippedResource[];
}

// Structured lifecycle events the engine emits, the machine-readable counterpart to `log`. A driver renders these
// into a live progress stream; the final result comes from the returned outcomes, not events.
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
          // Why a skipped resource was left in place.
          readonly reason?: SkipReason;
      }
    // A stamped resource absent from the graph: this intent's own ("mine", prunable) or one with no owner stamp
    // ("unowned", reported only). Another intent's resources raise no event.
    | { readonly kind: "orphan"; readonly id: string; readonly type: ResourceType; readonly ownership: "mine" | "unowned" };

export interface EngineConfig {
    readonly providers: Providers;
    // The intent id stamped as every resource's owner (the graph's `owner`); without one nothing is stamped with an
    // owner and a scan can claim nothing as an orphan.
    readonly owner?: string;
    // Aborted when the run must stop mutating (its apply lock was lost): checked before each node is applied or
    // deleted, so the run stops at the next resource rather than racing another writer.
    readonly signal?: AbortSignal;
    readonly env?: Readonly<Record<string, string | undefined>>; // default: process.env
    readonly probe?: ReadinessProbe; // default: httpProbe
    readonly log?: (message: string) => void; // default: console.log, providers' free-form messages
    readonly onEvent?: (event: EngineEvent) => void; // default: no-op, structured lifecycle events
}
