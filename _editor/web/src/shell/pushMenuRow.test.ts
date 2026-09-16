import { describe, expect, it } from "vitest";
import { pushMenuRow } from "./pushMenuRow";

describe(`pushMenuRow`, () => {
    it(`says nothing once this phone is registered`, () => {
        expect(pushMenuRow(`on`)).toBeUndefined();
    });

    it(`invites an unregistered phone in, and names the way back from a block`, () => {
        expect(pushMenuRow(`off`)?.tone).toBe(`info`);
        expect(pushMenuRow(`denied`)).toMatchObject({ tone: `warning`, detail: expect.stringContaining(`site settings`) });
    });

    // iOS Safari has no push until the app is on the Home Screen, and the Menu is where a phone reads this.
    it(`tells an uninstalled Safari to install rather than declaring push impossible`, () => {
        expect(pushMenuRow(`unsupported`)?.message).toContain(`Home Screen`);
    });
});
