import { capabilityEffects } from "@intentic/capability-catalog";
import { setLocale } from "@intentic/ui/i18n";
import { grantList, grantWords } from "./grants";

// Every grant effects.ts can put in a device, browser or phone effect: each switch on, then each off, so a phrase
// behind either position of a switch is in the list.
const SWITCHES = [`shell`, `write`, `screen`, `control`, `sandboxes`, `read`, `act`, `screenshot`, `cookies`, `files`, `notifications`, `apps`];
const everyGrant = (): string[] => {
    const phrases = new Set<string>();
    for (const position of [`on`, `off`]) {
        const config = Object.fromEntries(SWITCHES.map((key) => [key, position]));
        for (const kind of [`device`, `webext`, `phone`] as const) {
            for (const effect of capabilityEffects({ kind, id: kind, config })) {
                if (`grants` in effect) {
                    effect.grants.forEach((grant) => phrases.add(grant));
                }
            }
        }
    }
    return [...phrases];
};

test(`the switches produce the sixteen grants this list knows`, () => {
    expect(everyGrant()).toHaveLength(16);
});

test(`in English every grant reads exactly as the package spells it`, () => {
    expect(everyGrant().filter((phrase) => grantWords(phrase) !== phrase)).toEqual([]);
    expect(grantList([`run commands`, `read files`])).toBe(`run commands, read files`);
});

describe(`in Polish`, () => {
    beforeAll(async () => {
        await setLocale(`pl`);
    });
    afterAll(async () => {
        await setLocale(`en`);
    });

    // A grant the package gains would otherwise be the one English phrase in a Polish sentence.
    test(`every grant effects.ts can produce has words`, () => {
        expect(everyGrant().filter((phrase) => grantWords(phrase) === phrase)).toEqual([]);
    });

    test(`a list reads in Polish, and a phrase with no words keeps its English`, () => {
        expect(grantList([`run commands`, `capture the screen`])).toBe(`uruchamiać polecenia, przechwytywać ekran`);
        expect(grantWords(`fly a drone`)).toBe(`fly a drone`);
    });
});
