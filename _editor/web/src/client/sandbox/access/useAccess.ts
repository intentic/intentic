import type { MemberRole } from "@intentic/sandbox-contract/schemas/shared";
import { type RawRouteKey, rawRoutePath } from "@intentic/sandbox-contract/protocol/raw/raw-routes";
import { holdsRight, type ManageRight, type MemberSelf } from "@intentic/sandbox-contract/schemas/members";
import { computed, type ComputedRef, effectScope } from "vue";
import { SANDBOX_SELF_ACCESS } from "../../../lib/queryKeys";
import { queryClient } from "../../../lib/queryPersistence";
import { accessPolicy, contractModule } from "../daemon/contract";
import type { ProcedureName } from "../sandboxRpc";
import { selfMember } from "../useMembers";
import { useSandbox } from "../useSandbox";
import { type AccessReason, reasonOfRefusal } from "./accessReason";
import { forecastWith } from "./forecast";

// WHAT THE SIGNED-IN PERSON MAY DO ON THE ACTIVE SANDBOX, asked of the same check the daemon refuses with
// (sandbox-contract protocol/member-reach.ts) over the same facts: their tier, whether they run agents, their areas and
// whether they land. A view asks it before offering something, and the fetch layer asks it before sending (forecast.ts),
// so a request the daemon would refuse is never sent and nothing is drawn that would only be refused.
//
// Until both the person's tier and the check have loaded, nothing is known: `known` is false and every question
// answers "no reason", which a view reads together with `known` (a gate waits, an action stays out). The fetch layer
// sends as it always did meanwhile, and the daemon still decides.

/** A route by the name the contract gives it: a procedure (`capabilities.list`) or a raw route (`GET /members`). */
export type AccessRoute = ProcedureName | RawRouteKey;

/** The values of the `{param}` segments a route's path names (`{ id }` for `/agents/{id}/land`), where the floor turns on them. */
export type RouteParams = Readonly<Record<string, string>>;

// A raw route's key is its method and path; a procedure's name has no space.
const isRawKey = (route: AccessRoute): route is RawRouteKey => route.includes(` `);

// The person's facts, built on first use rather than at load: a module that imports this one must not stand up the
// sandbox list and the daemon's own answer just by being imported.
interface AccessState {
    readonly active: ReturnType<typeof useSandbox>[`active`];
    readonly refresh: () => void;
    readonly role: ComputedRef<MemberRole | undefined>;
    readonly caller: ComputedRef<Caller | undefined>;
    readonly known: ComputedRef<boolean>;
}

// What the check reads of the person (sandbox-contract protocol/member-reach.ts `memberRefusal`).
interface Caller {
    readonly role: MemberRole;
    readonly areas?: readonly string[] | undefined;
    readonly agents?: MemberSelf[`agents`] | undefined;
    readonly lands?: true | undefined;
    // The parts of the sandbox they were given besides their own work, which open a route's floor to them (`right`).
    readonly manages?: MemberSelf[`manages`] | undefined;
}

// allow(module-state): the signed-in person's access, one for the page, built once on first use
let state: AccessState | undefined;

const build = (): AccessState => {
    const sandbox = useSandbox();
    const self = selfMember();
    // The tier the daemon itself reports wins over the platform's record of it, which can lag a change by a reconnect.
    const role = computed<MemberRole | undefined>(() => self.value?.role ?? sandbox.active.value?.role ?? undefined);
    // The facts the check reads. Before the daemon's own answer lands (it is read for every tier but the owner's),
    // the tier alone: the floor answers by it, and whether agents run only ever narrows a collaborator-floor route further.
    const caller = computed((): Caller | undefined => {
        const tier = role.value;
        if (tier === undefined) {
            return undefined;
        }
        const answer = self.value;
        return { role: tier, areas: answer?.areas, agents: answer?.agents, lands: answer?.lands === true ? true : undefined, manages: answer?.manages };
    });
    const known = computed(() => caller.value !== undefined && accessPolicy.value !== undefined && contractModule.value !== undefined);
    return { active: sandbox.active, refresh: () => void sandbox.refresh(), role, caller, known };
};

const stateOf = (): AccessState => {
    state ??= effectScope(true).run(build);
    // SAFETY: `run` on a detached scope that is active answers what its callback returned, which is always a state here.
    return state as AccessState;
};

// The method and path a route is called with, its `{param}` segments filled from `params` where it names them.
const requestOf = (route: AccessRoute, params: RouteParams | undefined): { readonly method: string; readonly path: string } | undefined => {
    if (isRawKey(route)) {
        return { method: route.slice(0, route.indexOf(` `)), path: rawRoutePath(route) };
    }
    return contractModule.value?.sandboxRequestFor(route.split(`.`), params);
};

/** Why the person may not make this call here, or undefined when they may or when it is not known yet (`known`). */
const refusalOf = (route: AccessRoute, params?: RouteParams): AccessReason | undefined => {
    const facts = stateOf().caller.value;
    const policy = accessPolicy.value;
    const request = requestOf(route, params);
    if (facts === undefined || policy === undefined || request === undefined) {
        return undefined;
    }
    const refusal = policy.memberRefusal(facts, request.method, request.path);
    return refusal === undefined ? undefined : reasonOfRefusal(refusal);
};

// Asks again for what the person may do: the daemon refused something the editor thought they could, so its record of
// their access is older than the daemon's. At most once per window, since every refused request of a stale page says so.
const REFRESH_WINDOW_MS = 10_000;
// allow(module-state): when access was last asked for again, so a burst of refusals asks once
let refreshedAt = Number.NEGATIVE_INFINITY;
const refreshAccess = (): void => {
    const now = Date.now();
    if (now - refreshedAt < REFRESH_WINDOW_MS) {
        return;
    }
    refreshedAt = now;
    void queryClient.invalidateQueries({ queryKey: SANDBOX_SELF_ACCESS.of() });
    // The platform's record of the tier, which is all there is for the owner's, whose own answer is never read.
    stateOf().refresh();
};

// The fetch layer's question: only for the active sandbox, whose person this is, and only once the answer is known.
forecastWith((sandboxId, method, path, target) => {
    const { active, caller } = stateOf();
    const facts = caller.value;
    const policy = accessPolicy.value;
    if (sandboxId === undefined || sandboxId !== active.value?.id || facts === undefined || policy === undefined) {
        return undefined;
    }
    return policy.memberRefusal(facts, method, path, target);
}, refreshAccess);

export interface Access {
    /** Whether the person's access has loaded; until it has, `refusal` answers undefined for everything. */
    readonly known: ComputedRef<boolean>;
    /** Their tier on the active sandbox, undefined until it is known. */
    readonly role: ComputedRef<MemberRole | undefined>;
    /** Why they may not make this call, or undefined when they may (or it is not known yet). Reactive inside a computed. */
    readonly refusal: (route: AccessRoute, params?: RouteParams) => AccessReason | undefined;
    /** Whether they may make this call: known, and nothing refuses it. */
    readonly can: (route: AccessRoute, params?: RouteParams) => boolean;
    /**
     * Whether they run this part of the sandbox (sandbox-contract `holdsRight`): the owner and Full access every part,
     * anyone else the parts their row names. Read off their tier and their own answer alone, so it is known as soon as
     * the tier is, before the contract the route check reads has loaded. Reactive inside a computed.
     */
    readonly holds: (right: ManageRight) => boolean;
}

// The tier and the rights their own answer names; the owner's answer is never read, and the owner holds every right.
const holdsOf = (right: ManageRight): boolean => {
    const facts = stateOf().caller.value;
    return facts !== undefined && holdsRight(facts, right);
};

export const useAccess = (): Access => {
    const { known, role } = stateOf();
    return { known, role, refusal: refusalOf, can: (route, params) => known.value && refusalOf(route, params) === undefined, holds: holdsOf };
};
