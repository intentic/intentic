// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { folderOf, linkifyNoteRefs, toneOfType } from "./knowledgeNote.js";

const decorate = (html: string, links: Record<string, string> = {}): HTMLDivElement => {
    const holder = document.createElement(`div`);
    holder.innerHTML = html;
    const fragment = document.createDocumentFragment();
    fragment.append(...holder.childNodes);
    linkifyNoteRefs(fragment, (target) => links[target]);
    const out = document.createElement(`div`);
    out.append(fragment);
    return out;
};

describe(`linkifyNoteRefs`, () => {
    it(`turns a link into something the view can act on`, () => {
        const out = decorate(`<p>Works on [[Intentic]] most days.</p>`, { Intentic: `project/intentic.md` });
        const anchor = out.querySelector(`a`);
        expect(anchor?.textContent).toBe(`Intentic`);
        expect(anchor?.dataset[`kb`]).toBe(`project/intentic.md`);
        expect(out.textContent).toBe(`Works on Intentic most days.`);
    });

    it(`uses the label when one is written`, () => {
        const out = decorate(`<p>[[Charles Babbage|Charles]] built it.</p>`, { "Charles Babbage": `person/charles.md` });
        expect(out.querySelector(`a`)?.textContent).toBe(`Charles`);
    });

    /* A link to a note nobody has written is the knowledge base's to-do list, not an error — so it reads as unfinished
     * and, crucially, is not clickable: there is nothing on the other side of it. */
    it(`marks a link to a note nobody has written, and gives it nowhere to go`, () => {
        const anchor = decorate(`<p>See [[Nowhere]].</p>`).querySelector(`a`);
        expect(anchor?.textContent).toBe(`Nowhere`);
        expect(anchor?.dataset[`kb`]).toBeUndefined();
        expect(anchor?.title).toContain(`Nowhere`);
    });

    it(`handles several links in one sentence without losing the words between them`, () => {
        const out = decorate(`<p>[[A]] then [[B]] then [[C]].</p>`, { A: `a.md`, B: `b.md`, C: `c.md` });
        expect(out.querySelectorAll(`a`)).toHaveLength(3);
        expect(out.textContent).toBe(`A then B then C.`);
    });

    it(`leaves an example inside code alone, so the vocabulary note can document the syntax`, () => {
        const out = decorate(`<p>Write it as <code>[[Intentic]]</code>.</p>`, { Intentic: `project/intentic.md` });
        expect(out.querySelectorAll(`a`)).toHaveLength(0);
    });

    it(`leaves text inside an existing link alone`, () => {
        const out = decorate(`<p><a href="https://example.com">[[Intentic]]</a></p>`, { Intentic: `project/intentic.md` });
        expect(out.querySelectorAll(`a`)).toHaveLength(1);
        expect(out.querySelector(`a`)?.getAttribute(`href`)).toBe(`https://example.com`);
    });

    /* The decorator runs on the SANITIZED fragment and authors its own markup, so a label that looks like a
     * tag has to arrive as text and leave as text. Built from a text node rather than from innerHTML, because
     * innerHTML would parse the tag before the decorator ever saw it and the test would prove nothing. */
    it(`writes the anchor text as text, never as markup`, () => {
        const fragment = document.createDocumentFragment();
        const paragraph = document.createElement(`p`);
        paragraph.append(document.createTextNode(`[[x|<img src=x onerror=alert(1)>]]`));
        fragment.append(paragraph);
        linkifyNoteRefs(fragment, () => `x.md`);
        const out = document.createElement(`div`);
        out.append(fragment);
        expect(out.querySelectorAll(`img`)).toHaveLength(0);
        expect(out.querySelector(`a`)?.textContent).toBe(`<img src=x onerror=alert(1)>`);
    });

    it(`changes nothing in prose that holds no links`, () => {
        const out = decorate(`<p>Nothing to see.</p>`);
        expect(out.innerHTML).toBe(`<p>Nothing to see.</p>`);
    });
});

describe(`toneOfType`, () => {
    it(`gives every kind a colour, the same one every time`, () => {
        expect(toneOfType(`person`)).toBe(toneOfType(`person`));
        // Any word the owner's vocabulary happens to use gets one — there is no list to fall off.
        expect(toneOfType(`something-nobody-predicted`)).toBeTruthy();
    });

    it(`leaves a note with no kind uncoloured`, () => {
        expect(toneOfType(undefined)).toBe(`neutral`);
        expect(toneOfType(``)).toBe(`neutral`);
    });
});

describe(`folderOf`, () => {
    it(`names the folder, and nothing for a note at the top`, () => {
        expect(folderOf(`person/ada-lovelace.md`)).toBe(`person`);
        expect(folderOf(`_vocabulary.md`)).toBeUndefined();
    });
});
