import type { Persona, PersonaPowers } from "@intentic/sandbox-contract";
import { setLocale } from "@intentic/ui/i18n";
import { personaBoundsWords } from "./personaBounds";

// Everything on, with the switches a card turns off.
const powers = (off: Partial<PersonaPowers>): PersonaPowers => ({
    files: `write`,
    shell: true,
    code: true,
    web: true,
    browser: true,
    delegate: true,
    sandbox: true,
    ...off,
});

// Every phrase the contract's personaBounds can answer, one card each.
const cards: readonly Persona[] = [
    { id: `full`, capabilities: [] },
    { id: `reader`, capabilities: [], powers: powers({ files: `read`, shell: false }) },
    { id: `quiet`, capabilities: [], powers: powers({ shell: false }) },
    { id: `one`, capabilities: [], powers: powers({ web: false }) },
    { id: `two`, capabilities: [], powers: powers({ web: false, browser: false }) },
];

test(`in English it says what the contract says`, () => {
    expect(cards.map(personaBoundsWords)).toEqual([`Full powers`, `Read-only`, `No shell`, `1 limit`, `2 limits`]);
});

describe(`in Polish`, () => {
    beforeAll(async () => {
        await setLocale(`pl`);
    });
    afterAll(async () => {
        await setLocale(`en`);
    });

    test(`every phrase reads in Polish, a count in its plural form`, () => {
        expect(cards.map(personaBoundsWords)).toEqual([`Pełne uprawnienia`, `Tylko do odczytu`, `Bez powłoki`, `1 ograniczenie`, `2 ograniczenia`]);
    });
});
