// @vitest-environment jsdom
//
// Rendering, not parsing: figures.test.ts covers the fence vocabulary as data, and this file is the proof that a
// document carrying those fences actually reaches the DOM as components — and, just as important, that a document
// WITHOUT them still renders in the single-root shape every existing surface depends on.
//
// Mounted with plain Vue rather than @vue/test-utils, which this workspace does not depend on and which is not
// worth adding for four assertions.
import { describe, expect, it, vi } from "vitest";
import { createApp, h } from "vue";

/* Two jsdom gaps, filled in `vi.hoisted` so they land BEFORE the imports below rather than in a beforeAll that
 * would run too late. Both are the environment's fault rather than the code's, and left unstubbed they fail at
 * import or mount time in a way that reads as a figure bug.
 *
 * `matchMedia`: the design-system barrel has import-time side effects (useDevice's `track` calls it while Picker's
 * module body evaluates) — which is exactly why the markdown ENGINE ships on its own subpath. This file needs the
 * component, so it pays the barrel's cost.
 * `ResizeObserver`: Vue Flow measures its container on mount, reached here through DagGraph. */
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

const render = (source: string): HTMLElement => {
    const host = document.createElement(`div`);
    document.body.append(host);
    const app = createApp({ render: () => h(Markdown, { source }) });
    // The real app registers `v-tooltip` globally in installUi(); the kit's components (BarChart's truncated labels,
    // DagGraph's node cards) assume it is there. Registered as a no-op rather than installing the whole design
    // system, which would drag PrimeVue's theme in for a directive nothing here asserts on.
    app.directive(`tooltip`, {});
    app.mount(host);
    return host;
};

describe(`<Markdown> with figures`, () => {
    it(`renders a document with no figures as ONE element with no run wrappers`, () => {
        // This is the safety property, not an optimisation: `.md-prose > :first-child` is a direct-child rule, so
        // wrapping every chat bubble's prose in a run div would have shifted spacing across the whole app.
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

    /* A dag figure is asserted down to its FRAME and no further. Vue Flow refuses to lay out nodes in a container it
     * measures as zero-sized ("The Vue Flow parent container needs a width and a height"), and jsdom reports zero for
     * everything — so the node cards genuinely cannot render here, and asserting on them would be asserting on jsdom.
     * What is checked is everything up to that boundary: the fence became a figure, it is captioned, and it mounted a
     * graph with an explicit height. The node mapping itself is covered by typing plus figures.test.ts, and the
     * rendering below it is DagGraph's, which the app already relies on elsewhere. */
    it(`renders a dag figure as a captioned, explicitly sized graph frame`, () => {
        const host = render(
            `\`\`\`dag\n{ "title": "The wire", "nodes": [{ "id": "web", "label": "Browser app", "note": "Vue" }, { "id": "daemon", "label": "Daemon" }], "edges": [{ "from": "web", "to": "daemon" }] }\n\`\`\``,
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
