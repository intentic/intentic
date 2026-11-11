import type { AddCapabilityInput } from "@intentic/capability-catalog";
import { allowFleet, type FleetAllowSeams, fleetTokenLabel } from "./fleetAllow";

// One press mints the card's token under the owner's own session and saves it with its platform id; a save that fails
// takes the token back, so the account never holds a live token no card has.

const seams = (save: FleetAllowSeams[`save`]) => {
    const calls: string[] = [];
    const saved: AddCapabilityInput[] = [];
    const fake: FleetAllowSeams = {
        mint: async (label) => {
            calls.push(`mint ${label}`);
            return { id: `tok-1`, token: `itk_minted` };
        },
        revoke: async (tokenId) => {
            calls.push(`revoke ${tokenId}`);
        },
        save: async (input) => {
            saved.push(input);
            await save(input);
        },
    };
    return { fake, calls, saved };
};

test(`the token is named after the card and this sandbox, within the platform's 80 characters`, () => {
    expect(fleetTokenLabel(`storefront`)).toBe(`Sandbox fleet: storefront`);
    expect(fleetTokenLabel(`  `)).toBe(`Sandbox fleet: this sandbox`);
    expect(fleetTokenLabel(`x`.repeat(120))).toHaveLength(80);
});

test(`Allow mints, then saves the token with its platform id to the card`, async () => {
    const { fake, calls, saved } = seams(async () => undefined);
    await allowFleet(fake, `fleet`, `Sandbox fleet: storefront`);
    expect(calls).toEqual([`mint Sandbox fleet: storefront`]);
    expect(saved).toEqual([{ id: `fleet`, kind: `fleet`, config: { token: `itk_minted`, tokenId: `tok-1` } }]);
});

test(`a save the sandbox refuses revokes the token it minted, and says the sandbox's refusal`, async () => {
    const { fake, calls } = seams(async () => {
        throw new Error(`the sandbox is restarting`);
    });
    await expect(allowFleet(fake, `fleet`, `Sandbox fleet: storefront`)).rejects.toThrow(`the sandbox is restarting`);
    expect(calls).toEqual([`mint Sandbox fleet: storefront`, `revoke tok-1`]);
});
