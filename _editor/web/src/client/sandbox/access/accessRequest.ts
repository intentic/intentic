import type { AccessRequests, AccessWant, MemberSelf } from "@intentic/sandbox-contract/schemas/members";
import { t } from "@intentic/ui/i18n";
import { computed, type ComputedRef, type MaybeRefOrGetter, ref, type Ref, toValue } from "vue";
import { ACCESS_REQUESTS, SANDBOX_SELF_ACCESS } from "../../../lib/queryKeys";
import { queryClient } from "../../../lib/queryPersistence";
import { sandboxRaw } from "../sandboxRaw";
import { supportsRoute } from "../useDaemonRoutes";
import { selfMember } from "../useMembers";
import { useSandboxQuery } from "../useSandboxQuery";
import type { AccessReason } from "./accessReason";

// ASKING THE OWNER FOR WHAT A REFUSAL STOOD IN THE WAY OF (POST /members/requests): the press an access gate or note
// offers, and whether the person has asked already, read off their own access answer so it holds across reloads and
// windows. The owner sees the request beside the roster, and granting the person anything answers it.

/** What a refusal asks the owner for, in a grant's terms; undefined when no grant could change it. */
export const wantOf = (reason: AccessReason): AccessWant | undefined => {
    switch (reason.kind) {
        case `tier`:
            // The owner tier is nobody's to grant; a floor at or under the viewer refuses only a guest.
            if (reason.floor === `owner`) {
                return undefined;
            }
            return reason.floor === `guest` || reason.floor === `viewer` ? `viewer` : reason.floor;
        case `agents-off`:
            return `agents`;
        case `guest`:
            return `viewer`;
        case `area`:
            return `areas`;
        case `ai-accounts`:
            return `aiAccounts`;
        case `org`:
            // An organisation's lock is lifted by its admin, not by the owner's grant.
            return undefined;
    }
};

export interface AccessRequest {
    /** Whether the person has an open request with the owner. */
    readonly asked: ComputedRef<boolean>;
    /** A request is on its way. */
    readonly asking: Ref<boolean>;
    /** Why the last request did not go, in words. */
    readonly failure: Ref<string | undefined>;
    /** Asks the owner for what this refusal stood in the way of, from `place` (as that page is titled). */
    readonly ask: (reason: AccessReason, place: string) => Promise<void>;
}

export const useAccessRequest = (): AccessRequest => {
    const self = selfMember();
    const asking = ref(false);
    const failure = ref<string>();
    const ask = async (reason: AccessReason, place: string): Promise<void> => {
        const want = wantOf(reason);
        if (want === undefined || asking.value) {
            return;
        }
        asking.value = true;
        failure.value = undefined;
        try {
            // The answer is the person's own access, now carrying when they asked: every press in every window reads it.
            queryClient.setQueryData<MemberSelf>(SANDBOX_SELF_ACCESS.of(), await sandboxRaw(`POST /members/requests`, { input: { want, place: place.slice(0, 80) } }));
        } catch {
            failure.value = t(`common.access.askFailed`);
        } finally {
            asking.value = false;
        }
    };
    return { asked: computed(() => self.value?.askedAt !== undefined), asking, failure, ask };
};

// THE SIDE THAT ANSWERS: every open request, read beside the roster (Access ▸ People) by whoever runs people and access,
// and counted on the owner's attention for the sandbox. `enabled` is whether this reader may read them; granting the
// person anything answers theirs on the
// daemon, whose push refreshes this read, and dismissing one answers it without a grant. A daemon from before requests
// has none to read: asked anyway, every page the owner opened logged a failed read (the compat tier, run 40433162504).
export const useAccessRequests = (enabled: MaybeRefOrGetter<boolean>) => {
    const { query, loaded } = useSandboxQuery<AccessRequests>({
        queryKey: ACCESS_REQUESTS.of(),
        queryFn: () => sandboxRaw(`GET /members/requests`),
        enabled: computed(() => toValue(enabled) && supportsRoute(`GET /members/requests`)),
    });
    const dismiss = async (email: string): Promise<void> => {
        queryClient.setQueryData<AccessRequests>(ACCESS_REQUESTS.of(), await sandboxRaw(`DELETE /members/requests`, { input: { email } }));
    };
    return { requests: computed(() => query.data.value?.requests ?? []), loaded, dismiss };
};
