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
//   canDrive, collaborator and up: start/steer agents, review, comment. A viewer watches.
//   canShip , maintainer and up: full operating authority. Only ownership and its access roster stay separate.
export function useRole(): {
    role: ComputedRef<MemberRole>;
    canDrive: ComputedRef<boolean>;
    canShip: ComputedRef<boolean>;
    isOwner: ComputedRef<boolean>;
} {
    const { active } = useSandbox();
    const role = computed<MemberRole>(() => active.value?.role ?? `owner`);
    return {
        role,
        canDrive: computed(() => roleAtLeast(role.value, `collaborator`)),
        canShip: computed(() => roleAtLeast(role.value, `maintainer`)),
        isOwner: computed(() => role.value === `owner`),
    };
}
