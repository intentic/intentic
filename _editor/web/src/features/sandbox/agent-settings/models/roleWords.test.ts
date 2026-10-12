import { MODEL_ROLES } from "@intentic/sandbox-contract";
import { setLocale } from "@intentic/ui/i18n";
import { roleBlurb, roleLabel } from "./roleWords";

// The contract names every job in English; en.json carries the copy the Polish is translated from. Held equal here, so
// a job renamed there cannot go on being shown in its old translation.

test(`in English every job reads exactly as the contract spells it`, () => {
    expect(MODEL_ROLES.map((role) => [roleLabel(role), roleBlurb(role)])).toEqual(MODEL_ROLES.map((role) => [role.label, role.blurb]));
});

describe(`in Polish`, () => {
    beforeAll(async () => {
        await setLocale(`pl`);
    });
    afterAll(async () => {
        await setLocale(`en`);
    });

    test(`every job has its own words`, () => {
        expect(MODEL_ROLES.filter((role) => roleLabel(role) === role.label || roleBlurb(role) === role.blurb).map((role) => role.id)).toEqual([]);
        expect(roleLabel({ id: `commit-message` })).toBe(`Wiadomości commitów`);
    });
});
