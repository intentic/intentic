import type { MemberTier } from "@intentic/sandbox-contract/schemas/shared";
import { tierAtLeast } from "@intentic/sandbox-contract/schemas/shared";
import { computed, type ComputedRef } from "vue";
import { selfAgents, selfLands } from "./useMembers";
import { useAccess } from "./access/useAccess";

// Client affordances only; server tier floors authorize every route. Default owner until summary loads, then derive the active sandbox's tier.
// Guests see assigned roles/home and may drive their chats; home-only guests land only with lands permission.
// Drive/review also check agents access (guests never review); write needs writer+, ship needs maintainer+.
// Writer area fences remain server-owned: exposing a file verb does not grant access outside permitted areas.
// (Called useRole until 2026-11-18, when personas were renamed roles.)

/** What the signed-in person's tier lets this page offer. */
export interface TierAffordances {
    readonly tier: ComputedRef<MemberTier>;
    readonly isGuest: ComputedRef<boolean>;
    readonly homeOnly: ComputedRef<boolean>;
    readonly canLandHome: ComputedRef<boolean>;
    readonly canDrive: ComputedRef<boolean>;
    readonly canReview: ComputedRef<boolean>;
    readonly canWrite: ComputedRef<boolean>;
    readonly canShip: ComputedRef<boolean>;
    readonly isOwner: ComputedRef<boolean>;
}

export function useTier(): TierAffordances {
    // The tier the daemon reports, else the platform's record of it (access/useAccess.ts). Still read as the owner until
    // either has loaded, as before: the surfaces that branch on these booleans redirect on them, and an owner's deep link
    // must not be sent away during the moment nothing is known. What may be SENT is decided by the access check itself.
    const access = useAccess();
    const tier = computed<MemberTier>(() => access.tier.value ?? `owner`);
    const isGuest = computed(() => tier.value === `guest`);
    const agents = selfAgents();
    const lands = selfLands();
    const homeOnly = computed(() => isGuest.value && agents.value === `home`);
    const canShip = computed(() => tierAtLeast(tier.value, `maintainer`));
    const canReview = computed(() => tierAtLeast(tier.value, `collaborator`) && !(tier.value === `writer` && agents.value === `off`));
    return {
        tier,
        isGuest,
        homeOnly,
        canLandHome: computed(() => canShip.value || (homeOnly.value && lands.value)),
        canDrive: computed(() => isGuest.value || canReview.value),
        canReview,
        canWrite: computed(() => tierAtLeast(tier.value, `writer`)),
        canShip,
        isOwner: computed(() => tier.value === `owner`),
    };
}
