import { generatePassword } from "./generate.js";

// Generate's passwords: the length asked for, every kind of character in each, and a different one every time.
describe(`generatePassword`, () => {
    it(`holds a lower, an upper, a digit and a symbol, at the length asked`, () => {
        for (let round = 0; round < 50; round++) {
            const password = generatePassword();
            expect(password).toHaveLength(20);
            expect(password).toMatch(/[a-z]/u);
            expect(password).toMatch(/[A-Z]/u);
            expect(password).toMatch(/[2-9]/u);
            expect(password).toMatch(/[-_.!@#%+=]/u);
        }
        expect(generatePassword(32)).toHaveLength(32);
        expect(generatePassword()).not.toBe(generatePassword());
    });
});
