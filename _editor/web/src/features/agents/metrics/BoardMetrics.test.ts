import "@intentic/testing/dom";
import type { SandboxMetrics } from "@intentic/sandbox-contract/schemas/metrics";
import { IconStub } from "@intentic/ui/testing";
import { type App, createApp, h, nextTick } from "vue";

// The overlay's placing and dismissing are the kit's own suite; here only what the board's header draws and when it opens.
jest.mock("@intentic/ui", async () => {
    const vue = await import("vue");
    return {
        Meter: vue.defineComponent({ setup: () => () => vue.h(`div`, { "data-meter": `` }) }),
        // Open, its slot; shut, nothing: the popover as the reader meets it.
        ResponsiveOverlay: vue.defineComponent({
            props: { modelValue: Boolean },
            setup: (props, { slots }) => () => (props.modelValue ? vue.h(`div`, { "data-overlay": `` }, slots[`default`]?.()) : null),
        }),
        SectionHeader: vue.defineComponent({
            props: { label: String, heading: Number },
            setup: (props) => () => vue.h(`div`, [vue.h(props.heading === undefined ? `span` : `h${props.heading}`, props.label)]),
        }),
        ui: (await import("@intentic/ui/recipes")).ui,
    };
});
// The readout's session rows name conversations the way the board does; none are open in this suite.
jest.mock("../../../models/fleet/useAgents", () => ({ useAgents: () => ({ agentById: (_id: string) => undefined }) }));
jest.mock("../../../models/fleet/useAgents-actions", () => ({ openById: () => undefined }));

const { default: BoardMetrics } = await import("./BoardMetrics.vue");
const { metricsAsked } = await import("./boardMetricsAsk");

const GIB = 2 ** 30;

let app: App | undefined;

const mount = (props: { place?: `header` | `corner`; fold?: boolean } = {}, sandbox: Partial<SandboxMetrics[`sandbox`]> = {}): HTMLElement => {
    const element = document.createElement(`div`);
    document.body.append(element);
    app = createApp({ render: () => h(BoardMetrics, { metrics: reading(sandbox), ...props }) });
    app.component(`Icon`, IconStub);
    app.directive(`tooltip`, {});
    app.mount(element);
    return element;
};

const reading = (sandbox: Partial<SandboxMetrics[`sandbox`]> = {}): SandboxMetrics => ({
    at: 1,
    windowMs: 3_000,
    sandbox: {
        cpuPercent: 23.4,
        cores: 16,
        memoryBytes: 5.5 * GIB,
        memoryLimitBytes: 16 * GIB,
        swapBytes: 0,
        diskBytes: 400 * GIB,
        diskTotalBytes: 1_000 * GIB,
        loadAverage: [1.5, 1.25, 1],
        processes: 104,
        ...sandbox,
    },
    daemon: { rssBytes: 0.4 * GIB, heapUsedBytes: 0.1 * GIB },
    sessions: {},
    roles: {},
});

const press = (element: HTMLElement): HTMLButtonElement => element.querySelector<HTMLButtonElement>(`[data-board-metrics]`)!;
const figures = (element: HTMLElement): string[] => [...press(element).querySelectorAll(`[data-figure]`)].map((figure) => figure.textContent ?? ``);

afterEach(() => {
    app?.unmount();
    app = undefined;
    document.body.innerHTML = ``;
    metricsAsked.value = false;
});

describe(`the board's metrics`, () => {
    it(`draw three small meters, naming each figure to a screen reader, and nothing more until pressed`, () => {
        const element = mount();
        expect(figures(element)).toEqual([`CPU23%`, `Memory5.5 / 16 GiB`, `Disk400 / 1,000 GiB`]);
        expect(element.querySelector(`[data-overlay]`)).toBeNull();
        expect(press(element).getAttribute(`aria-expanded`)).toBe(`false`);
    });

    it(`trade the meters for one line once a figure nears its limit`, () => {
        const element = mount({}, { diskBytes: 950 * GIB });
        expect(figures(element)).toEqual([]);
        expect(press(element).querySelector(`[data-verdict]`)?.textContent).toBe(`Disk950 / 1,000 GiB`);
    });

    it(`open the full readout as a popover off them, and shut it on a second press`, async () => {
        const element = mount();
        press(element).click();
        await nextTick();
        expect(press(element).getAttribute(`aria-expanded`)).toBe(`true`);
        expect(element.querySelector(`[data-overlay] h3`)?.textContent).toBe(`Sandbox resources`);
        press(element).click();
        await nextTick();
        expect(element.querySelector(`[data-overlay]`)).toBeNull();
    });

    it(`stand open in the board's corner, a row a gauge with its whole figure, all of it said in the one press's name`, () => {
        const element = mount({ place: `corner` });
        const corner = element.querySelector(`[data-board-metrics-corner]`)!;
        expect([...corner.querySelectorAll(`[data-figure]`)].map((figure) => figure.textContent)).toEqual([
            `CPU23% of 16 cores`,
            `Memory5.5 GiB / 16 GiB`,
            `Disk400 GiB / 1,000 GiB`,
        ]);
        expect(press(element).getAttribute(`aria-label`)).toBe(`Sandbox resources, CPU 23% of 16 cores, Memory 5.5 GiB / 16 GiB, Disk 400 GiB / 1,000 GiB`);
    });

    it(`say what else is wrong with a gauge under it in the corner, and fold to the one line when told to`, async () => {
        const short = { swapBytes: 2 * GIB, swapLimitBytes: 2 * GIB, swapFull: true, pressure: { cpu: 0, memory: 30, io: 0 } };
        const element = mount({ place: `corner` }, short);
        const rows = [...element.querySelectorAll(`[data-board-metrics-corner] [data-figure]`)].map((figure) => figure.textContent);
        expect(rows[1]).toBe(`Memory5.5 GiB / 16 GiBswap full · 30% stalled`);
        app?.unmount();
        const folded = mount({ place: `corner`, fold: true }, short);
        expect(folded.querySelector(`[data-board-metrics-corner] [data-verdict]`)?.textContent).toBe(`Memory5.5 / 16 GiB· swap full · 30% stalled`);
        press(folded).click();
        await nextTick();
        expect(folded.querySelector(`[data-overlay] h3`)?.textContent).toBe(`Sandbox resources`);
    });

    it(`open by themselves when the rail asked for them, and spend the ask`, async () => {
        metricsAsked.value = true;
        const element = mount();
        await nextTick();
        expect(element.querySelector(`[data-overlay]`)).not.toBeNull();
        expect(metricsAsked.value).toBe(false);
    });
});
