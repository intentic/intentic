import type { MemberRole } from "@intentic/sandbox-contract";
import { roleAtLeast } from "@intentic/sandbox-contract";
import { computed, type ComputedRef } from "vue";
import { useSandbox } from "../client/useSandbox";

// The signed-in user's trust tier on the active sandbox, and the two affordance flags derived from it.
//
// Client-side gating only: every route is independently floored server-side (auth/role-floor.ts), so a wrong
// reading here changes what renders, never what is allowed. Defaults to `owner` until the summary loads, corrected on
// the first call.
//
//   isDesk   , the tier below viewer: talks to the persona cards it holds, and is shown nothing else of the box.
//   canDrive , a desk (its own chats) or collaborator and up: start/steer agents. A viewer watches.
//   canReview, collaborator and up: review work and ask for a landing. A desk drives but never reviews.
//   canWrite , writer and up: change files in the tree. WHERE is the fence's answer, which only the daemon holds, so
//              a writer is offered the verbs and meets a refusal outside its areas.
//   canShip  , maintainer and up: full operating authority. Only ownership and its access roster stay separate.
export function useRole(): {
    role: ComputedRef<MemberRole>;
    isDesk: ComputedRef<boolean>;
    canDrive: ComputedRef<boolean>;
    canReview: ComputedRef<boolean>;
    canWrite: ComputedRef<boolean>;
    canShip: ComputedRef<boolean>;
    isOwner: ComputedRef<boolean>;
} {
    const { active } = useSandbox();
    const role = computed<MemberRole>(() => active.value?.role ?? `owner`);
    const isDesk = computed(() => role.value === `desk`);
    const canReview = computed(() => roleAtLeast(role.value, `collaborator`));
    return {
        role,
        isDesk,
        canDrive: computed(() => isDesk.value || canReview.value),
        canReview,
        canWrite: computed(() => roleAtLeast(role.value, `writer`)),
        canShip: computed(() => roleAtLeast(role.value, `maintainer`)),
        isOwner: computed(() => role.value === `owner`),
    };
}
