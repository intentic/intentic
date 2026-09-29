import { nestsQuantifiers } from "./search.js";

// Which patterns the search refuses to run: a repeated group that itself repeats, read the way the engine reads it.

describe(`nestsQuantifiers`, () => {
    it(`finds a repeated group whose body repeats, however deep`, () => {
        expect([`(a+)+$`, `(\\w*\\s?)*`, `(x{2,})+`, `((ab)+c)*`, `(?:a*b)+`, `(a+?)+`].map(nestsQuantifiers)).toEqual([true, true, true, true, true, true]);
    });

    it(`passes a pattern that repeats only once at each depth`, () => {
        expect([`a+b+`, `(ab)+`, `(a+)?`, `(a+b)`, `[(+]+`, `\\(a+\\)+`, `\\w+@\\w+\\.com`, `(a|b){2}`].map(nestsQuantifiers)).toEqual([
            false,
            false,
            false,
            false,
            false,
            false,
            false,
            false,
        ]);
    });
});
