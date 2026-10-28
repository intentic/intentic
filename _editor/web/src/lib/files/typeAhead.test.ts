import { createTypeAhead, TYPE_AHEAD_PAUSE_MS, typeAheadTarget } from "./typeAhead";

const NAMES = [`assets`, `scripts`, `src`, `README.md`, `setup.ts`];
const land = (lead: string | null, word: string): string | undefined => typeAheadTarget(NAMES, (name) => name, lead, word);
const press = (key: string, held: Partial<{ ctrlKey: boolean; metaKey: boolean; altKey: boolean }> = {}) => ({
    key,
    ctrlKey: false,
    metaKey: false,
    altKey: false,
    ...held,
});

describe(`typeAheadTarget`, () => {
    it(`lands on the first name starting with the letter, past the lead`, () => {
        expect(land(null, `s`)).toBe(`scripts`);
        expect(land(`scripts`, `s`)).toBe(`src`);
    });

    it(`steps through the names starting with a letter pressed again, wrapping round`, () => {
        expect(land(`src`, `ss`)).toBe(`setup.ts`);
        expect(land(`setup.ts`, `sss`)).toBe(`scripts`);
    });

    it(`keeps a longer prefix on the entry it already matches`, () => {
        expect(land(`src`, `sr`)).toBe(`src`);
        expect(land(`scripts`, `se`)).toBe(`setup.ts`);
    });

    it(`matches case-blind and answers nothing for an unmatched word`, () => {
        expect(land(null, `rea`)).toBe(`README.md`);
        expect(land(`src`, `zz`)).toBeUndefined();
        expect(land(`src`, ``)).toBeUndefined();
    });
});

describe(`createTypeAhead`, () => {
    it(`builds a word from presses close together and starts again after a pause`, () => {
        const typing = createTypeAhead();
        expect(typing.add(`S`, 0)).toBe(`s`);
        expect(typing.add(`r`, 100)).toBe(`sr`);
        expect(typing.add(`a`, 100 + TYPE_AHEAD_PAUSE_MS + 1)).toBe(`a`);
    });

    it(`takes a printable key with no chord, and a space only inside a word`, () => {
        const typing = createTypeAhead();
        expect(typing.typed(press(`a`), 0)).toBe(`a`);
        expect(typing.typed(press(`a`, { ctrlKey: true }), 0)).toBeUndefined();
        expect(typing.typed(press(`ArrowDown`), 0)).toBeUndefined();
        expect(typing.typed(press(` `), 0)).toBeUndefined();
        typing.add(`m`, 0);
        expect(typing.typed(press(` `), 200)).toBe(` `);
        expect(typing.typed(press(` `), 200 + TYPE_AHEAD_PAUSE_MS + 1)).toBeUndefined();
    });
});
