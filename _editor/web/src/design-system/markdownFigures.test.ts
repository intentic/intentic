// @vitest-environment jsdom
// Rendering, not parsing: figures.test.ts covers the fence vocabulary as data; this file proves a document carrying
// those fences reaches the DOM as components, and that a document without them still renders in the single-root shape
// every surface depends on.
import { describe, expect, it, vi } from "vitest";
import { createApp, h } from "vue";

// Two jsdom gaps this file depends on, both filled for the package by vitest.setup.ts before this file loads.
// `matchMedia`: the design-system barrel has import-time side effects (useDevice, Picker). `ResizeObserver`: Vue Flow
// measures its container on mount, reached through DagGraph.

import { Markdown } from "@intentic/ui";

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

describe(`<Markdown> with figures`, () => {
    it(`renders a document with no figures as ONE element with no run wrappers`, () => {
        // This is a safety property, not an optimisation: `.md-prose > :first-child` is a direct-child rule, so
        // wrapping plain prose in a run div would shift spacing across the whole app.
        const host = render(`## Title\n\nSome prose.`);
        const prose = host.querySelector(`.md-prose`);
        expect(prose).not.toBeNull();
        expect(prose?.querySelector(`.md-run`)).toBeNull();
        expect(prose?.firstElementChild?.tagName).toBe(`H2`);
    });

    it(`renders a bars figure as a figure with one row per item and the value at the tip`, () => {
        const host = render(
            `Before.\n\n\`\`\`bars\n{ "title": "Lines of code", "items": [{ "label": "_editor/web", "value": 77114, "display": "77.1k" }, { "label": "_editor/ui", "value": 7397 }] }\n\`\`\`\n\nAfter.`,
        );
        const figure = host.querySelector(`figure`);
        expect(figure?.querySelector(`figcaption`)?.textContent).toBe(`Lines of code`);
        expect(figure?.querySelectorAll(`li`)).toHaveLength(2);
        // The authored tip label wins; a bar without one prints the number thousands-separated.
        expect(figure?.textContent).toContain(`77.1k`);
        expect(figure?.textContent).toContain(`7,397`);
        // Prose either side survives, in order, as its own runs.
        const runs = host.querySelectorAll(`.md-run`);
        expect(runs).toHaveLength(2);
        expect(runs[0]?.textContent).toContain(`Before.`);
        expect(runs[1]?.textContent).toContain(`After.`);
    });

    it(`renders a stats figure as a description list of label/value pairs`, () => {
        const host = render(`\`\`\`stats\n{ "items": [{ "label": "Packages", "value": "53", "note": "18 with tests" }] }\n\`\`\``);
        const list = host.querySelector(`dl`);
        expect(list?.querySelector(`dt`)?.textContent).toBe(`Packages`);
        expect(list?.textContent).toContain(`53`);
        expect(list?.textContent).toContain(`18 with tests`);
    });

    // A dag figure is asserted down to its frame and no further: Vue Flow refuses to lay out nodes in a container jsdom
    // measures as zero-sized, so node cards genuinely cannot render here. What is checked: the fence became a figure,
    // it is captioned, and it mounted a graph with an explicit height.
    // Awaited, unlike other figure kinds: the dag is the one branch MarkdownFigure imports lazily, arriving a microtask
    // after mount. The timeout bounds a hang; a busy CI runner can make the import itself take far longer than idle.
    it(`renders a dag figure as a captioned, explicitly sized graph frame`, async () => {
        const host = render(
            `\`\`\`dag\n{ "title": "The wire", "nodes": [{ "id": "web", "label": "Browser app", "note": "Vue" }, { "id": "daemon", "label": "Daemon" }], "edges": [{ "from": "web", "to": "daemon" }] }\n\`\`\``,
        );
        await vi.waitFor(
            () => {
                expect(host.querySelector(`figure`)).not.toBeNull();
            },
            { timeout: 10_000 },
        );
        const figure = host.querySelector(`figure`);
        expect(figure?.querySelector(`figcaption`)?.textContent).toBe(`The wire`);
        // The frame carries its own height because prose cannot host a canvas of unknown height.
        const frame = figure?.querySelector<HTMLElement>(`div[style*="height"]`);
        expect(frame?.style.height).toMatch(/^\d+(\.\d+)?rem$/);
        expect(frame?.querySelector(`.vue-flow`)).not.toBeNull();
    });

    it(`renders a MALFORMED figure fence as an ordinary code block, keeping the source visible`, () => {
        // The whole reason figures are fences rather than a JSON document model: a broken one costs one figure and
        // shows the reader what was meant, instead of blanking the page.
        const host = render(`\`\`\`dag\n{ "nodes": [ oops\n\`\`\``);
        expect(host.querySelector(`figure`)).toBeNull();
        expect(host.querySelector(`code`)?.textContent).toContain(`oops`);
    });

    it(`still renders code blocks and file-link-shaped prose beside a figure`, () => {
        const host = render(`\`\`\`ts\nconst x = 1;\n\`\`\`\n\n\`\`\`stats\n{ "items": [{ "label": "A", "value": "1" }] }\n\`\`\``);
        expect(host.querySelector(`code`)?.textContent).toContain(`const x = 1;`);
        expect(host.querySelector(`dl`)).not.toBeNull();
    });
});
