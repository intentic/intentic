import type { ResourceType } from "@intentic/resources";
import type { ResolvedInputs } from "./types.js";

// A resource that exists in actual infrastructure, recovered statelessly by its ownership stamp/id.
export interface Observed {
    readonly outputs: Readonly<Record<string, unknown>>;
    // Provider-private data outside OUTPUTS; only `diff` reads it, to surface drift outputs can't carry.
    readonly detail?: Readonly<Record<string, unknown>>;
    // Drift stamp read back from the resource; mismatch against the node's inputs hash flags update without `diff`.
    readonly stampHash?: string;
}

// A pure diff decision: noop, or update with a human-readable reason surfaced in plan output.
export type DiffResult = { readonly action: "noop" } | { readonly action: "update"; readonly reason: string };

// A desired-graph node a provider may scan when listing stamped resources. Refs to outputs are PENDING, so
// `list` must depend only on sources parseable from literals/secrets.
export interface ScanSource {
    readonly id: string;
    readonly type: ResourceType;
    readonly inputs: ResolvedInputs;
}

// A stamped resource of this provider's kind found in live infrastructure: its stamp plus inputs sufficient for
// `delete` to tear it down.
export interface ListedResource {
    readonly id: string;
    readonly inputs: ResolvedInputs;
    // True when the live resource carries the intentic.protect stamp; pruneOrphans leaves it in place.
    readonly protected?: boolean;
}

export interface ProviderContext {
    readonly env: Readonly<Record<string, string | undefined>>;
    readonly log: (message: string) => void;
    // The id of the node currently being reconciled; what a provider stamps its resource with.
    readonly id: string;
    // A dependency's produced output for the bare-ref path; throws if (id, name) was not produced this run.
    readonly output: (id: string, name: string) => unknown;
    // The hash of the node's serialized inputs, stamped as intentic.hash; set only while a node is being applied.
    readonly inputsHash?: string;
}

// The contract every provider implements; `apply` is distinct from the engine's top-level apply().
export interface Provider {
    // Stateless introspection of the node being reconciled: returns the resource if it exists, undefined if not;
    // must return undefined rather than throw on still-pending inputs.
    readonly read: (inputs: ResolvedInputs, ctx: ProviderContext) => Promise<Observed | undefined>;
    // Pure decision (no mutation); the engine calls this only when `read` returned an Observed.
    readonly diff: (inputs: ResolvedInputs, observed: Observed) => DiffResult;
    // Mutating: create when observed is undefined, otherwise update; returns the resource's produced outputs.
    readonly apply: (inputs: ResolvedInputs, observed: Observed | undefined, ctx: ProviderContext) => Promise<Record<string, unknown>>;
    // Optional: enumerate this kind's stamped resources in live infra via the graph's inventory sources (hosts,
    // cloudflare); best-effort per source, logged and skipped rather than thrown. ctx.id is "".
    readonly list?: (sources: readonly ScanSource[], ctx: ProviderContext) => Promise<readonly ListedResource[]>;
    // Optional: tear a resource down; called by prune (a removed node's previous inputs) and pruneOrphans (a found
    // resource). Idempotent; without `delete` the provider is left in place and logged.
    readonly delete?: (inputs: ResolvedInputs, ctx: ProviderContext) => Promise<void>;
    // Optional: rename a live resource keyed by `oldId` to ctx.id in place, preserving its state; called once by
    // applyMoves before reconcile. Idempotent; without `restamp` the rename degrades to prune + create.
    readonly restamp?: (oldId: string, inputs: ResolvedInputs, ctx: ProviderContext) => Promise<void>;
}

// A node whose `type` has no registered provider is a hard error at reconcile time.
export type Providers = Partial<Record<ResourceType, Provider>>;
