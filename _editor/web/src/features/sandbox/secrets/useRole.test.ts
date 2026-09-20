import { describe, expect, it, vi } from "vitest";
import { computed, ref } from "vue";
import type { MemberRole } from "@intentic/sandbox-contract";

// The four affordance flags per tier, as one table: a desk drives its own chats but never reviews, ships or owns.
const role = ref<MemberRole | undefined>(`owner`);
vi.mock(`../client/useSandbox`, () => ({ useSandbox: () => ({ active: computed(() => (role.value === undefined ? undefined : { role: role.value })) }) }));

const { useRole } = await import(`./useRole`);

describe(`useRole`, () => {
    it(`reads each tier into its affordances`, () => {
        const flags = useRole();
        const read = (): Record<string, boolean> => ({
            isDesk: flags.isDesk.value,
            canDrive: flags.canDrive.value,
            canReview: flags.canReview.value,
            canShip: flags.canShip.value,
            isOwner: flags.isOwner.value,
        });
        role.value = `desk`;
        expect(read()).toEqual({ isDesk: true, canDrive: true, canReview: false, canShip: false, isOwner: false });
        role.value = `viewer`;
        expect(read()).toEqual({ isDesk: false, canDrive: false, canReview: false, canShip: false, isOwner: false });
        role.value = `collaborator`;
        expect(read()).toEqual({ isDesk: false, canDrive: true, canReview: true, canShip: false, isOwner: false });
        role.value = `maintainer`;
        expect(read()).toEqual({ isDesk: false, canDrive: true, canReview: true, canShip: true, isOwner: false });
        role.value = `owner`;
        expect(read()).toEqual({ isDesk: false, canDrive: true, canReview: true, canShip: true, isOwner: true });
    });

    it(`reads as the owner until the summary has loaded`, () => {
        role.value = undefined;
        expect(useRole().role.value).toBe(`owner`);
    });
});
