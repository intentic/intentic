import { maskJsonText, restoreJsonText } from "../json-text.js";
import { mask, restore } from "./fake-shield.testing.js";

// Tool arguments are JSON text the harness will parse; whatever masking and restoring do, the result must still parse
// and must keep every byte the model wrote that held no token.

describe("restoring JSON text", () => {
    test("a value with quotes and a newline is escaped, so the arguments still parse", () => {
        const raw = '{"to": "⟦PERSON_1⟧", "address": "⟦ADDRESS_1⟧"}';
        const restored = restoreJsonText(raw, restore);
        expect(JSON.parse(restored)).toEqual({ to: "Jan Kowalski", address: 'ul. "Długa" 5\n00-001 Warszawa' });
        // Whitespace after the colons is the model's own and stays.
        expect(restored).toBe('{"to": "Jan Kowalski", "address": "ul. \\"Długa\\" 5\\n00-001 Warszawa"}');
    });

    test("numbers and spacing the model wrote survive, which a parse and re-serialize would lose", () => {
        const raw = '{ "id": 12345678901234567890, "ratio": 1.0, "who": "⟦PERSON_1⟧" }';
        expect(restoreJsonText(raw, restore)).toBe('{ "id": 12345678901234567890, "ratio": 1.0, "who": "Jan Kowalski" }');
    });

    test("keys are left as written and only values are restored", () => {
        // The request side never masks keys, so a key holding a token was the model's own invention.
        expect(restoreJsonText('{"⟦PERSON_1⟧": "⟦PERSON_1⟧"}', restore)).toBe('{"⟦PERSON_1⟧": "Jan Kowalski"}');
    });

    test("an escaped token is found too", () => {
        // A client that writes non-ASCII as \u escapes still names the token.
        expect(JSON.parse(restoreJsonText(String.raw`{"who": "\u27e6PERSON_1\u27e7"}`, restore))).toEqual({ who: "Jan Kowalski" });
    });

    test("arguments cut off mid-string have their tokens restored in place, escaped", () => {
        // max_tokens can end a call inside a string; what is there is still restored, as JSON-string text.
        expect(restoreJsonText('{"address": "⟦ADDRESS_1⟧, then ⟦PERS', restore)).toBe('{"address": "ul. \\"Długa\\" 5\\n00-001 Warszawa, then ⟦PERS');
    });

    test("text with no token is returned as the same string", () => {
        const raw = '{"command": "ls -la"}';
        expect(restoreJsonText(raw, restore)).toBe(raw);
    });
});

describe("masking JSON text", () => {
    test("the whole text goes to the masker at once, so it reads every field in context", async () => {
        const seen: string[] = [];
        const raw = '{"first": "Jan Kowalski", "mail": "jan.kowalski@example.pl"}';
        const masked = await maskJsonText(raw, async (text) => {
            seen.push(text);
            return mask(text);
        });
        expect(seen).toEqual([raw]);
        expect(masked).toBe('{"first": "⟦PERSON_1⟧", "mail": "⟦EMAIL_1⟧"}');
    });

    test("a masker that breaks the JSON is retried literal by literal, so what goes out still parses", async () => {
        // A masker whose span ends on the backslash of `\"` eats the escape, so the quote after it closes the string early:
        // invalid JSON the provider may refuse.
        const greedy = async (text: string): Promise<string> =>
            text.replaceAll("Jan Kowalski\\", "⟦PERSON_1⟧").replaceAll("Jan Kowalski", "⟦PERSON_1⟧");
        const raw = String.raw`{"body": "say \"Jan Kowalski\" twice", "to": "Jan Kowalski"}`;
        expect(() => JSON.parse(raw.replaceAll("Jan Kowalski\\", "⟦PERSON_1⟧"))).toThrow();
        const masked = await maskJsonText(raw, greedy);
        expect(JSON.parse(masked)).toEqual({ body: 'say "⟦PERSON_1⟧" twice', to: "⟦PERSON_1⟧" });
    });

    test("text that is not JSON is masked as text", async () => {
        expect(await maskJsonText('{"to": "Jan Kowalski"', async (text) => mask(text))).toBe('{"to": "⟦PERSON_1⟧"');
    });
});
