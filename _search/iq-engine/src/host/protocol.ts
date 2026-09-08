import type { CodebaseHealth, HealthRequest } from "../engines/health.js";
import type { Feature } from "../features.js";
import type { IndexStatus, QueryOutcome, QueryRequest } from "../types.js";

// The wire between the daemon and the engine's own process: one file both sides import, so a message either can send
// has a case on both ends. Sent via node's structured-clone IPC, not JSON, since QueryRequest.features is a Set and
// exactOptionalPropertyTypes makes absent-vs-undefined meaningful.

// Constructor arguments minus the three callbacks, which can't cross a process boundary; the child turns each into a
// pushed event instead.
export interface EngineInit {
    readonly root: string;
    readonly indexDir?: string;
    readonly rgPath?: string;
    readonly modelDir?: string;
    readonly features?: ReadonlySet<Feature>;
}

export type EngineRequest =
    | { readonly type: "init"; readonly options: EngineInit }
    | { readonly type: "run"; readonly id: number; readonly request: QueryRequest }
    // Forwards the parent's AbortSignal to reach the rg child the engine spawned, which lives over here.
    | { readonly type: "abort"; readonly id: number }
    | { readonly type: "health"; readonly id: number; readonly request: HealthRequest }
    | { readonly type: "warm"; readonly id: number }
    | { readonly type: "healthDirty" }
    | { readonly type: "dirty" }
    | { readonly type: "close"; readonly id: number };

// Pushed, not asked for: the host reads these synchronously, and a process boundary has no synchronous read. `sweptAt`
// is a timestamp, not an age, so the parent computes age at read time instead of freezing it at push time.
export interface EngineMetricsSnapshot {
    readonly files: number;
    readonly generation: number;
    readonly dirtySequence: number;
    readonly appliedSequence: number;
    readonly revalidated: boolean;
    readonly sweptAt: number | undefined;
    readonly embedBacklog: number;
    readonly queryWorker: { readonly live: boolean; readonly pendingRequests: number };
}

// What a settled call carries back; undiscriminated on the wire since nothing branches on it, matched instead by the
// request `id`. `undefined` is close()'s answer.
export type EngineAnswer = QueryOutcome | CodebaseHealth | IndexStatus | undefined;

export type EngineEvent =
    | { readonly type: "settled"; readonly id: number; readonly value: EngineAnswer }
    // Errors travel as message/stack, not Error instances: structured clone drops whatever a subclass added.
    | { readonly type: "failed"; readonly id: number; readonly message: string; readonly stack?: string }
    | { readonly type: "metrics"; readonly metrics: EngineMetricsSnapshot }
    // The three constructor callbacks as events: indexError logs a stalled index, queryError a semantic fallback.
    | { readonly type: "indexError"; readonly message: string; readonly stack?: string }
    | { readonly type: "queryError"; readonly message: string; readonly stack?: string }
    | { readonly type: "indexProgress"; readonly remaining: number };
