import { arrivalMode, definitionSeedFor } from "./profiles.js";

// How a new sandbox runs travels to its machine as one seed, chosen by the mode its maker picked. hands-on is a sandbox
// with nothing applied to it, so it carries none; the older `profile=desk` a desktop app re-mints with still means
// hands-off, or a code that ran out would be renewed as the other kind of sandbox.

const decoded = (seed: string | undefined): string => Buffer.from(seed ?? ``, `base64`).toString(`utf8`);

describe(`arrivalMode`, () => {
    it(`takes the mode a caller names, over any profile beside it`, () => {
        expect(arrivalMode({ mode: `hands-on`, profile: `desk` })).toBe(`hands-on`);
        expect(arrivalMode({ mode: `hands-off` })).toBe(`hands-off`);
    });

    it(`reads an older desktop app's desk profile as hands-off, and anything else as no answer`, () => {
        expect(arrivalMode({ profile: `desk` })).toBe(`hands-off`);
        expect(arrivalMode({ profile: `default` })).toBeUndefined();
        expect(arrivalMode({})).toBeUndefined();
    });
});

describe(`definitionSeedFor`, () => {
    it(`seeds a hands-off sandbox with the mode itself, as base64 TOML`, () => {
        const toml = decoded(definitionSeedFor(`hands-off`));
        expect(toml).toContain(`schemaVersion = 1`);
        expect(toml).toMatch(/^\[settings\]\nmode = "hands-off"$/mu);
    });

    it(`seeds nothing for hands-on, or for a caller that named no mode`, () => {
        expect(definitionSeedFor(`hands-on`)).toBeUndefined();
        expect(definitionSeedFor(undefined)).toBeUndefined();
    });

    it(`hands back the same value each time, read once`, () => {
        expect(definitionSeedFor(`hands-off`)).toBe(definitionSeedFor(`hands-off`));
    });
});
