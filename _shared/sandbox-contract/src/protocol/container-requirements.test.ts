import { describe, expect, it } from "vitest";
import { CONTAINER_REQUIREMENTS, containerDrift } from "./container-requirements.js";

/* The container this table describes as healthy: a public address AND the pair that serves it. Every case below
 * is this one with something taken away, which is the only way a real container ever reaches a gap. */
const CURRENT = {
    SANDBOX_PUBLIC_URL: "https://sandbox-0738cd6b5027.sbx.intentic.dev",
    SANDBOX_GRANT: "ig1.eyJzdWIiOiIwNzM4Y2Q2YjUwMjcifQ.sig",
    INGRESS_URL: "https://ingress.intentic.dev",
};

describe(`containerDrift`, () => {
    it(`says nothing about a container set up by a current release`, () => {
        expect(containerDrift(CURRENT)).toEqual([]);
    });

    /* THE BUG THIS EXISTS FOR, spelled as the container actually looked: connected before the reachability
     * migration, so the platform's public name is on it and neither key that serves the name is. */
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

    /* A replayed-but-empty var is what a dropped value looks like coming through `-e NAME=`, so blank has to
     * read as missing. Treating it as present is the one bug that would make this whole check silently useless
     * on exactly the containers it is for. */
    it(`counts blank and whitespace-only values as missing, not as set`, () => {
        expect(containerDrift({ ...CURRENT, SANDBOX_GRANT: `` })[0]?.missing).toEqual([`SANDBOX_GRANT`]);
        expect(containerDrift({ ...CURRENT, SANDBOX_GRANT: `   ` })[0]?.missing).toEqual([`SANDBOX_GRANT`]);
    });

    /* THE HALF THAT KEEPS THIS FROM BECOMING NOISE. A sandbox with no public address never had public
     * reachability to lose — a loopback dev box, a runner — and telling its owner they are missing two keys
     * they were never given is how a diagnostic trains people to ignore it. */
    it(`asks nothing of a sandbox that offers no evidence it was meant to be reachable`, () => {
        expect(containerDrift({})).toEqual([]);
        expect(containerDrift({ CONNECT_TOKEN: `tok`, WORKSPACE_ROOT: `/work` })).toEqual([]);
        expect(containerDrift({ SANDBOX_PUBLIC_URL: `` })).toEqual([]);
    });

    /* The other half of not being noise, and the one that would have been wrong on every hosted sandbox: a Fly
     * microVM carries a public address it serves by being replayed to, so it holds no grant BY DESIGN. */
    it(`stays quiet on a hosted machine, which serves its address without dialling out`, () => {
        expect(containerDrift({ SANDBOX_PUBLIC_URL: CURRENT.SANDBOX_PUBLIC_URL, SANDBOX_VM: `1` })).toEqual([]);
    });
});

describe(`CONTAINER_REQUIREMENTS`, () => {
    it(`keys every row uniquely, so a UI can key and dedupe on it`, () => {
        const keys = CONTAINER_REQUIREMENTS.map((requirement) => requirement.key);
        expect(new Set(keys).size).toBe(keys.length);
    });

    /* Each row's own guard against being written wrong. `given` and `requires` overlapping would make a row
     * that can never fire (the evidence would have to be missing for the requirement to be unmet), and an empty
     * `given` would make it fire on every sandbox in the fleet. */
    it(`states evidence that is separate from what it demands`, () => {
        for (const requirement of CONTAINER_REQUIREMENTS) {
            expect(requirement.given.length).toBeGreaterThan(0);
            expect(requirement.requires.length).toBeGreaterThan(0);
            expect(requirement.given.filter((name) => requirement.requires.includes(name))).toEqual([]);
        }
    });

    // These three strings are rendered verbatim to somebody who has to act on them, so an empty one is a blank
    // card in the product rather than a missing string in a test.
    it(`words every row for the person who has to fix it`, () => {
        for (const requirement of CONTAINER_REQUIREMENTS) {
            expect(requirement.enables.length).toBeGreaterThan(0);
            expect(requirement.lost.length).toBeGreaterThan(0);
            expect(requirement.repair.length).toBeGreaterThan(0);
        }
    });
});
