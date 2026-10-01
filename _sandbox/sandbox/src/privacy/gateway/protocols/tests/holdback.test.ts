import { TOKEN_MAX_LENGTH } from "../../../tokens.js";
import { createHoldback } from "../holdback.js";
import { restore } from "./fake-shield.testing.js";

// The holdback is what stands between a token split across two deltas and the client seeing both halves raw.

// Every piece a holdback emits for `pieces`, its flush last.
const emittedFor = (pieces: readonly string[]): readonly string[] => {
    const holdback = createHoldback(restore);
    return [...pieces.map((piece) => holdback.push(piece)), holdback.flush()];
};
const pushAll = (pieces: readonly string[]): string => emittedFor(pieces).join("");

describe("the streaming holdback", () => {
    test("a token split at any character is restored whole, in both bracket spellings", () => {
        // Every cut of a text holding both spellings, a multibyte value and a token at the very end: the client must
        // see exactly the restored text however the provider sliced it.
        const text = "Dzień dobry ⟦PERSON_1⟧, konto [[BANK_ACCOUNT_3]] i ⟦PERSON_2⟧";
        const expected = "Dzień dobry Jan Kowalski, konto PL61109010140000071219812874 i Zażółć Gęślą";
        for (let at = 0; at <= text.length; at += 1) {
            expect(pushAll([text.slice(0, at), text.slice(at)])).toBe(expected);
        }
        expect(pushAll([...text])).toBe(expected);
    });

    test("no emitted piece ever carries part of a token", () => {
        // Concatenation alone would also pass if raw halves were emitted and happened to join; each piece must stand alone.
        for (const piece of emittedFor([..."a ⟦PERSON_1⟧ b [[EMAIL_1]] c"])) {
            expect(piece).not.toMatch(/⟦|⟧|\[\[|\]\]/u);
        }
    });

    test("prose and code that only look like a bracket are not held", () => {
        // Holding from every `[` would stall code-heavy answers; only a token's own prefix is held.
        const holdback = createHoldback(restore);
        expect(holdback.push("const first = items[0];")).toBe("const first = items[0];");
        expect(holdback.push(" matrix = [[1, 2]];")).toBe(" matrix = [[1, 2]];");
        expect(holdback.push(" see ⟦note⟧ ")).toBe(" see ⟦note⟧ ");
        expect(holdback.flush()).toBe("");
    });

    test("the possible start of a token is held until the next piece decides it", () => {
        const holdback = createHoldback(restore);
        expect(holdback.push("Hello ⟦PERS")).toBe("Hello ");
        expect(holdback.push("ON_1")).toBe("");
        expect(holdback.push("⟧!")).toBe("Jan Kowalski!");
        expect(holdback.push("list[")).toBe("list");
        expect(holdback.push("[EMAIL_1]")).toBe("");
        expect(holdback.push("] done")).toBe("jan.kowalski@example.pl done");
    });

    test("a held tail that never becomes a token is emitted as written", () => {
        const holdback = createHoldback(restore);
        expect(holdback.push("broken ⟦PERSON_")).toBe("broken ");
        expect(holdback.push(" end")).toBe("⟦PERSON_ end");
        expect(holdback.push("tail ⟦PERSON_9")).toBe("tail ");
        // An unknown token stays a token: restore only knows the vault's.
        expect(holdback.flush()).toBe("⟦PERSON_9");
    });

    test("an opener with a tail as long as a token is let go rather than held forever", () => {
        // A tail this long cannot be the start of a token, so holding it would only delay the answer.
        const holdback = createHoldback(restore);
        const long = `⟦${"A".repeat(TOKEN_MAX_LENGTH)}`;
        expect(holdback.push(long)).toBe(long);
    });

    test("restore is applied only to emitted text, once", () => {
        // A restored value that itself looks like a token's start must not be read again as one.
        const seen: string[] = [];
        const holdback = createHoldback((text) => {
            seen.push(text);
            return restore(text);
        });
        holdback.push("a ⟦PERSON_1⟧ b ⟦EMA");
        holdback.push("IL_1⟧");
        holdback.flush();
        expect(seen).toEqual(["a ⟦PERSON_1⟧ b ", "⟦EMAIL_1⟧"]);
    });
});
