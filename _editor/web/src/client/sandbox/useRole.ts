import type { MemberRole } from "@intentic/sandbox-contract/schemas/shared";
import { roleAtLeast } from "@intentic/sandbox-contract/schemas/shared";
import { computed, type ComputedRef } from "vue";
import { selfAgents } from "./useMembers";
import { useSandbox } from "./useSandbox";

// The signed-in user's trust tier on the active sandbox, and the two affordance flags derived from it.
//
// Client-side gating only: every route is independently floored server-side (auth/role-floor.ts), so a wrong
// reading here changes what renders, never what is allowed. Defaults to `owner` until the summary loads, corrected on
// the first call.
//
//   isGuest   , the tier below viewer: talks to the persona cards it holds, and is shown nothing else of the box.
//   canDrive , a guest (its own chats) or collaborator and up: start/steer agents. A viewer watches, and so does a
//              writer whose grant has agents off (useMembers.ts `selfAgents`), which its tier alone does not say.
//   canReview, collaborator and up, agents on: review work and ask for a landing. A guest drives but never reviews.
//   canWrite , writer and up: change files in the tree. WHERE is the fence's answer, which only the daemon holds, so
//              a writer is offered the verbs and meets a refusal outside its areas.
//   canShip  , maintainer and up: full operating authority. Only ownership and its access roster stay separate.
export function useRole(): {
    role: ComputedRef<MemberRole>;
    isGuest: ComputedRef<boolean>;
    canDrive: ComputedRef<boolean>;
    canReview: ComputedRef<boolean>;
    canWrite: ComputedRef<boolean>;
    canShip: ComputedRef<boolean>;
    isOwner: ComputedRef<boolean>;
} {
    const { active } = useSandbox();
    const role = computed<MemberRole>(() => active.value?.role ?? `owner`);
    const isGuest = computed(() => role.value === `guest`);
    const agents = selfAgents();
    const canReview = computed(() => roleAtLeast(role.value, `collaborator`) && !(role.value === `writer` && agents.value === `off`));
    return {
        role,
        isGuest,
        canDrive: computed(() => isGuest.value || canReview.value),
        canReview,
        canWrite: computed(() => roleAtLeast(role.value, `writer`)),
        canShip: computed(() => roleAtLeast(role.value, `maintainer`)),
        isOwner: computed(() => role.value === `owner`),
    };
}
