import type { MemberRole } from "@intentic/sandbox-contract/schemas/shared";
import { roleAtLeast } from "@intentic/sandbox-contract/schemas/shared";
import { computed, type ComputedRef } from "vue";
import { selfAgents, selfLands } from "./useMembers";
import { useAccess } from "./access/useAccess";

// Client affordances only; server role floors authorize every route. Default owner until summary loads, then derive the active sandbox's tier.
// Guests see assigned personas/home and may drive their chats; home-only guests land only with lands permission.
// Drive/review also check agents access (guests never review); write needs writer+, ship needs maintainer+.
// Writer area fences remain server-owned: exposing a file verb does not grant access outside permitted areas.
export function useRole(): {
    role: ComputedRef<MemberRole>;
    isGuest: ComputedRef<boolean>;
    homeOnly: ComputedRef<boolean>;
    canLandHome: ComputedRef<boolean>;
    canDrive: ComputedRef<boolean>;
    canReview: ComputedRef<boolean>;
    canWrite: ComputedRef<boolean>;
    canShip: ComputedRef<boolean>;
    isOwner: ComputedRef<boolean>;
} {
    // The tier the daemon reports, else the platform's record of it (access/useAccess.ts). Still read as the owner until
    // either has loaded, as before: the surfaces that branch on these booleans redirect on them, and an owner's deep link
    // must not be sent away during the moment nothing is known. What may be SENT is decided by the access check itself.
    const access = useAccess();
    const role = computed<MemberRole>(() => access.role.value ?? `owner`);
    const isGuest = computed(() => role.value === `guest`);
    const agents = selfAgents();
    const lands = selfLands();
    const homeOnly = computed(() => isGuest.value && agents.value === `home`);
    const canShip = computed(() => roleAtLeast(role.value, `maintainer`));
    const canReview = computed(() => roleAtLeast(role.value, `collaborator`) && !(role.value === `writer` && agents.value === `off`));
    return {
        role,
        isGuest,
        homeOnly,
        canLandHome: computed(() => canShip.value || (homeOnly.value && lands.value)),
        canDrive: computed(() => isGuest.value || canReview.value),
        canReview,
        canWrite: computed(() => roleAtLeast(role.value, `writer`)),
        canShip,
        isOwner: computed(() => role.value === `owner`),
    };
}
