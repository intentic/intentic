import type { AccessProfile } from "@intentic/sandbox-contract/schemas/access-profiles";
import { setLocale } from "@intentic/ui/i18n";
import { roleBoundsWords, profilesHolding } from "./roleBounds";

// Every phrase the contract's roleBounds can answer, one set of holding profiles each.
const held: readonly (readonly AccessProfile[])[] = [
    [],
    [{ id: `reader`, tools: { files: `read`, shell: false } }],
    [{ id: `quiet`, tools: { shell: false } }],
    [{ id: `one`, tools: { web: false } }],
    [{ id: `two`, tools: { web: false }, areas: [`docs`] }],
];

test(`in English it says what the contract says`, () => {
    expect(held.map(roleBoundsWords)).toEqual([`Full powers`, `Read-only`, `No shell`, `1 limit`, `2 limits`]);
});

test(`a card is held by the profiles listing it and no others`, () => {
    const profiles: AccessProfile[] = [
        { id: `a`, roles: [`reviewer`] },
        { id: `b`, roles: [`writer`] },
        { id: `c` },
    ];
    expect(profilesHolding(profiles, `reviewer`).map((profile) => profile.id)).toEqual([`a`]);
    expect(profilesHolding(profiles, `nobody`)).toEqual([]);
});

describe(`in Polish`, () => {
    beforeAll(async () => {
        await setLocale(`pl`);
    });
    afterAll(async () => {
        await setLocale(`en`);
    });

    test(`every phrase reads in Polish, a count in its plural form`, () => {
        expect(held.map(roleBoundsWords)).toEqual([`Pełne uprawnienia`, `Tylko do odczytu`, `Bez powłoki`, `1 ograniczenie`, `2 ograniczenia`]);
    });
});
