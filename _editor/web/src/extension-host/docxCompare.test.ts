// The Word redline end to end: two documents built in code, parsed by docx-preview, aligned, and drawn into a DOM
// with the marks the viewer's CSS keys on. Lives here rather than in the extension for the reason viewers.test.ts
// does: the extension has no DOM in its own runner.
import "@intentic/testing/dom";
import { anchorsOf, compareDocx } from "@intentic/ext-viewers/docx-compare";
import { docxBytes } from "@intentic/ext-viewers/testing";
import { describe, it, expect, afterEach } from "bun:test";

let host: HTMLElement | undefined;
const mount = (): HTMLElement => {
    host = document.createElement(`div`);
    document.body.append(host);
    return host;
};
afterEach(() => {
    host?.remove();
    host = undefined;
});

const OPTIONS = { removedPicture: `[picture]` };

describe(`compareDocx`, () => {
    it(`draws the new document with the word that left struck and the word that arrived underlined, on the paragraph it happened in`, async () => {
        const before = docxBytes([{ runs: [{ text: `SPECYFIKACJA` }], style: `Heading1` }, `na dostawy`, `Przetarg nieograniczony`]);
        const after = docxBytes([{ runs: [{ text: `SPECYFIKACJA` }], style: `Heading1` }, `na dostawyasd`, `Przetarg nieograniczony`]);
        const surface = mount();
        const compared = await compareDocx(before, after, surface, OPTIONS);

        expect(compared.events).toEqual([{ id: 1, kind: `changed` }]);
        expect(compared.whole).toBe(false);
        expect(surface.querySelector(`del`)?.textContent).toBe(`dostawy`);
        expect(surface.querySelector(`ins`)?.textContent).toBe(`dostawyasd`);
        const paragraphs = [...surface.querySelectorAll(`p`)].map((paragraph) => paragraph.textContent);
        expect(paragraphs).toEqual([`SPECYFIKACJA`, `na dostawydostawyasd`, `Przetarg nieograniczony`]);
        // The marked paragraph is the one the viewer steps to, and it is the heading's neighbour, not the heading.
        const anchors = anchorsOf(surface);
        expect([...anchors.keys()]).toEqual([1]);
        expect(anchors.get(1)?.[0]?.textContent).toBe(`na dostawydostawyasd`);
        expect(anchors.get(1)?.[0]?.classList.contains(`docx-redline-changed`)).toBe(true);
    });

    it(`keeps a bold run bold on both sides of the split, and strikes a paragraph where it stood`, async () => {
        const before = docxBytes([{ runs: [{ text: `Zakup `, bold: true }, { text: `systemu`, bold: true }] }, `Removed clause.`, `Kept.`]);
        const after = docxBytes([{ runs: [{ text: `Zakup `, bold: true }, { text: `serwera`, bold: true }] }, `Kept.`]);
        const surface = mount();
        const compared = await compareDocx(before, after, surface, OPTIONS);

        expect(compared.events.map((event) => event.kind)).toEqual([`changed`, `removed`]);
        const first = surface.querySelector(`p`)!;
        // Both halves of the split run render as their own bold span.
        const bold = [...first.querySelectorAll(`span`)].filter((span) => span.style.fontWeight === `bold`).map((span) => span.textContent);
        expect(bold).toEqual([`Zakup `, `systemu`, `serwera`]);
        const paragraphs = [...surface.querySelectorAll(`p`)];
        expect(paragraphs[1]?.textContent).toBe(`Removed clause.`);
        expect(paragraphs[1]?.querySelector(`del`)).not.toBeNull();
        expect(paragraphs[1]?.classList.contains(`docx-redline-removed`)).toBe(true);
        expect(paragraphs[2]?.textContent).toBe(`Kept.`);
    });

    it(`marks nothing over two documents whose words match, so the viewer can say so`, async () => {
        const surface = mount();
        const compared = await compareDocx(docxBytes([`Same.`]), docxBytes([`Same.`]), surface, OPTIONS);
        expect(compared.events).toEqual([]);
        expect(surface.querySelectorAll(`ins, del`)).toHaveLength(0);
        expect(surface.querySelector(`p`)?.textContent).toBe(`Same.`);
    });
});
