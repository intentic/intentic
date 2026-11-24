import type { SandboxSummary } from "@intentic/api-contract";
import { computed, type ComputedRef, hasInjectionContext, inject, type MaybeRefOrGetter, provide, type Ref, toValue } from "vue";
import { activeSandboxId } from "../../../app/storage/activeSandbox";
import { rpcKey, rpcKeyAt } from "../../../lib/queryKeys";
import { rpcQuery, type RpcQueryOptions } from "../rpcQuery";
import { type ProcedureInput, type ProcedureName, type SandboxRpc, sandboxRpc } from "../sandboxRpc";
import { supportsRouteAt } from "../useDaemonRoutes";
import { useSandbox } from "../useSandbox";
import { aimedRpc } from "./aimedRpc";
import { perSandbox } from "./perSandbox";
import { SANDBOX_SCOPE } from "./sandboxScopeKey";

export { SANDBOX_SCOPE } from "./sandboxScopeKey";

// WHICH SANDBOX A PIECE OF THE EDITOR SPEAKS OF. The window has one active sandbox (app/storage/activeSandbox.ts), and
// everything written before this reads it by default: `sandboxRpc` aims there, `rpcKey` keys there, `supportsRoute`
// answers for its daemon. A scope names a sandbox once and hands out the same four doors aimed at it, so a composable
// that takes `useSandboxScope()` reads and writes the sandbox its component stands in (an `<InSandbox>` around a Home
// tile), and the active one wherever nothing provided another. The active sandbox is never a second entry: a scope of
// the active id aims nowhere (`at()` is undefined) and keys as `rpcKey` does, so one read is one cache entry and one call.

export interface SandboxScope {
    readonly id: Readonly<Ref<string | undefined>>;
    // The id to aim a call or a read at, undefined while the scope's sandbox is the active one (or none is chosen).
    readonly at: () => string | undefined;
    // True only for the active sandbox's own scope, which moves with every switch.
    readonly followsActive: boolean;
    readonly summary: ComputedRef<SandboxSummary | undefined>;
    // Proven reachable by a live connection: only the active sandbox has one, so another sandbox reads false here and
    // finds out by asking (a failed read is its unreachability).
    readonly reachable: Readonly<Ref<boolean>>;
    // The app's client aimed at this sandbox: `sandboxRpc` itself for the active scope; for another, every call aimed
    // with `at` and paced as background (nobody waits on it, so it never raises a sign-in).
    readonly rpc: SandboxRpc;
    readonly supportsRoute: (name: string) => boolean;
    // The query key of a procedure's read in this sandbox, the same entry `rpcKey` names for the active one.
    readonly key: (procedure: ProcedureName, input?: unknown, ...marks: unknown[]) => unknown[];
    // `rpcQuery` aimed and paced as this scope is: for a scope other than the active sandbox's, a background read and an
    // ambient one, neither retried nor reported when that sandbox is asleep (queryPersistence.ts AMBIENT_READ).
    readonly query: typeof rpcQuery;
}

const { sandboxes, reachable: activeReachable } = useSandbox();

const summaryOf = (id: () => string | undefined): ComputedRef<SandboxSummary | undefined> =>
    computed(() => {
        const wanted = id();
        return wanted === undefined ? undefined : sandboxes.value.find((box) => box.id === wanted);
    });

// SAFETY: the bound version takes exactly rpcQuery's arguments and only fills in the `at` and `background` the caller
// left out, so it keeps rpcQuery's own signature.
const boundQuery = (at: () => string | undefined): typeof rpcQuery =>
    ((procedure: ProcedureName, input?: ProcedureInput<ProcedureName>, options: RpcQueryOptions = {}) =>
        rpcQuery(procedure, input as never, { at, background: true, ambient: true, ...options })) as typeof rpcQuery;

const scopeOver = (id: Readonly<Ref<string | undefined>>): SandboxScope => {
    const at = (): string | undefined => (id.value === activeSandboxId.value ? undefined : id.value);
    return {
        id,
        at,
        followsActive: false,
        summary: summaryOf(() => id.value),
        reachable: computed(() => at() === undefined && id.value !== undefined && activeReachable.value),
        rpc: aimedRpc(at, { background: true }),
        supportsRoute: (name) => supportsRouteAt(id.value, name),
        // An id's key equals `rpcKey`'s while it is the active one (queryKeys.ts), so naming it is one entry either way.
        key: (procedure, input, ...marks) => (id.value === undefined ? rpcKey(procedure, input, ...marks) : rpcKeyAt(id.value, procedure, input, ...marks)),
        query: boundQuery(at),
    };
};

/** The active sandbox's scope: what every reader outside an `<InSandbox>` speaks of, and what moves with a switch. */
export const activeSandboxScope: SandboxScope = {
    id: activeSandboxId,
    at: () => undefined,
    followsActive: true,
    summary: summaryOf(() => activeSandboxId.value),
    reachable: activeReachable,
    rpc: sandboxRpc,
    supportsRoute: (name) => supportsRouteAt(undefined, name),
    key: rpcKey,
    query: rpcQuery,
};

const named = perSandbox((id) => scopeOver(computed(() => id)));

/** The scope of sandbox `id`, one per id for the window's life, so every reader of it shares its keys and its calls. */
export const sandboxScopeOf = (id: string): SandboxScope => named.of(id);

/**
 * Provides the scope of `id` to everything this component renders, and answers it. Undefined names the active sandbox,
 * so a parent whose id is not known yet aims nothing elsewhere.
 */
export const provideSandboxScope = (id: MaybeRefOrGetter<string | undefined>): SandboxScope => {
    const scope = scopeOver(computed(() => toValue(id) ?? activeSandboxId.value));
    provide(SANDBOX_SCOPE, scope);
    return scope;
};

/** The scope the calling component stands in: the nearest `<InSandbox>`'s, else the active sandbox's. */
export const useSandboxScope = (): SandboxScope => (hasInjectionContext() ? inject(SANDBOX_SCOPE, activeSandboxScope) : activeSandboxScope);
