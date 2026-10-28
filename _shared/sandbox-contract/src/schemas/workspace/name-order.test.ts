import { compareListed, compareNames } from "./name-order.js";

const sorted = (names: readonly string[]): string[] => names.toSorted(compareNames);

describe(`compareNames`, () => {
    it(`puts numbers in counting order`, () => {
        expect(sorted([`shot-10.png`, `shot-2.png`, `shot-1.png`])).toEqual([`shot-1.png`, `shot-2.png`, `shot-10.png`]);
    });

    it(`folds case, so a capitalised name sits among its letter`, () => {
        expect(sorted([`zeta.md`, `README.md`, `alpha.md`])).toEqual([`alpha.md`, `README.md`, `zeta.md`]);
    });

    it(`breaks a tie between names that collate alike by code point`, () => {
        expect(sorted([`readme.md`, `README.md`])).toEqual([`README.md`, `readme.md`]);
        expect(compareNames(`a`, `a`)).toBe(0);
    });
});

describe(`compareListed`, () => {
    it(`lists folders first, each kind in natural order`, () => {
        const entries = [
            { name: `b10`, dir: false },
            { name: `src`, dir: true },
            { name: `b2`, dir: false },
            { name: `assets`, dir: true },
        ];
        expect(entries.toSorted(compareListed).map((entry) => entry.name)).toEqual([`assets`, `src`, `b2`, `b10`]);
    });
});
