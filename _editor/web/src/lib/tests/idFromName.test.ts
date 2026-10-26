import { idFromName } from "../idFromName";

// Nobody types an id: the name is folded into one the contract takes, and a clash gets the first free number.
describe(`idFromName`, () => {
    it(`folds a name into lower-case words joined by a dash`, () => {
        expect(idFromName(`Marketing bot`, [], `service`)).toBe(`marketing-bot`);
        expect(idFromName(`  Ops / On-call!  `, [], `profile`)).toBe(`ops-on-call`);
    });

    it(`keeps the letters of a name with marks rather than breaking the word`, () => {
        expect(idFromName(`Księgowość`, [], `profile`)).toBe(`ksiegowosc`);
        expect(idFromName(`Łódź Straße`, [], `profile`)).toBe(`lodz-strasse`);
    });

    it(`falls back when nothing in the name can spell an id`, () => {
        expect(idFromName(`営業`, [], `profile`)).toBe(`profile`);
        expect(idFromName(`!!!`, [`profile`], `profile`)).toBe(`profile-2`);
    });

    it(`numbers a name that folds onto one already taken`, () => {
        expect(idFromName(`Interns`, [`interns`, `interns-2`], `profile`)).toBe(`interns-3`);
    });

    it(`stays inside the contract's 60 characters with room for the number`, () => {
        const id = idFromName(`a`.repeat(80), [`a`.repeat(56)], `profile`);
        expect(id).toBe(`${`a`.repeat(56)}-2`);
        expect(/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/u.test(id)).toBe(true);
    });
});
