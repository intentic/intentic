import type { CodebaseHealth, HealthRequest } from "../engines/health.js";
import type { Feature } from "../features.js";
import type { IndexStatus, QueryOutcome, QueryRequest } from "../types.js";

/* THE WIRE BETWEEN THE DAEMON AND THE ENGINE'S OWN PROCESS — one file both halves import, so a message either
 * side can send is a message the other side has a case for. host/client.ts is the parent, host/child.ts the
 * child; the argument for splitting them at all is in client.ts.
 *
 * Sent with node's ADVANCED (structured-clone) IPC serialization rather than JSON, because the surface carries
 * things JSON silently ruins: QueryRequest.features is a Set, and half the optional fields on a request are
 * absent-vs-undefined distinctions that `exactOptionalPropertyTypes` makes load-bearing. */

// The constructor arguments, minus the three callbacks — those cannot cross a process boundary, so the child
// turns each into a pushed event and the client calls the host's function on arrival.
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
    // The parent's AbortSignal, forwarded: it fires on a browser superseding a search, and what it has to reach
    // is the rg child the engine spawned — which now lives over here.
    | { readonly type: "abort"; readonly id: number }
    | { readonly type: "health"; readonly id: number; readonly request: HealthRequest }
    | { readonly type: "warm"; readonly id: number }
    | { readonly type: "dirty" }
    | { readonly type: "close"; readonly id: number };

/* METRICS ARE PUSHED, NOT ASKED FOR, because the host reads them SYNCHRONOUSLY (composition's resourceOwners
 * builds the resource series without awaiting anything) and a process boundary has no synchronous read.
 *
 * `sweptAt` is a timestamp where ResidentEngineMetrics has an AGE, and that is the point: an age computed in
 * the child would freeze at the moment of the push, so an idle engine would report a sweep that never gets any
 * older. The parent subtracts at read time instead. */
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

// What a settled call carries back. Which member it is follows from the request `id` being answered, which the
// client tracks — the union is not discriminated on the wire because nothing on either side branches on it.
// `undefined` is close()'s answer: a call that reports completion and nothing else.
export type EngineAnswer = QueryOutcome | CodebaseHealth | IndexStatus | undefined;

export type EngineEvent =
    | { readonly type: "settled"; readonly id: number; readonly value: EngineAnswer }
    // Errors travel as their message and stack, not as Error instances: structured clone carries an Error's own
    // properties but drops everything a subclass added, so rebuilding a plain Error on the far side is both
    // honest about what survived and identical for every caller here (all of them read `.message`).
    | { readonly type: "failed"; readonly id: number; readonly message: string; readonly stack?: string }
    | { readonly type: "metrics"; readonly metrics: EngineMetricsSnapshot }
    // The three constructor callbacks, as events. `indexError` and `queryError` are the host's log lines for an
    // index that stopped tracking disk and for semantic search quietly falling back to keywords.
    | { readonly type: "indexError"; readonly message: string; readonly stack?: string }
    | { readonly type: "queryError"; readonly message: string; readonly stack?: string }
    | { readonly type: "indexProgress"; readonly remaining: number };
