import { errnoCode, errorMessage, isMissing, undefinedIfMissing } from "./errors.js";

const errno = (code: string): NodeJS.ErrnoException => Object.assign(new Error(code), { code });

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

describe(`errnoCode`, () => {
    it(`reads a string code and nothing else`, () => {
        expect(errnoCode(errno(`EACCES`))).toBe(`EACCES`);
        expect(errnoCode({ code: 404 })).toBeUndefined();
        expect(errnoCode(new Error(`plain`))).toBeUndefined();
        expect(errnoCode(`ENOENT`)).toBeUndefined();
        expect(errnoCode(undefined)).toBeUndefined();
    });
});

describe(`isMissing`, () => {
    it(`is true for ENOENT and ENOTDIR only`, () => {
        expect(isMissing(errno(`ENOENT`))).toBe(true);
        expect(isMissing(errno(`ENOTDIR`))).toBe(true);
        expect(isMissing(errno(`EACCES`))).toBe(false);
        expect(isMissing(errno(`EISDIR`))).toBe(false);
        expect(isMissing(new TypeError(`x is undefined`))).toBe(false);
    });
});

describe(`undefinedIfMissing`, () => {
    it(`answers undefined for a missing path`, async () => {
        await expect(Promise.reject(errno(`ENOENT`)).catch(undefinedIfMissing)).resolves.toBeUndefined();
    });

    it(`rethrows every other failure unchanged`, async () => {
        const denied = errno(`EACCES`);
        await expect(Promise.reject(denied).catch(undefinedIfMissing)).rejects.toBe(denied);
        const bug = new TypeError(`x is undefined`);
        await expect(Promise.reject(bug).catch(undefinedIfMissing)).rejects.toBe(bug);
    });
});
