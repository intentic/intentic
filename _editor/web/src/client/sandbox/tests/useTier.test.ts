import { computed, ref } from "vue";
import type { MemberTier } from "@intentic/sandbox-contract/schemas/shared";

// The four affordance flags per tier, as one table: a guest drives its own chats but never reviews, ships or owns.
const tier = ref<MemberTier | undefined>(`owner`);
jest.mock(`../useSandbox`, () => ({
    useSandbox: () => ({ active: computed(() => (tier.value === undefined ? undefined : { tier: tier.value })) }),
}));

// Whether the signed-in writer's grant runs agents, and whether a home-only guest's work lands by itself: neither is
// said by the tier alone.
const agents = ref<string | undefined>(undefined);
const lands = ref(false);
jest.mock(`../useMembers`, () => ({
    selfAgents: () => computed(() => agents.value),
    selfLands: () => computed(() => lands.value),
    selfMember: () => computed(() => undefined),
}));

const { useTier } = await import(`../useTier`);

describe(`useTier`, () => {
    it(`reads each tier into its affordances`, () => {
        const flags = useTier();
        const read = () => ({
            isGuest: flags.isGuest.value,
            canDrive: flags.canDrive.value,
            canReview: flags.canReview.value,
            canShip: flags.canShip.value,
            isOwner: flags.isOwner.value,
        });
        tier.value = `guest`;
        expect(read()).toEqual({ isGuest: true, canDrive: true, canReview: false, canShip: false, isOwner: false });
        tier.value = `viewer`;
        expect(read()).toEqual({ isGuest: false, canDrive: false, canReview: false, canShip: false, isOwner: false });
        tier.value = `collaborator`;
        expect(read()).toEqual({ isGuest: false, canDrive: true, canReview: true, canShip: false, isOwner: false });
        tier.value = `maintainer`;
        expect(read()).toEqual({ isGuest: false, canDrive: true, canReview: true, canShip: true, isOwner: false });
        tier.value = `owner`;
        expect(read()).toEqual({ isGuest: false, canDrive: true, canReview: true, canShip: true, isOwner: true });
    });

    // A writer edits files by hand; whether it also drives agents is its own grant's answer, read for that tier alone.
    it(`keeps a writer with agents off from driving or reviewing`, () => {
        const flags = useTier();
        tier.value = `writer`;
        agents.value = `run`;
        expect([flags.canDrive.value, flags.canReview.value, flags.canWrite.value]).toEqual([true, true, true]);
        agents.value = `off`;
        expect([flags.canDrive.value, flags.canReview.value, flags.canWrite.value]).toEqual([false, false, true]);
        agents.value = undefined;
    });

    // A guest whose way in is its home conversation alone lands that home's work only when granted `lands`; a
    // maintainer and up lands it by its tier, granted or not.
    it(`lets a home-only guest land its home only when granted, and a maintainer always`, () => {
        const flags = useTier();
        tier.value = `guest`;
        agents.value = `home`;
        expect([flags.homeOnly.value, flags.canLandHome.value]).toEqual([true, false]);
        lands.value = true;
        expect([flags.homeOnly.value, flags.canLandHome.value]).toEqual([true, true]);
        agents.value = undefined;
        expect([flags.homeOnly.value, flags.canLandHome.value]).toEqual([false, false]);
        lands.value = false;
        tier.value = `maintainer`;
        expect([flags.homeOnly.value, flags.canLandHome.value]).toEqual([false, true]);
        tier.value = `owner`;
    });

    it(`reads as the owner until the summary has loaded`, () => {
        tier.value = undefined;
        expect(useTier().tier.value).toBe(`owner`);
    });
});
