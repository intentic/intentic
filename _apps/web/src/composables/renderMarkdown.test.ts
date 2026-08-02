// @vitest-environment jsdom
//
// DOMPurify needs a real document: without one it exposes no `sanitize` at all, so under the suite's default
// `node` environment every render here threw into renderMarkdown's crash fallback and the assertions below
// were really checking escaped raw markdown. jsdom rather than happy-dom because DOMPurify misbehaves badly
// on the latter — it strips every tag and keeps <script> CONTENT, which would make these tests worse than
// useless. This is the only file that needs a document; the rest of the suite stays on `node`.
import { beforeEach, describe, expect, it, test } from "vitest";
import { watchEffect } from "vue";
import { copyCodeFromEvent, escapeHtml } from "@intentic/ui/markdown";
import { createStreamingMarkdown, markdownParseCount, renderMarkdown, settledEnd } from "./renderMarkdown";

// The one invariant that keeps a streamed chat bubble alive: renderMarkdown must NEVER throw and must always
// return a string, whatever it's handed — the assistant bubble re-runs it on every partial-markdown delta, so a
// single throw would blank the turn (the reported "undefined is not an object" crash class).
const INPUTS: unknown[] = [
    ``,
    `plain text`,
    `| A | St`, // mid table header
    `\`\`\`ts\nconst x =`, // unclosed code fence
    `- one\n- tw`, // mid list item
    `> quote\n\n# H\n\n[link](http://x.ai)`,
    `<div>raw <span>html`,
    `a`.repeat(50_000),
    undefined,
    null,
    123,
    { not: `a string` },
];

test("renderMarkdown never throws and always returns a string for any input", () => {
    for (const input of INPUTS) {
        // @ts-expect-error — deliberately exercising non-string inputs that could slip in mid-stream.
        const output = renderMarkdown(input);
        expect(typeof output).toBe(`string`);
    }
});

/* The placeholder the code renderer emits and the pattern that substitutes it are two halves of one seam, in
 * two different modules, joined across a round-trip through the sanitizer's DOM — these pin all three
 * together. Colour has not landed on a FIRST render (the grammar is imported on demand), which is exactly the
 * fallback state these assert; the describe below waits for it instead. */
describe(`code blocks`, () => {
    it(`substitutes a fenced block for the code-block markup, with its language label`, () => {
        const html = renderMarkdown("```ts\nconst a = 1;\n```");
        expect(html).toContain(`class="ui-code md-code"`);
        expect(html).toContain(`>ts</span>`);
        expect(html).toContain(`md-code-copy`);
        expect(html).not.toContain(`data-md-code`);
    });

    it(`renders the code inertly while highlighting is unavailable`, () => {
        const html = renderMarkdown("```html\n<script>alert(1)</script>\n```");
        expect(html).toContain(`&lt;script&gt;`);
        expect(html).not.toContain(`<script>`);
    });

    it(`handles a fence with no language`, () => {
        const html = renderMarkdown("```\nplain\n```");
        expect(html).toContain(`md-code`);
        expect(html).toContain(`plain`);
        // Nothing to name it with, so nothing is emitted to name it — the controls are an overlay, and an
        // empty chip in one would still be a box hanging over the code.
        expect(html).not.toContain(`md-code-lang`);
        expect(html).toContain(`aria-label="Copy code"`);
    });

    it(`names the language in the button's label, where hovering is not required to reach it`, () => {
        expect(renderMarkdown("```powershell\nGet-Service\n```")).toContain(`aria-label="Copy powershell code"`);
    });

    it(`keeps blocks distinct when a message has several`, () => {
        const html = renderMarkdown("```ts\nfirst();\n```\n\n```py\nsecond()\n```");
        expect(html).toContain(`first();`);
        expect(html).toContain(`second()`);
        expect(html).not.toContain(`data-md-code`);
    });
});

/* A fence info is what an author wrote, not a grammar id: a document names its dialect (`jsonc`), and a FIGURE
 * fence (figures.ts) names a picture — which reaches this renderer as a code block whenever the surface cannot
 * hold a component (one v-html string) or the body does not parse. Both bodies are JSON, so both are mapped onto
 * the grammar we ship rather than left grey. Colour is what proves the mapping: it appears only once a real
 * Shiki grammar has run over the block. */
describe(`fence infos mapped onto a shipped grammar`, () => {
    // Highlighting is asynchronous (the grammar is imported on demand) and lands by invalidating the render, so
    // this re-renders until colour shows up — false means it never did.
    const colours = async (source: string): Promise<boolean> => {
        let html = ``;
        const stop = watchEffect(
            () => {
                html = renderMarkdown(source);
            },
            { flush: `sync` },
        );
        for (let attempt = 0; attempt < 40 && !html.includes(`--shiki-dark:`); attempt += 1) {
            await new Promise((resolve) => setTimeout(resolve, 25));
        }
        stop();
        return html.includes(`--shiki-dark:`);
    };

    it(`colours a jsonc fence with the json grammar`, async () => {
        expect(await colours('```jsonc\n{ "a": 1 } // and a comment\n```')).toBe(true);
    });

    it(`colours a figure fence as the JSON its body is`, async () => {
        expect(await colours('```stats\n{ "items": [{ "label": "Files", "value": "70" }] }\n```')).toBe(true);
    });

    // The chip names what the author wrote, so a reader can tell which fence produced the block they are looking
    // at — aliasing decides the grammar, never the label.
    it(`still names the fence's own info string`, () => {
        expect(renderMarkdown('```jsonc\n{ "a": 1 }\n```')).toContain(`>jsonc</span>`);
    });
});

/* A whole answer that is nothing but a block marker parses to markup with no text in it, and the bubble then
 * renders an empty box — the turn reads as if the model never replied. Observed with a Haiku turn whose entire
 * answer was "4."; these pin the fallback that shows the source instead, and the markup it must NOT swallow. */
describe(`markup that would render invisibly`, () => {
    it(`shows a bare ordered-list marker as the text it is`, () => {
        expect(renderMarkdown(`4.`)).toContain(`4.`);
        expect(renderMarkdown(`4.`)).not.toContain(`<ol`);
    });

    it(`covers the other markers a one-line answer can be`, () => {
        for (const source of [`#`, `-`, `1)`, `>`]) {
            expect(renderMarkdown(source)).toContain(escapeHtml(source));
        }
    });

    it(`recovers the same way on a streaming tail frame`, () => {
        expect(createStreamingMarkdown().render(`4.`).tail).toContain(`4.`);
    });

    it(`leaves markup that is visible without text alone`, () => {
        expect(renderMarkdown(`---`)).toContain(`<hr>`);
        expect(renderMarkdown(`![a](x.png)`)).toContain(`<img`);
        expect(renderMarkdown("```\n\n```")).toContain(`md-code`);
    });

    it(`leaves ordinary prose and real lists alone`, () => {
        expect(renderMarkdown(`4. four`)).toContain(`<ol`);
        expect(renderMarkdown(`Done.`)).toBe(`<p>Done.</p>\n`);
    });
});

describe(`streaming split`, () => {
    const settledOf = (text: string): string => text.slice(0, settledEnd(text, 0));

    it(`settles a completed paragraph only once the next block has arrived`, () => {
        expect(settledOf(`Hello there.\n\n`)).toBe(``);
        expect(settledOf(`Hello there.\n\nNext`)).toBe(`Hello there.\n\n`);
    });

    it(`treats a blank line inside an OPEN fence as content, not a boundary`, () => {
        const text = "Intro\n\n```ts\nconst a = 1;\n\nconst b = 2;\n";
        expect(settledOf(text)).toBe("Intro\n\n");
    });

    it(`settles past a closed fence`, () => {
        const text = "```ts\nconst a = 1;\n```\n\nAfter";
        expect(settledOf(text)).toBe("```ts\nconst a = 1;\n```\n\n");
    });

    it(`refuses to split two list blocks — an ordered list would restart at 1`, () => {
        expect(settledOf(`1. first\n\n2. second\n\n3. third`)).toBe(``);
    });

    it(`still settles a paragraph that is followed by a list`, () => {
        expect(settledOf(`Steps:\n\n- one\n`)).toBe(`Steps:\n\n`);
    });

    it(`refuses to split before an indented continuation line`, () => {
        expect(settledOf(`- item\n\n    continued body\n`)).toBe(``);
    });

    it(`renders the settled part byte-identically across frames and only grows the tail`, () => {
        const stream = createStreamingMarkdown();
        const first = stream.render(`Done paragraph.\n\nStill wri`);
        const second = stream.render(`Done paragraph.\n\nStill writing here`);
        expect(first.settled).toBe(second.settled);
        expect(first.settled).toContain(`Done paragraph.`);
        expect(second.tail).toContain(`Still writing here`);
        expect(second.tail).not.toContain(`Done paragraph.`);
    });

    it(`concatenates to the same visible text as a whole-message render`, () => {
        const text = `# Title\n\nSome prose with \`code\`.\n\n- a\n- b\n\nTail sentence.`;
        const stream = createStreamingMarkdown();
        const { settled, tail } = stream.render(text);
        const strip = (html: string): string =>
            html
                .replace(/<[^>]*>/g, ``)
                .replace(/\s+/g, ` `)
                .trim();
        expect(strip(settled + tail)).toBe(strip(renderMarkdown(text)));
    });

    /* The reason the split exists. Streaming a message one character at a time, the settled prefix must be
     * re-parsed once per COMPLETED BLOCK, never once per frame — otherwise the cost of a turn is quadratic in
     * its own length. Only the short tail may be re-parsed every frame.
     *
     * Asserted as an exact count rather than a bound: if the prefix memo is ever dropped, this jumps from
     * frames + 3 to frames * 2 and fails loudly instead of quietly getting slower. */
    it(`re-parses the settled prefix once per completed block, not once per frame`, () => {
        const text = `Alpha paragraph.\n\nBeta paragraph.\n\nGamma paragraph.\n\nDelta tail`;
        const stream = createStreamingMarkdown();
        const before = markdownParseCount();
        for (let end = 1; end <= text.length; end += 1) {
            stream.render(text.slice(0, end));
        }
        // Three boundaries settle (each confirmed by the first character of the block after it), and every
        // frame parses the tail.
        expect(markdownParseCount() - before).toBe(text.length + 3);
    });

    it(`starts over when the source is rewritten rather than appended`, () => {
        const stream = createStreamingMarkdown();
        stream.render(`First version.\n\nMore text`);
        const rewritten = stream.render(`Different entirely.\n\nOther`);
        expect(rewritten.settled).toContain(`Different entirely.`);
        expect(rewritten.settled).not.toContain(`First version.`);
    });
});

/* A document's colour must not cost a re-render per code block. Each landing highlight bumps the shared
 * `highlightVersion`, which invalidates every markdown computed that read it — so a per-highlight bump made a
 * document re-render once per block, each pass re-scheduling the next. Measured on a 1.9 MiB file with 3353
 * blocks (~500ms of script and 1283ms of layout per pass, all in microtasks), the tab never came back.
 *
 * Bounded two ways now, and this pins both: at most MAX_HIGHLIGHT_BLOCKS blocks of one document are scheduled,
 * and the bump waits for the batch to drain so the whole document re-renders once rather than N times. */
describe(`code block highlighting is bounded`, () => {
    const doc = (blocks: number): string =>
        Array.from({ length: blocks }, (_, i) => `Prose ${i}\n\n\`\`\`ts\nexport const thing${i} = ${i};\n\`\`\`\n`).join(`\n`);

    it(`re-renders a heavily fenced document a bounded number of times, not once per block`, async () => {
        const source = doc(400);
        let renders = 0;
        const stop = watchEffect(
            () => {
                renderMarkdown(source);
                renders += 1;
            },
            { flush: `sync` },
        );
        // A timer only fires if the render loop actually yields — the storm ran entirely in microtasks and
        // starved timers outright, so reaching this line at all is part of what's being asserted.
        await new Promise((resolve) => setTimeout(resolve, 500));
        stop();
        // One initial render, plus at most a couple as batches of colour settle. The storm was ~400.
        expect(renders).toBeLessThanOrEqual(5);
        expect(renders).toBeGreaterThan(0);
    });
});

/* The copy control, wired the way a prose surface wires it: one delegated listener on the container, bound to
 * the press AND the click, over markup that lives inside v-html.
 *
 * The regression these exist for: a click is only delivered to the button if the same element is under the
 * pointer at press and at release, and a streaming turn rewrites its markdown every animation frame. The
 * button pressed was gone before the mouse came up, so the click resolved to an ancestor and copying a block
 * out of an answer still being written did nothing at all. */
describe(`code block copy`, () => {
    const surface = (html: string): HTMLElement => {
        const container = document.createElement(`div`);
        container.className = `md-prose`;
        container.innerHTML = html;
        container.addEventListener(`pointerdown`, copyCodeFromEvent);
        container.addEventListener(`click`, copyCodeFromEvent);
        document.body.replaceChildren(container);
        return container;
    };

    // jsdom ships no clipboard at all. Resolves like a granted one, and records what a surface handed it.
    const written: string[] = [];
    beforeEach(() => {
        written.length = 0;
        Object.defineProperty(navigator, `clipboard`, {
            configurable: true,
            value: {
                writeText: (text: string): Promise<void> => {
                    written.push(text);
                    return Promise.resolve();
                },
            },
        });
    });

    const press = (button: Element, init: MouseEventInit = {}): void => {
        button.dispatchEvent(new MouseEvent(`pointerdown`, { bubbles: true, ...init }));
    };

    it(`copies the block's code on the press`, async () => {
        const container = surface(renderMarkdown("```ts\nexport const pressed = 1;\n```"));
        press(container.querySelector(`.md-code-copy`) as Element);
        await Promise.resolve();
        expect(written).toEqual([`export const pressed = 1;`]);
    });

    it(`still copies when the block's DOM is replaced before the mouse comes up`, async () => {
        const source = "```ts\nexport const streamed = 2;\n```";
        const container = surface(renderMarkdown(source));
        press(container.querySelector(`.md-code-copy`) as Element);
        // The frame that lands between press and release: a new render, a whole new subtree.
        container.innerHTML = renderMarkdown(`${source}\n\nAnd the next sentence arrives.`);
        container.dispatchEvent(new MouseEvent(`click`, { bubbles: true }));
        await Promise.resolve();
        // Once — the click that followed the press asked for the same text, which the copied state absorbs.
        expect(written).toEqual([`export const streamed = 2;`]);
    });

    it(`shows the acknowledgment on the renders that follow, not by poking the button`, async () => {
        const source = "```ts\nexport const flashed = 3;\n```";
        const container = surface(renderMarkdown(source));
        press(container.querySelector(`.md-code-copy`) as Element);
        await Promise.resolve();
        // The button element pressed is long gone by now in a live turn; what carries the state is the render.
        const after = renderMarkdown(source);
        expect(after).toContain(`md-code-copied`);
        expect(after).toContain(`>Copied</button>`);
        // Only the block that was copied — a document's other blocks are untouched by it.
        expect(renderMarkdown("```ts\nexport const other = 4;\n```")).not.toContain(`md-code-copied`);
    });

    it(`ignores a press that is not the primary button`, async () => {
        const container = surface(renderMarkdown("```ts\nexport const rightClicked = 5;\n```"));
        press(container.querySelector(`.md-code-copy`) as Element, { button: 2 });
        await Promise.resolve();
        expect(written).toEqual([]);
    });

    /* THE POP-OUT. A popped-out panel's DOM is teleported into a second real window while this realm keeps
     * running the JS, so the module-global `navigator` belongs to a document the user is NOT focused on — and
     * Chrome refuses a clipboard write from an unfocused document, silently, which is exactly what "the Copy
     * button does nothing out here" was. The write must therefore go through the button's OWN window. An
     * iframe stands in for the pop-out: a second same-origin realm with its own document and navigator. */
    it(`writes through the window the button lives in, not this realm's`, async () => {
        const frame = document.createElement(`iframe`);
        document.body.appendChild(frame);
        const other = frame.contentWindow as Window & typeof globalThis;
        const outThere: string[] = [];
        Object.defineProperty(other.navigator, `clipboard`, {
            configurable: true,
            value: { writeText: (text: string): Promise<void> => (outThere.push(text), Promise.resolve()) },
        });
        const container = other.document.createElement(`div`);
        container.innerHTML = renderMarkdown("```ts\nexport const poppedOut = 7;\n```");
        container.addEventListener(`pointerdown`, copyCodeFromEvent);
        other.document.body.replaceChildren(container);

        (container.querySelector(`.md-code-copy`) as HTMLElement).dispatchEvent(new other.MouseEvent(`pointerdown`, { bubbles: true }));
        await Promise.resolve();

        expect(outThere).toEqual([`export const poppedOut = 7;`]);
        expect(written).toEqual([]);
    });

    it(`works from the keyboard, where a click is the only event raised`, async () => {
        const container = surface(renderMarkdown("```ts\nexport const keyed = 6;\n```"));
        (container.querySelector(`.md-code-copy`) as HTMLElement).dispatchEvent(new MouseEvent(`click`, { bubbles: true }));
        await Promise.resolve();
        expect(written).toEqual([`export const keyed = 6;`]);
    });
});
