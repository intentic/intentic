import { PRIVACY_LEAK_CONTEXT_REACH } from "@intentic/sandbox-contract/schemas/privacy-leaks";
import { leakContext } from "./leakSelection";

// The stretch of a message sent with a reported leak: around the value the selection named, never the whole reply.

describe(`the text sent around a reported value`, () => {
    test(`is the whole message when it is short`, () => {
        const text = `Klient: Jan Kowalski, PESEL 44051401359.`;
        expect(leakContext(text, `44051401359`, text.indexOf(`44051401359`))).toBe(text);
    });

    test(`is cut around the occurrence the selection named, not the first one`, () => {
        const filler = `x`.repeat(PRIVACY_LEAK_CONTEXT_REACH * 10);
        const text = `Kowalski ${filler} Kowalski tail`;
        const second = text.lastIndexOf(`Kowalski`);
        const context = leakContext(text, `Kowalski`, second);
        expect(context?.endsWith(`Kowalski tail`)).toBe(true);
        expect(context?.startsWith(`Kowalski`)).toBe(false);
    });

    test(`stays well under what the route takes, however long the reply`, () => {
        const text = `${`a`.repeat(50_000)} ABC123456 ${`b`.repeat(50_000)}`;
        const context = leakContext(text, `ABC123456`, text.indexOf(`ABC123456`));
        expect(context).toContain(`ABC123456`);
        expect(context?.length ?? 0).toBeLessThan(20_000);
        expect(context?.length ?? 0).toBeGreaterThan(PRIVACY_LEAK_CONTEXT_REACH * 2);
    });

    test(`falls back to the first occurrence when the drawn offset does not hold the value`, () => {
        const text = `Nr paszportu: ZS1234567`;
        expect(leakContext(text, `ZS1234567`, 3)).toBe(text);
    });

    test(`is nothing when the value is not in the message at all`, () => {
        expect(leakContext(`nothing here`, `Kowalski`, 0)).toBeUndefined();
    });
});
