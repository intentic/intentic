// @vitest-environment jsdom
//
// What a ```mermaid fence does once it is mounted. figures.test.ts covers the fence as data; this file covers the
// half of the contract that only exists at render time, because mermaid's own parser is the validator and it
// arrives behind a lazy import — a body it accepts is drawn, a body it refuses becomes an ordinary code block
// with the source still in it.
//
// Mermaid is the REAL one here, not a stub. Mocking it would have left the interesting half untested: whether a
// diagram draws at all is the entire point of the feature, and a mock that resolves with an <svg> string proves
// only that v-html works. What the mock would have bought — a jsdom that can render SVG — costs three lines of
// text metrics instead (below).
import { describe, expect, it, vi } from "vitest";
import { createApp, h } from "vue";

/* jsdom gaps, filled in `vi.hoisted` so they land BEFORE the imports below rather than in a beforeAll that would
 * run too late. None of them is the code's fault, and each one left unstubbed fails in a way that reads as a
 * figure bug.
 *
 * `matchMedia`: the design-system barrel has import-time side effects (useDevice reads it while Picker's module
 * body evaluates) — which is exactly why the markdown ENGINE ships on its own subpath. This file needs the
 * component, so it pays the barrel's cost. `ResizeObserver`: Vue Flow measures its container on mount.
 *
 * The SVG metrics are what mermaid lays a diagram out with — it measures every label by rendering it and asking
 * for its box. jsdom has no layout, so it ships none of these, and without them every diagram takes the refusal
 * path. The boxes are fictional, which is fine: what is asserted below is that a diagram is DRAWN, never where
 * anything landed. `getContext` is stubbed to null (jsdom's own answer, minus the "not implemented" noise) —
 * that is the no-canvas path in mermaidTheme.ts, where mermaid's built-in palette stands in for the app's. */
vi.hoisted(() => {
    globalThis.matchMedia ??= ((query: string) => ({
        matches: false,
        media: query,
        onchange: null,
        addEventListener: () => {},
        removeEventListener: () => {},
        addListener: () => {},
        removeListener: () => {},
        dispatchEvent: () => false,
    })) as unknown as typeof matchMedia;
    globalThis.ResizeObserver ??= class {
        observe(): void {}
        unobserve(): void {}
        disconnect(): void {}
    } as unknown as typeof ResizeObserver;
});

import { Markdown } from "@intentic/ui";

const identity = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };
Object.assign(SVGElement.prototype, {
    getBBox: () => ({ x: 0, y: 0, width: 120, height: 20 }),
    getComputedTextLength: () => 120,
    getScreenCTM: () => ({ ...identity, inverse: () => identity }),
});
HTMLCanvasElement.prototype.getContext = (): null => null;

const render = (source: string): HTMLElement => {
    const host = document.createElement(`div`);
    document.body.append(host);
    const app = createApp({ render: () => h(Markdown, { source }) });
    // The real app registers `v-tooltip` globally in installUi(); registered as a no-op rather than installing
    // the whole design system, which would drag PrimeVue's theme in for a directive nothing here asserts on.
    app.directive(`tooltip`, {});
    app.mount(host);
    return host;
};

// A diagram is a queued dynamic import followed by an awaited render, so the DOM settles some way after mount
// rather than synchronously.
const settled = (host: HTMLElement, selector: string): Promise<void> =>
    vi.waitFor(() => {
        expect(host.querySelector(selector)).not.toBeNull();
    });

describe(`<Markdown> with a mermaid fence`, () => {
    it(`draws the diagram, and keeps the prose either side of it`, async () => {
        const host = render(`Before.\n\n\`\`\`mermaid\nflowchart LR\n    a["One"] --> b["Two"]\n\`\`\`\n\nAfter.`);
        await settled(host, `.md-mermaid svg`);
        // A flowchart, not mermaid's error card — which this build cannot produce anyway (suppressErrorRendering),
        // but the class is what says the fence was understood as the diagram type it named.
        expect(host.querySelector(`.md-mermaid svg`)?.getAttribute(`class`)).toContain(`flowchart`);
        expect(host.querySelector(`.md-mermaid`)?.textContent).toContain(`One`);
        const runs = host.querySelectorAll(`.md-run`);
        expect(runs).toHaveLength(2);
        expect(runs[0]?.textContent).toContain(`Before.`);
        expect(runs[1]?.textContent).toContain(`After.`);
    });

    it(`falls back to a code block holding the source when mermaid refuses the body`, async () => {
        const host = render(`\`\`\`mermaid\nflowchart LR\n    a -->\n\`\`\``);
        await settled(host, `code`);
        expect(host.querySelector(`svg`)).toBeNull();
        expect(host.querySelector(`code`)?.textContent).toContain(`flowchart LR`);
        // Same chrome as any other fenced block, copy button included — the reader can take the source away.
        expect(host.querySelector(`.md-code-copy`)).not.toBeNull();
    });

    it(`leaves an empty mermaid fence as a plain code block, with no diagram attempted`, async () => {
        const host = render(`\`\`\`mermaid\n\n\`\`\``);
        await settled(host, `pre`);
        expect(host.querySelector(`.md-mermaid`)).toBeNull();
    });
});
