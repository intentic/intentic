import { describe, expect, it } from "vitest";
import { CONTAINER_REQUIREMENTS, containerDrift } from "./container-requirements.js";

// Healthy baseline: every case below removes one piece of it to produce a gap.
const CURRENT = {
    SANDBOX_PUBLIC_URL: "https://sandbox-0738cd6b5027.sbx.intentic.dev",
    SANDBOX_GRANT: "ig1.eyJzdWIiOiIwNzM4Y2Q2YjUwMjcifQ.sig",
    INGRESS_URL: "https://ingress.intentic.dev",
};

describe(`containerDrift`, () => {
    it(`says nothing about a container set up by a current release`, () => {
        expect(containerDrift(CURRENT)).toEqual([]);
    });

    it(`names both keys a pre-migration container is missing, and what that costs`, () => {
        const gaps = containerDrift({ SANDBOX_PUBLIC_URL: CURRENT.SANDBOX_PUBLIC_URL });
        expect(gaps).toHaveLength(1);
        expect(gaps[0]?.key).toBe(`reachability`);
        expect(gaps[0]?.missing).toEqual([`SANDBOX_GRANT`, `INGRESS_URL`]);
        expect(gaps[0]?.repair).toContain(`setup command`);
    });

    it(`reports only the half that is actually gone`, () => {
        expect(containerDrift({ ...CURRENT, INGRESS_URL: undefined })[0]?.missing).toEqual([`INGRESS_URL`]);
        expect(containerDrift({ ...CURRENT, SANDBOX_GRANT: undefined })[0]?.missing).toEqual([`SANDBOX_GRANT`]);
    });

    // Blank must count as missing: it is indistinguishable from a dropped value replayed through `-e NAME=`.
    it(`counts blank and whitespace-only values as missing, not as set`, () => {
        expect(containerDrift({ ...CURRENT, SANDBOX_GRANT: `` })[0]?.missing).toEqual([`SANDBOX_GRANT`]);
        expect(containerDrift({ ...CURRENT, SANDBOX_GRANT: `   ` })[0]?.missing).toEqual([`SANDBOX_GRANT`]);
    });

    // No public address means no evidence of intent, so nothing is reported as missing.
    it(`asks nothing of a sandbox that offers no evidence it was meant to be reachable`, () => {
        expect(containerDrift({})).toEqual([]);
        expect(containerDrift({ CONNECT_TOKEN: `tok`, WORKSPACE_ROOT: `/work` })).toEqual([]);
        expect(containerDrift({ SANDBOX_PUBLIC_URL: `` })).toEqual([]);
    });

    // A hosted Fly microVM has no grant by design, so this reports nothing on it.
    it(`stays quiet on a hosted machine, which serves its address without dialling out`, () => {
        expect(containerDrift({ SANDBOX_PUBLIC_URL: CURRENT.SANDBOX_PUBLIC_URL, SANDBOX_VM: `1` })).toEqual([]);
    });
});

describe(`CONTAINER_REQUIREMENTS`, () => {
    it(`keys every row uniquely, so a UI can key and dedupe on it`, () => {
        const keys = CONTAINER_REQUIREMENTS.map((requirement) => requirement.key);
        expect(new Set(keys).size).toBe(keys.length);
    });

    // Overlapping `given`/`requires` would make the row impossible to fire.
    // Empty `given` would make the row fire on every sandbox in the fleet.
    it(`states evidence that is separate from what it demands`, () => {
        for (const requirement of CONTAINER_REQUIREMENTS) {
            expect(requirement.given.length).toBeGreaterThan(0);
            expect(requirement.requires.length).toBeGreaterThan(0);
            expect(requirement.given.filter((name) => requirement.requires.includes(name))).toEqual([]);
        }
    });

    // Rendered verbatim in the product, so an empty string is a blank card, not just a missing test value.
    it(`words every row for the person who has to fix it`, () => {
        for (const requirement of CONTAINER_REQUIREMENTS) {
            expect(requirement.enables.length).toBeGreaterThan(0);
            expect(requirement.lost.length).toBeGreaterThan(0);
            expect(requirement.repair.length).toBeGreaterThan(0);
        }
    });
});
