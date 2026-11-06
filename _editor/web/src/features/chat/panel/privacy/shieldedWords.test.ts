import { markShielded } from "./shieldedWords";

// A reply's values its model only read as tokens, marked where they stand in the rendered prose.

const NAME = { text: `Aleksandra Wilk`, token: `⟦PERSON_3⟧`, class: `person-name` } as const;
const FIRST = { text: `Aleksandra`, token: `⟦PERSON_9⟧`, class: `person-name` } as const;
const ID = { text: `84031410003`, token: `⟦NATIONAL_ID_1⟧`, class: `national-id` } as const;

const html = (source: string, values: Parameters<typeof markShielded>[1]): string => {
    const [part] = markShielded([{ kind: `html`, html: source }], values);
    return part?.kind === `html` ? part.html : ``;
};

describe(`markShielded`, () => {
    it(`marks each value with the token its model read, the longest first and only as a whole word`, () => {
        expect(html(`<p>Aleksandra Wilk (PESEL 84031410003), not 840314100039.</p>`, [FIRST, NAME, ID])).toBe(
            `<p><span class="chat-shielded" data-shielded="⟦PERSON_3⟧">Aleksandra Wilk</span> (PESEL ` +
                `<span class="chat-shielded" data-shielded="⟦NATIONAL_ID_1⟧">84031410003</span>), not 840314100039.</p>`,
        );
    });

    it(`marks inside inline markup and code, and leaves a code block's placeholder alone`, () => {
        expect(html(`<p><strong>Aleksandra Wilk</strong> <code>84031410003</code></p><pre>84031410003</pre>`, [NAME, ID])).toBe(
            `<p><strong><span class="chat-shielded" data-shielded="⟦PERSON_3⟧">Aleksandra Wilk</span></strong> ` +
                `<code><span class="chat-shielded" data-shielded="⟦NATIONAL_ID_1⟧">84031410003</span></code></p><pre>84031410003</pre>`,
        );
    });

    it(`hands a part none of the values stands in back as it was`, () => {
        const parts = [{ kind: `html`, html: `<p>Nothing personal.</p>` }] as const;
        expect(markShielded(parts, [NAME])[0]).toBe(parts[0]);
        expect(markShielded(parts, [])).toBe(parts);
    });
});
