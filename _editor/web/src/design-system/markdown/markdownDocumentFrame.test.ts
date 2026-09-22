// WHERE A MARKDOWN DOCUMENT'S EDGE COMES FROM. A document is a page, not a control, so it never wears a field frame:
// dropped into a `ui-field-shell` on a card it draws a second border over a darker ground, which on the dark skins is
// a hole punched in the section — card-in-card, the shape this prop exists to make unavailable. Mounted for real
// (jsdom, plain Vue) because the whole question is what the DOM ends up holding.
import "@intentic/testing/dom";
import { describe, test, expect } from "bun:test";
import { createApp, h, nextTick } from "vue";
import { MarkdownDocument } from "@intentic/ui";

// `save="auto"` plus a note is a footer with no <Button> in it: PrimeVue's needs the app's boot, and the footer's
// position is the subject here, not what sits in it.
const mount = (frame?: `none` | `section`): HTMLElement => {
    const host = document.createElement(`div`);
    document.body.append(host);
    createApp({
        render: () =>
            h(MarkdownDocument, { modelValue: `# Title\n\nAnd a paragraph.`, editable: true, save: `auto`, frame }, { note: () => `AGENTS.md` }),
    }).mount(host);
    return host.firstElementChild as HTMLElement;
};

const footOf = (root: HTMLElement): HTMLElement => {
    const foot = [...root.querySelectorAll<HTMLElement>(`div`)].find((element) => element.textContent?.includes(`AGENTS.md`) === true);
    if (foot === undefined) {
        throw new Error(`the document drew no footer`);
    }
    return foot;
};

describe(`frame="section"`, () => {
    test(`hands the scroll to the document and keeps the footer out of it`, () => {
        const root = mount(`section`);
        const body = root.querySelector<HTMLElement>(`.ui-doc-body`);
        expect(body).not.toBeNull();
        expect(body?.contains(root.querySelector(`.md-editing`))).toBe(true);
        // The one that matters: Save and the save state ride the card, not the text, so a long policy cannot carry
        // them off the bottom of its own section.
        expect(body?.contains(footOf(root))).toBe(false);
    });

    test(`draws one rule, over that footer, and no box around the document`, () => {
        const root = mount(`section`);
        const body = root.querySelector<HTMLElement>(`.ui-doc-body`);
        // The group's card is the only surface: no field shell, no ground of its own, no border but the footer's.
        expect(root.querySelector(`.ui-field-shell`)).toBeNull();
        expect(body?.className).not.toMatch(/\bborder\b|\bbg-/u);
        expect(footOf(root).className).toContain(`border-t`);
    });

    test(`reserves a caret's worth of room, not a void`, () => {
        // Both ends of the contract live on one class (utilities.css): a 5rem floor to aim at and a 70dvh ceiling, so
        // an empty memory holds open three lines instead of the 192px of black it used to.
        expect(mount(`section`).querySelector(`.ui-doc-body`)?.className).not.toMatch(/\bmin-h-|\bmax-h-/u);
    });
});

// The default frame is what a form field and a dialog's reading pane both take: the caller's box draws the edge, or
// nothing does.
describe(`frame="none"`, () => {
    test(`wraps the document in nothing, so a caller's own height still reaches it`, async () => {
        const root = mount();
        await nextTick();
        expect(root.querySelector(`.ui-doc-body`)).toBeNull();
        // `display: contents` on the wrapper: the surface stays a flex item of the root the caller sized.
        expect(root.firstElementChild?.className).toContain(`contents`);
        expect<Element | null | undefined>(root.querySelector(`.md-editing`)?.parentElement).toBe(root.firstElementChild);
        expect(footOf(root).className).not.toContain(`border-t`);
    });
});
