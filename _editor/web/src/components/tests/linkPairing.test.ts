import { linkCardId, preferredSandbox } from "../linkPairing";

// The sandbox an agent's link ask names, found among the reader's others however the agent spelled it.

const sandboxes = [
    { id: `7e8d0ffa8bed`, name: `Ops box`, daemonUrl: `https://sandbox-7e8d0ffa8bed.radarsu.com` },
    { id: `da29324afede`, name: `client`, daemonUrl: `https://sandbox-da29324afede.radarsu.com` },
    { id: `ca724a4618f7`, name: `Client`, daemonUrl: null },
];

describe(`preferredSandbox`, () => {
    it(`finds one by its name, its card id, its id or its address`, () => {
        expect(preferredSandbox(sandboxes, `Ops box`)?.id).toBe(`7e8d0ffa8bed`);
        expect(preferredSandbox(sandboxes, linkCardId(`Ops box`))?.id).toBe(`7e8d0ffa8bed`);
        expect(preferredSandbox(sandboxes, `7E8D0FFA8BED`)?.id).toBe(`7e8d0ffa8bed`);
        expect(preferredSandbox(sandboxes, `https://sandbox-da29324afede.radarsu.com/`)?.id).toBe(`da29324afede`);
        expect(preferredSandbox(sandboxes, `sandbox-da29324afede.radarsu.com`)?.id).toBe(`da29324afede`);
    });

    it(`chooses nothing when nothing, or more than one, answers to it`, () => {
        expect(preferredSandbox(sandboxes, undefined)).toBeUndefined();
        expect(preferredSandbox(sandboxes, ` `)).toBeUndefined();
        expect(preferredSandbox(sandboxes, `staging`)).toBeUndefined();
        expect(preferredSandbox(sandboxes, `client`)).toBeUndefined();
    });
});
