// An EMPTY document, on the editing surface. Markdown has no block for "nothing", so the splitter returns no blocks at
// all: without a line standing in for them the `contenteditable` renders no children, which is a pane with nothing to
// click, nothing to focus and nowhere to put a caret. Mounted for real (jsdom, plain Vue) since the whole question is
// what the DOM ends up holding.
import "@intentic/testing/dom";
import { createApp, h, nextTick } from "vue";
import { MarkdownDocument } from "@intentic/ui";

const surfaceOf = (source: string, placeholder?: string): HTMLElement => {
    const host = document.createElement(`div`);
    document.body.append(host);
    createApp({ render: () => h(MarkdownDocument, { modelValue: source, editable: true, save: `none`, placeholder }) }).mount(host);
    const editable = host.querySelector<HTMLElement>(`.md-editing`);
    if (editable === null) {
        throw new Error(`the editing surface did not mount`);
    }
    return editable;
};

// What the browser does on a keystroke: the text lands in the block, then the surface hears about it.
const type = async (block: Element, text: string): Promise<void> => {
    block.textContent = text;
    block.dispatchEvent(new InputEvent(`input`, { bubbles: true, inputType: `insertText`, data: text }));
    await nextTick();
};

describe(`an empty markdown document`, () => {
    test(`still has a line to put the caret in`, () => {
        const surface = surfaceOf(``);
        expect(surface.children).toHaveLength(1);
        expect(surface.children[0]?.tagName).toBe(`P`);
        expect(surface.getAttribute(`contenteditable`)).toBe(`true`);
    });

    // The line is the surface's, not the document's: an empty file that was only opened must still read as empty, or
    // the viewer's save would write whitespace into a file nobody typed in.
    test(`reads as empty text, so opening one dirties nothing`, () => {
        surfaceOf(``);
        expect(document.querySelector(`.md-editing`)?.textContent).toBe(``);
    });

    test(`says so, when the caller gave it words for it`, () => {
        expect(surfaceOf(``, `Start typing.`).dataset[`placeholder`]).toBe(`Start typing.`);
        // Nothing to say and nothing said: no attribute for the skin's ghost text to draw.
        expect(surfaceOf(``).dataset[`placeholder`]).toBeUndefined();
    });

    test(`typing into that line writes the document, with no blank line in front of it`, async () => {
        const surface = surfaceOf(``, `Start typing.`);
        const block = surface.firstElementChild;
        expect(block?.tagName).toBe(`P`);
        await type(block as Element, `# Title`);
        expect(surface.textContent).toBe(`# Title`);
        expect(surface.children).toHaveLength(1);
    });

    // Select-all-delete leaves the browser free to take every child away; the surface has to put the line back, or a
    // document emptied by hand becomes one that cannot be typed in again.
    test(`gets its line back after everything in it is deleted`, async () => {
        const surface = surfaceOf(`# Title\n\nAnd a paragraph.`);
        expect(surface.children.length).toBeGreaterThan(1);
        surface.replaceChildren();
        surface.dispatchEvent(new InputEvent(`input`, { bubbles: true, inputType: `deleteContentBackward` }));
        await nextTick();
        expect(surface.children).toHaveLength(1);
        expect(surface.children[0]?.tagName).toBe(`P`);
        expect(surface.textContent).toBe(``);
    });

    // What Chromium actually leaves after Ctrl-A Backspace, seen in the browser: the block's element, emptied but
    // still a heading. The document is empty, so the line standing in for it must be too, or the next keystroke is
    // typed into markup the file no longer contains.
    test.each([
        [`one block`, `## Title`],
        [`several`, `## Title\n\nAnd a paragraph.`],
    ])(`and replaces the hollowed-out block a browser leaves behind (%s)`, async (_case, source) => {
        const surface = surfaceOf(source, `Start typing.`);
        surface.innerHTML = `<h2 class="md-block-active"><span class="md-marker md-marker-gutter"><br></span></h2>`;
        surface.dispatchEvent(new InputEvent(`input`, { bubbles: true, inputType: `deleteContentBackward` }));
        await nextTick();
        // No caret in jsdom, so no active-block class: the markup is the blank line and nothing else.
        expect(surface.innerHTML).toBe(`<p></p>`);
        expect(surface.dataset[`placeholder`]).toBe(`Start typing.`);
    });
});
