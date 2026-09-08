// @vitest-environment jsdom
// What a ```mermaid fence does once mounted: figures.test.ts covers the fence as data, this file covers render time,
// since mermaid's own parser is the validator and arrives behind a lazy import. Mermaid is the real library here, not a
// stub: whether a diagram draws at all is the point of the feature.
import { beforeAll, describe, expect, it, vi } from "vitest";
import { createApp, h } from "vue";

// jsdom gaps, none the code's fault. `matchMedia`/`ResizeObserver` are filled package-wide by vitest.setup.ts. The SVG
// metrics below are what mermaid lays a diagram out with (it measures labels by rendering and asking their box); jsdom
// ships none, so they are stubbed with fictional boxes. `getContext` stubs to null, the no-canvas path in
// mermaidTheme.ts.

import { Markdown } from "@intentic/ui";
import { ICONS } from "../../../ui/src/icons/iconSets.js";

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
    // The real app registers `v-tooltip` globally; registered here as a no-op instead of installing the whole design
    // system, which would drag in PrimeVue's theme for a directive nothing here asserts on.
    app.directive(`tooltip`, {});
    app.mount(host);
    return host;
};

// A diagram is a queued dynamic import followed by an awaited render, so the DOM settles some time after mount. The
// timeout bounds a hang rather than measuring latency: a busy CI runner can make the import itself cost far more than
// idle.
const settled = (host: HTMLElement, selector: string): Promise<void> =>
    vi.waitFor(
        () => {
            expect(host.querySelector(selector)).not.toBeNull();
        },
        { timeout: 10_000 },
    );

describe(`<Markdown> with a mermaid fence`, () => {
    // One throwaway diagram, drawn before anything is asserted, purely to pay for mermaid's import cost once for the
    // file rather than charging it to whichever test happens to mount first. Torn down so no assertion can see it.
    beforeAll(async () => {
        const host = render('```mermaid\nflowchart LR\n    warm["Warm"] --> up["Up"]\n```');
        await settled(host, `.md-mermaid svg`);
        host.remove();
    });

    it(`draws the diagram, and keeps the prose either side of it`, async () => {
        const host = render(`Before.\n\n\`\`\`mermaid\nflowchart LR\n    a["One"] --> b["Two"]\n\`\`\`\n\nAfter.`);
        await settled(host, `.md-mermaid svg`);
        // A flowchart, not mermaid's error card (this build cannot produce one, see suppressErrorRendering); the class
        // says the fence was understood as the diagram type it named.
        expect(host.querySelector(`.md-mermaid svg`)?.getAttribute(`class`)).toContain(`flowchart`);
        expect(host.querySelector(`.md-mermaid`)?.textContent).toContain(`One`);
        const runs = host.querySelectorAll(`.md-run`);
        expect(runs).toHaveLength(2);
        expect(runs[0]?.textContent).toContain(`Before.`);
        expect(runs[1]?.textContent).toContain(`After.`);
    });

    it(`draws the app's native icon inside a Mermaid diagram`, async () => {
        const host = render('```mermaid\nflowchart LR\n A@{ icon: "intentic:server", form: "square", label: "Compute" } --> B[Ready]\n```');
        await settled(host, `.md-mermaid svg`);
        expect([...host.querySelectorAll(`.md-mermaid path`)].map((path) => path.getAttribute(`d`))).toContain(ICONS.server.outline);
        expect(host.querySelector(`.md-mermaid`)?.textContent).toContain(`Compute`);
    });

    it(`falls back to a code block holding the source when mermaid refuses the body`, async () => {
        const host = render(`\`\`\`mermaid\nflowchart LR\n    a -->\n\`\`\``);
        await settled(host, `code`);
        expect(host.querySelector(`svg`)).toBeNull();
        expect(host.querySelector(`code`)?.textContent).toContain(`flowchart LR`);
        // Same chrome as any other fenced block, copy button included: the reader can take the source away.
        expect(host.querySelector(`.md-code-copy`)).not.toBeNull();
    });

    it(`leaves an empty mermaid fence as a plain code block, with no diagram attempted`, async () => {
        const host = render(`\`\`\`mermaid\n\n\`\`\``);
        await settled(host, `pre`);
        expect(host.querySelector(`.md-mermaid`)).toBeNull();
    });
});
