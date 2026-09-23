import { computed, ref } from "vue";
import type { MemberRole } from "@intentic/sandbox-contract";

// The four affordance flags per tier, as one table: a guest drives its own chats but never reviews, ships or owns.
const role = ref<MemberRole | undefined>(`owner`);
jest.mock(`../client/useSandbox`, () => ({
    useSandbox: () => ({ active: computed(() => (role.value === undefined ? undefined : { role: role.value })) }),
}));

const { useRole } = await import(`./useRole`);

describe(`useRole`, () => {
    it(`reads each tier into its affordances`, () => {
        const flags = useRole();
        const read = (): Record<string, boolean> => ({
            isGuest: flags.isGuest.value,
            canDrive: flags.canDrive.value,
            canReview: flags.canReview.value,
            canShip: flags.canShip.value,
            isOwner: flags.isOwner.value,
        });
        role.value = `guest`;
        expect(read()).toEqual({ isGuest: true, canDrive: true, canReview: false, canShip: false, isOwner: false });
        role.value = `viewer`;
        expect(read()).toEqual({ isGuest: false, canDrive: false, canReview: false, canShip: false, isOwner: false });
        role.value = `collaborator`;
        expect(read()).toEqual({ isGuest: false, canDrive: true, canReview: true, canShip: false, isOwner: false });
        role.value = `maintainer`;
        expect(read()).toEqual({ isGuest: false, canDrive: true, canReview: true, canShip: true, isOwner: false });
        role.value = `owner`;
        expect(read()).toEqual({ isGuest: false, canDrive: true, canReview: true, canShip: true, isOwner: true });
    });

    it(`reads as the owner until the summary has loaded`, () => {
        role.value = undefined;
        expect(useRole().role.value).toBe(`owner`);
    });
});
