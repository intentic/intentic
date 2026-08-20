import type { ResourceType } from "@intentic/resources";
import type { ResolvedInputs } from "./types.js";

// A resource that exists in actual infrastructure, recovered statelessly by its ownership stamp/id.
export interface Observed {
    readonly outputs: Readonly<Record<string, unknown>>;
    // Provider-private introspection the engine never validates against OUTPUTS and never stores as refs
    //, only diff reads it. Lets a provider surface actual config (e.g. a tunnel's current ingress) so a
    // pure diff can detect drift, which outputs cannot carry (validateOutputs rejects undeclared keys).
    readonly detail?: Readonly<Record<string, unknown>>;
    // The intentic.hash drift-stamp read back from the live resource (see graph's HASH_KEY). When present,
    // the engine compares it against the node's current inputs hash and flags a mismatch as an update
    // WITHOUT consulting `diff`, so authored-input drift is caught generically. Omit when the resource
    // carries no hash stamp (pre-hash resources, kinds that don't stamp it): no check runs.
    readonly stampHash?: string;
}

// A pure diff decision: noop, or update with a human-readable reason (surfaced in plan output).
export type DiffResult = { readonly action: "noop" } | { readonly action: "update"; readonly reason: string };

// A desired-graph node a provider may scan through when listing stamped resources: its id, type, and
// leniently-resolved inputs. Refs to outputs are PENDING (no read pass backs a scan), a provider's `list`
// must only depend on sources it can parse from literals/secrets (the inventory nodes: host, cloudflare).
export interface ScanSource {
    readonly id: string;
    readonly type: ResourceType;
    readonly inputs: ResolvedInputs;
}

// A stamped resource of this provider's kind found in live infrastructure: its stamp (the node id it was
// created under) plus inputs sufficient for this provider's `delete` to tear it down, the scan source's
// connection material (a host's SSH block, the Cloudflare creds). The collection contract: whatever `list`
// returns, `delete` can act on.
export interface ListedResource {
    readonly id: string;
    readonly inputs: ResolvedInputs;
    // True when the live resource carries the intentic.protect stamp, pruneOrphans leaves it in place.
    readonly protected?: boolean;
}

export interface ProviderContext {
    readonly env: Readonly<Record<string, string | undefined>>;
    readonly log: (message: string) => void;
    // The id of the node currently being reconciled, what a provider stamps its resource with.
    readonly id: string;
    // A dependency's produced output. Used on the BARE-ref path: an input that is a bare {$ref:"dep"}
    // resolves to the id string "dep", and the provider reaches the dep's real outputs here. Throws if
    // (id, name) was not produced this run.
    readonly output: (id: string, name: string) => unknown;
    // The hash of the node's serialized inputs, what a provider stamps as the intentic.hash label
    // alongside intentic.id. Set only while a node is being applied.
    readonly inputsHash?: string;
}

// The contract every provider implements. `apply` (create-or-update) is provider-owned and distinct
// from the engine's top-level apply(); it reads as `provider.apply(...)`.
export interface Provider {
    // Stateless introspection of the node being reconciled (its id is on ctx.id, its inputs are passed
    // in), returning the resource if it exists or undefined if it does not. In plan mode `inputs` may
    // carry PENDING values for dependencies that are themselves pending creates; a provider that cannot
    // introspect from such inputs must return undefined.
    readonly read: (inputs: ResolvedInputs, ctx: ProviderContext) => Promise<Observed | undefined>;
    // Pure decision (no mutation). The engine calls this ONLY when `read` returned an Observed.
    readonly diff: (inputs: ResolvedInputs, observed: Observed) => DiffResult;
    // Mutating: create (observed === undefined) or update. Returns the resource's produced outputs.
    readonly apply: (inputs: ResolvedInputs, observed: Observed | undefined, ctx: ProviderContext) => Promise<Record<string, unknown>>;
    // Optional: enumerate the stamped resources of this kind that exist in live infrastructure, scanning
    // through the graph's inventory sources (hosts, cloudflare). Best-effort per source: an unreachable
    // source is logged and skipped, never thrown, a scan must not fail the run. ctx.output is unusable
    // here (no node is being reconciled); ctx.id is "".
    readonly list?: (sources: readonly ScanSource[], ctx: ProviderContext) => Promise<readonly ListedResource[]>;
    // Optional: tear a resource down. Called by prune for a node present in the last-applied graph but
    // absent from the new one (with that node's PREVIOUS resolved inputs), and by pruneOrphans for a
    // stamped resource `list` found (with that ListedResource's inputs), so it must work from either.
    // Must be idempotent (the resource may already be gone). A provider without `delete` is left in place
    // and logged (converge-forward).
    readonly delete?: (inputs: ResolvedInputs, ctx: ProviderContext) => Promise<void>;
    // Optional: rename the live resource currently keyed by `oldId` to the node being reconciled (ctx.id),
    // PRESERVING its state, so a renamed node is moved in place rather than orphaned + recreated (which for a
    // stateful resource destroys data). Called once by applyMoves BEFORE reconcile, with the NEW node's inputs
    // (resolved leniently, refs to not-yet-produced outputs are absent). Must be idempotent (the resource may
    // already sit at the new id from a prior run). A type without `restamp` cannot rename in place: applyMoves
    // logs a warning and the rename degrades to prune-old + create-new. Only stamp-keyed resources (whose id is
    // baked into their on-host identity, e.g. a backing's compose project + volume) need it; resources matched
    // by an intrinsic key (a DNS hostname, a repo name) reconcile across a node-id rename untouched.
    readonly restamp?: (oldId: string, inputs: ResolvedInputs, ctx: ProviderContext) => Promise<void>;
}

// A node whose `type` has no registered provider is a hard error at reconcile time.
export type Providers = Partial<Record<ResourceType, Provider>>;
