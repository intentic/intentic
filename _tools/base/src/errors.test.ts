import { describe, expect, it } from "vitest";
import { errorMessage } from "./errors.js";

describe(`errorMessage`, () => {
    it(`reads an Error's message and stringifies everything else`, () => {
        expect(errorMessage(new Error(`boom`))).toBe(`boom`);
        expect(errorMessage(new TypeError(``))).toBe(``);
        expect(errorMessage(`plain`)).toBe(`plain`);
        expect(errorMessage(42)).toBe(`42`);
        expect(errorMessage(undefined)).toBe(`undefined`);
        expect(errorMessage({ message: `duck` })).toBe(`[object Object]`);
    });
});
