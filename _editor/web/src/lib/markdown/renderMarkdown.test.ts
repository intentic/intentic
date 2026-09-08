// @vitest-environment jsdom
// Needs jsdom: DOMPurify has no `sanitize` under node, and happy-dom strips tags but keeps `<script>` content, worse
// than nothing. Only this file needs a document; the rest of the suite stays on node.
import { beforeEach, describe, expect, it, test } from "vitest";
import { watchEffect } from "vue";
import { copyCodeFromEvent, escapeHtml } from "@intentic/ui/markdown";
import { createStreamingMarkdown, markdownParseCount, renderMarkdown, type RenderedMarkdown, settledEnd } from "./renderMarkdown";

// A rendered document is a list of parts: prose runs as HTML, figures as data. These read it as a reader would see
// it: which run is which. `prose` is not the whole document; a figure has no html.
const prose = (parts: RenderedMarkdown): string => parts.flatMap((part) => (part.kind === `html` ? [part.html] : [])).join(``);
const runs = (parts: RenderedMarkdown): number => parts.filter((part) => part.kind === `html`).length;

// renderMarkdown must never throw and always returns a string, since the chat bubble re-runs it every delta.
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
        // @ts-expect-error: deliberately exercising non-string inputs that could slip in mid-stream.
        const output = renderMarkdown(input);
        expect(typeof output).toBe(`string`);
    }
});

// The code-block placeholder and the pattern replacing it are two halves of one seam, joined through the sanitizer's
// DOM. Colour hasn't landed on a first render (grammar loads on demand); that's the fallback state asserted here.
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

// A fence info is what an author wrote (`jsonc`), not a grammar id; a figure fence (figures.ts) reaches here as a
// code block when it can't render as a component. Both map onto a shipped grammar; colour proves the mapping ran.
describe(`fence infos mapped onto a shipped grammar`, () => {
    // Highlighting loads asynchronously and lands via re-render; polls until colour shows or the deadline passes. Sized
    // generous since the whole colour stack (Shiki core, themes, grammar) loads cold, still under `testTimeout`.
    const DEADLINE_MS = 10_000;
    const colours = async (source: string): Promise<boolean> => {
        let html = ``;
        const stop = watchEffect(
            () => {
                html = renderMarkdown(source);
            },
            { flush: `sync` },
        );
        const until = performance.now() + DEADLINE_MS;
        while (!html.includes(`--shiki-dark:`) && performance.now() < until) {
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

    // Names the fence's own info string, not the resolved grammar: aliasing decides highlighting, never the label.
    it(`still names the fence's own info string`, () => {
        expect(renderMarkdown('```jsonc\n{ "a": 1 }\n```')).toContain(`>jsonc</span>`);
    });
});

// A whole answer that is only a block marker (`4.`, `-`, `#`) parses to markup with no visible text; the bubble
// renders an empty box. This pins the fallback that shows the source instead, without swallowing visible markup.
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
        expect(prose(createStreamingMarkdown(() => undefined).render(`4.`))).toContain(`4.`);
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

// Headings: ATX h1-h4 (styled) plus h5/h6 (marked produces, prose.css does not style). Heading text must come
// through as its element, not escaped source, so the surface can style it and the outline can find it.
describe(`headings`, () => {
    it(`renders ## as an h2`, () => {
        expect(renderMarkdown(`## Section`)).toContain(`<h2>`);
        expect(renderMarkdown(`## Section`)).toContain(`Section`);
    });

    it(`renders every ATX level`, () => {
        expect(renderMarkdown(`# One`)).toContain(`<h1>`);
        expect(renderMarkdown(`## Two`)).toContain(`<h2>`);
        expect(renderMarkdown(`### Three`)).toContain(`<h3>`);
        expect(renderMarkdown(`#### Four`)).toContain(`<h4>`);
    });

    it(`renders a setext h2 (underlined with dashes)`, () => {
        expect(renderMarkdown(`Heading\n------`)).toContain(`<h2>`);
    });

    it(`preserves inline markup inside a heading`, () => {
        const html = renderMarkdown(`## The **bold** part`);
        expect(html).toContain(`<h2>`);
        expect(html).toContain(`<strong>bold</strong>`);
    });

    it(`renders headings inside a full document with prose around them`, () => {
        const html = renderMarkdown(`# Title\n\nIntro paragraph.\n\n## Section\n\nBody text.`);
        expect(html).toContain(`<h1>`);
        expect(html).toContain(`<h2>`);
        expect(html).toContain(`Intro paragraph.`);
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

    it(`refuses to split two list blocks: an ordered list would restart at 1`, () => {
        expect(settledOf(`1. first\n\n2. second\n\n3. third`)).toBe(``);
    });

    it(`still settles a paragraph that is followed by a list`, () => {
        expect(settledOf(`Steps:\n\n- one\n`)).toBe(`Steps:\n\n`);
    });

    it(`refuses to split before an indented continuation line`, () => {
        expect(settledOf(`- item\n\n    continued body\n`)).toBe(``);
    });

    // Byte-identical prevents Vue from patching that v-html, preserving the DOM, and any text selected in it, while
    // the tail keeps writing.
    it(`renders the settled part byte-identically across frames and only grows the tail`, () => {
        const stream = createStreamingMarkdown(() => undefined);
        const first = stream.render(`Done paragraph.\n\nStill wri`);
        const second = stream.render(`Done paragraph.\n\nStill writing here`);
        expect(first[0]).toEqual(second[0]);
        expect(prose(first.slice(0, 1))).toContain(`Done paragraph.`);
        expect(prose(second.slice(1))).toContain(`Still writing here`);
        expect(prose(second.slice(1))).not.toContain(`Done paragraph.`);
    });

    it(`concatenates to the same visible text as a whole-message render`, () => {
        const text = `# Title\n\nSome prose with \`code\`.\n\n- a\n- b\n\nTail sentence.`;
        const stream = createStreamingMarkdown(() => undefined);
        const strip = (html: string): string =>
            html
                .replace(/<[^>]*>/g, ``)
                .replace(/\s+/g, ` `)
                .trim();
        expect(strip(prose(stream.render(text)))).toBe(strip(renderMarkdown(text)));
    });

    // Re-parsing the settled prefix every frame would make a turn's cost quadratic in its length; only the tail
    // re-parses per frame. An exact count means a dropped memo fails loudly instead of just getting slower.
    it(`re-parses the settled prefix once per completed block, not once per frame`, () => {
        const text = `Alpha paragraph.\n\nBeta paragraph.\n\nGamma paragraph.\n\nDelta tail`;
        const stream = createStreamingMarkdown(() => undefined);
        const before = markdownParseCount();
        for (let end = 1; end <= text.length; end += 1) {
            stream.render(text.slice(0, end));
        }
        // Three boundaries settle (each confirmed by the next block's first character); every frame parses the tail.
        expect(markdownParseCount() - before).toBe(text.length + 3);
    });

    it(`starts over when the source is rewritten rather than appended`, () => {
        const stream = createStreamingMarkdown(() => undefined);
        stream.render(`First version.\n\nMore text`);
        const rewritten = stream.render(`Different entirely.\n\nOther`);
        expect(prose(rewritten)).toContain(`Different entirely.`);
        expect(prose(rewritten)).not.toContain(`First version.`);
    });
});

// A live turn renders figures as it streams, since a diagram is often the last thing written and the turn runs on after
// it. Mermaid's own question is whether it can draw a body; this pins when a fence becomes a figure as the text grows.
describe(`streaming a document with a figure in it`, () => {
    const DIAGRAM = '```mermaid\nflowchart LR\n    a["One"] --> b["Two"]\n```';

    it(`leaves a half-written fence as prose, so no diagram is drawn from a partial body`, () => {
        const stream = createStreamingMarkdown(() => undefined);
        const parts = stream.render('Here it is.\n\n```mermaid\nflowchart LR\n    a["One"] -->');
        expect(parts.every((part) => part.kind === `html`)).toBe(true);
        expect(prose(parts)).toContain(`flowchart LR`);
    });

    // A closed fence with nothing after it would never settle, holding it as arrow syntax until the turn ends.
    it(`draws a closed fence the answer ends on, without waiting for a block after it`, () => {
        const stream = createStreamingMarkdown(() => undefined);
        const parts = stream.render(`Here it is.\n\n${DIAGRAM}`);
        expect(parts.filter((part) => part.kind === `figure`)).toHaveLength(1);
        expect(prose(parts)).toContain(`Here it is.`);
        expect(prose(parts)).not.toContain(`flowchart LR`);
    });

    // A figure comes back by identity while its prefix is unchanged, so mermaid never redraws, re-imports its
    // grammars, or flashes its placeholder mid-answer.
    it(`hands back the same figure as the turn writes on`, () => {
        const stream = createStreamingMarkdown(() => undefined);
        const before = stream.render(`Intro.\n\n${DIAGRAM}\n\nAfter.\n\nStill wri`);
        const after = stream.render(`Intro.\n\n${DIAGRAM}\n\nAfter.\n\nStill writing here`);
        const figure = before.find((part) => part.kind === `figure`);
        expect(figure).toEqual(expect.any(Object));
        expect(after.find((part) => part.kind === `figure`)).toBe(figure);
    });

    it(`cuts the document into runs around the figure, in reading order`, () => {
        const stream = createStreamingMarkdown(() => undefined);
        const parts = stream.render(`Intro.\n\n${DIAGRAM}\n\nAfter.\n\nTail`);
        expect(parts.map((part) => part.kind)).toEqual([`html`, `figure`, `html`, `html`]);
        expect(runs(parts)).toBe(3);
        expect(prose(parts.slice(0, 1))).toContain(`Intro.`);
        expect(prose(parts.slice(2))).toContain(`After.`);
    });
});

// A shared `highlightVersion` bump invalidates every markdown computed reading it, so an unbatched bump re-renders
// once per block. Bounded two ways: MAX_HIGHLIGHT_BLOCKS scheduled at most, and the bump waits for the batch to drain.
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
        // A timer fires only once the loop yields; the storm ran in microtasks, so reaching here matters too.
        await new Promise((resolve) => setTimeout(resolve, 500));
        stop();
        // One initial render, plus at most a couple as colour batches settle.
        expect(renders).toBeLessThanOrEqual(5);
        expect(renders).toBeGreaterThan(0);
    });
});

// One delegated listener on the container, bound to press and click, over markup living inside v-html. Exists because a
// streaming re-render can swap the pressed button before release, so a plain click handler would silently miss.
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

    // jsdom has no clipboard; this stub resolves like a granted one and records what was written.
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
        // Simulates the render that lands between press and release: a whole new subtree.
        container.innerHTML = renderMarkdown(`${source}\n\nAnd the next sentence arrives.`);
        container.dispatchEvent(new MouseEvent(`click`, { bubbles: true }));
        await Promise.resolve();
        // Once: the trailing click asks for the same text again, absorbed by the already-copied state.
        expect(written).toEqual([`export const streamed = 2;`]);
    });

    it(`shows the acknowledgment on the renders that follow, not by poking the button`, async () => {
        const source = "```ts\nexport const flashed = 3;\n```";
        const container = surface(renderMarkdown(source));
        press(container.querySelector(`.md-code-copy`) as Element);
        await Promise.resolve();
        // The pressed button is gone in a live turn; the render itself carries the copied state.
        const after = renderMarkdown(source);
        expect(after).toContain(`md-code-copied`);
        expect(after).toContain(`>Copied</button>`);
        // Only the block that was copied: a document's other blocks are untouched by it.
        expect(renderMarkdown("```ts\nexport const other = 4;\n```")).not.toContain(`md-code-copied`);
    });

    it(`ignores a press that is not the primary button`, async () => {
        const container = surface(renderMarkdown("```ts\nexport const rightClicked = 5;\n```"));
        press(container.querySelector(`.md-code-copy`) as Element, { button: 2 });
        await Promise.resolve();
        expect(written).toEqual([]);
    });

    // Chrome refuses a clipboard write from an unfocused document, so the module-global `navigator` fails when the
    // button is in another realm. The write goes through the button's own window; an iframe stands in for that realm.
    it(`writes through the window the button lives in, not this realm's`, async () => {
        const frame = document.createElement(`iframe`);
        document.body.appendChild(frame);
        const other = frame.contentWindow as Window & typeof globalThis;
        const outThere: string[] = [];
        Object.defineProperty(other.navigator, `clipboard`, {
            configurable: true,
            value: {
                writeText: (text: string): Promise<void> => {
                    outThere.push(text);
                    return Promise.resolve();
                },
            },
        });
        const container = other.document.createElement(`div`);
        container.innerHTML = renderMarkdown("```ts\nexport const elsewhere = 7;\n```");
        container.addEventListener(`pointerdown`, copyCodeFromEvent);
        other.document.body.replaceChildren(container);

        (container.querySelector(`.md-code-copy`) as HTMLElement).dispatchEvent(new other.MouseEvent(`pointerdown`, { bubbles: true }));
        await Promise.resolve();

        expect(outThere).toEqual([`export const elsewhere = 7;`]);
        expect(written).toEqual([]);
    });

    it(`works from the keyboard, where a click is the only event raised`, async () => {
        const container = surface(renderMarkdown("```ts\nexport const keyed = 6;\n```"));
        (container.querySelector(`.md-code-copy`) as HTMLElement).dispatchEvent(new MouseEvent(`click`, { bubbles: true }));
        await Promise.resolve();
        expect(written).toEqual([`export const keyed = 6;`]);
    });
});
