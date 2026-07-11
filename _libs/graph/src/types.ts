// The desired-state intermediate representation for intentic-deploy. This layer is product-agnostic:
// it defines refs, secrets, readiness, and the serializable graph, but knows nothing about which kinds
// of resource exist. A resource node's `type` is an opaque `string` here — the resolver layer owns the
// closed vocabulary of kinds and guarantees only valid ones are emitted.

export interface Ref<T> {
    readonly kind: "ref";
    readonly resourceId: string;
    readonly output?: string;
    readonly __type?: T;
}

// Where a secret's value comes from: "env" — supplied by the user in the environment; "generated" —
// intentic creates and persists it (admin credentials for services intentic itself provisions).
export type SecretSource = "env" | "generated";

export interface SecretRef {
    readonly kind: "secret";
    readonly source: SecretSource;
    readonly key: string;
}

export interface Readiness {
    readonly kind: "readiness";
    readonly check: "httpOk";
    readonly url: string | Ref<string>;
    readonly timeout?: string;
    readonly status?: number;
}

export type Input<T> = T | Ref<T> | (T extends string ? SecretRef : never);

// --- Pre-compilation node (emitted by a resolver, consumed by the compiler) ---

export interface RawNode {
    readonly id: string;
    readonly type: string;
    readonly inputs: Readonly<Record<string, unknown>>;
    readonly explicitDependsOn: readonly string[];
    readonly readyWhen?: Readiness;
}

// --- Compiled desired-state graph (the serializable output) ---

export type SerializedValue =
    | string
    | number
    | boolean
    | { readonly $ref: string }
    | { readonly $secret: { readonly source: SecretSource; readonly key: string } }
    | readonly SerializedValue[]
    | { readonly [key: string]: SerializedValue };

export interface SerializedReadiness {
    readonly check: "httpOk";
    readonly url: string | { readonly $ref: string };
    readonly timeout?: string;
    readonly status?: number;
}

export interface ResourceNode {
    readonly id: string;
    readonly type: string;
    readonly inputs: Readonly<Record<string, SerializedValue>>;
    readonly dependsOn: readonly string[];
    readonly readyWhen?: SerializedReadiness;
}

// A rename: the resource previously addressed as `from` is the same resource now addressed as `to`. Authored
// when a node id changes, consumed once before reconcile to re-stamp the live resource in place (preserving
// its data) rather than orphaning the old id and creating the new one from scratch.
export interface Move {
    readonly from: string;
    readonly to: string;
}

export interface DesiredStateGraph {
    readonly version: 1;
    readonly resources: Readonly<Record<string, ResourceNode>>;
    // Renames to reconcile before this apply. Optional: most artifacts have none.
    readonly moved?: readonly Move[];
}
