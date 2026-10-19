import { asRecoveryKey, newRecoveryKey } from "./recovery.js";

describe("a recovery key", () => {
    test("is six groups of five Crockford characters, different every time", () => {
        const key = newRecoveryKey();
        expect(key).toMatch(/^[0-9A-HJKMNP-TV-Z]{5}(-[0-9A-HJKMNP-TV-Z]{5}){5}$/u);
        expect(newRecoveryKey()).not.toBe(key);
    });

    test("reads back from what a person types: any case, spaces, and I, L, O for 1 and 0", () => {
        const key = newRecoveryKey(() => Buffer.from(Array.from({ length: 30 }, (_unused, index) => index)));
        expect(key).toBe("01234-56789-ABCDE-FGHJK-MNPQR-STVWX");
        expect(asRecoveryKey("o1234 56789 abcde fghjk mnpqr stvwx")).toBe(key);
        expect(asRecoveryKey("0I234-56789-ABCDE-FGHJK-MNPQR-STVWX")).toBe(key);
    });

    test("leaves anything else as typed, so a passphrase from before still opens the vault", () => {
        expect(asRecoveryKey("correct horse battery staple")).toBe("correct horse battery staple");
        expect(asRecoveryKey("01234-56789")).toBe("01234-56789");
    });
});
