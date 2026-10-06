import { MODEL_ROLE_BLOCKS, MODEL_ROLES } from "@intentic/sandbox-contract";
import { setLocale } from "@intentic/ui/i18n";
import { blockLabel, roleBlurb, roleLabel } from "./roleWords";

// The contract names every job in English; en.json carries the copy the Polish is translated from. Held equal here, so
// a job renamed there cannot go on being shown in its old translation.

test(`in English every job and block reads exactly as the contract spells it`, () => {
    expect(MODEL_ROLES.map((role) => [roleLabel(role), roleBlurb(role)])).toEqual(MODEL_ROLES.map((role) => [role.label, role.blurb]));
    expect(MODEL_ROLE_BLOCKS.map(blockLabel)).toEqual(MODEL_ROLE_BLOCKS.map((block) => block.label));
});

describe(`in Polish`, () => {
    beforeAll(async () => {
        await setLocale(`pl`);
    });
    afterAll(async () => {
        await setLocale(`en`);
    });

    test(`every job and block has its own words`, () => {
        expect(MODEL_ROLES.filter((role) => roleLabel(role) === role.label || roleBlurb(role) === role.blurb).map((role) => role.id)).toEqual([]);
        expect(MODEL_ROLE_BLOCKS.filter((block) => blockLabel(block) === block.label).map((block) => block.id)).toEqual([]);
        expect(roleLabel({ id: `commit-message` })).toBe(`Wiadomości commitów`);
    });
});
