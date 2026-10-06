import { COMMAND_CLASS_LABELS, COMMAND_CLASS_PATTERNS, type CommandClass } from "@intentic/sandbox-contract";
import { setLocale } from "@intentic/ui/i18n";
import { commandClassWords, qualifierWords } from "./ruleWords";

// The contract says what each command class does, and what narrows each pattern, in English; en.json carries the copy
// the Polish is translated from. Held equal here, so a sentence changed there cannot go on in its old translation.
const CLASSES = Object.keys(COMMAND_CLASS_LABELS) as CommandClass[];
const QUALIFIERS = [...new Set(Object.values(COMMAND_CLASS_PATTERNS).flatMap((patterns) => patterns.flatMap((pattern) => pattern.qualifier ?? [])))];

test(`in English every class and qualifier reads exactly as the contract spells it`, () => {
    expect(CLASSES.filter((commandClass) => commandClassWords(commandClass) !== COMMAND_CLASS_LABELS[commandClass])).toEqual([]);
    expect(QUALIFIERS.filter((qualifier) => qualifierWords(qualifier) !== qualifier)).toEqual([]);
});

describe(`in Polish`, () => {
    beforeAll(async () => {
        await setLocale(`pl`);
    });
    afterAll(async () => {
        await setLocale(`en`);
    });

    // A qualifier the contract gains would otherwise be the one English tooltip on a Polish page.
    test(`every class and qualifier has its own words`, () => {
        expect(CLASSES.filter((commandClass) => commandClassWords(commandClass) === COMMAND_CLASS_LABELS[commandClass])).toEqual([]);
        expect(QUALIFIERS.filter((qualifier) => qualifierWords(qualifier) === qualifier)).toEqual([]);
        expect(commandClassWords(`files.destructive`)).toBe(`rekurencyjnie usunąć pliki`);
    });
});
