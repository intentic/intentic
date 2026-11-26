import { CORE_MODEL_ROLES, EXTENSION_ROLES_BEFORE_CONTRIBUTIONS } from "@intentic/sandbox-contract/models/model-roles";

const MODEL_ROLES = [...CORE_MODEL_ROLES, ...EXTENSION_ROLES_BEFORE_CONTRIBUTIONS];
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
        expect(roleLabel({ id: `commit-message`, label: `Commit messages` })).toBe(`Wiadomości commitów`);
    });

    test(`an extension's job reads in its own words, and one that renamed a translated job in its new ones`, () => {
        expect(roleLabel({ id: `nightly-audit`, label: `Nightly audits` })).toBe(`Nightly audits`);
        expect(roleLabel({ id: `pipeline-fix`, label: `CI repairs` })).toBe(`CI repairs`);
        expect(roleLabel({ id: `pipeline-fix`, label: `Pipeline fixes` })).not.toBe(`Pipeline fixes`);
    });
});
