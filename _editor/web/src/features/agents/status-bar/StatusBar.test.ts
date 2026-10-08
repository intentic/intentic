import "@intentic/testing/dom";
import type { SandboxMetrics } from "@intentic/sandbox-contract";
import { IconStub } from "@intentic/ui/testing";
import { type App, createApp, h, nextTick } from "vue";

// The seam's dragging is the kit's own suite; here only what the status bar draws and when.
jest.mock("@intentic/ui", async () => {
    const vue = await import("vue");
    return {
        ResizeSeam: vue.defineComponent({ setup: () => () => vue.h(`div`, { role: `separator` }) }),
        Meter: vue.defineComponent({ setup: () => () => vue.h(`div`, { "data-meter": `` }) }),
        ui: {
            iconButton: (extra: string) => extra,
            linkButton: (extra: string) => extra,
            textAction: (extra: string) => extra,
            sectionLabelSm: (extra: string) => extra,
        },
    };
});
// The metrics panel's session rows name conversations the way the board does; none are open in this suite.
jest.mock("../fleet/useAgents", () => ({ useAgents: () => ({ agentById: (_id: string) => undefined }) }));
jest.mock("../fleet/useAgents-actions", () => ({ openById: () => undefined }));

const { default: StatusBar } = await import("./StatusBar.vue");
const { openPanel, panelHeight } = await import("./statusBarState");
const { showLiveMetrics } = await import("../metrics/liveMetrics");

const GIB = 2 ** 30;

let app: App | undefined;

// The bar's memory is the window's (two preferences), so a case that starts with the panel open sets it there.
const mount = (options: { metrics?: SandboxMetrics; open?: `metrics`; persistent?: boolean; start?: string } = {}): HTMLElement => {
    openPanel.value = options.open;
    panelHeight.value = 240;
    const element = document.createElement(`div`);
    document.body.append(element);
    app = createApp({
        render: () =>
            h(
                StatusBar,
                { metrics: options.metrics, persistent: options.persistent },
                options.start === undefined ? {} : { start: () => h(`a`, { "data-chip": `terminal` }, options.start) },
            ),
    });
    app.component(`Icon`, IconStub);
    app.directive(`tooltip`, {});
    app.mount(element);
    return element;
};

// An element's text pieces joined by a space, as they read; the compiled template keeps no whitespace between them.
const wordsOf = (node: Node | null | undefined): string =>
    node === null || node === undefined
        ? ``
        : [...node.childNodes]
              .map((child) => (child.nodeType === Node.TEXT_NODE ? (child.textContent ?? ``) : wordsOf(child)).trim())
              .filter((piece) => piece !== ``)
              .join(` `);

const segment = (element: HTMLElement, id = `metrics`): HTMLElement => element.querySelector<HTMLElement>(`[data-segment="${id}"]`)!;
const panel = (element: HTMLElement, id = `metrics`): HTMLElement | null => element.querySelector<HTMLElement>(`[data-panel="${id}"]`);

const metrics = (): SandboxMetrics => ({
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
    },
    daemon: { rssBytes: 0.4 * GIB, heapUsedBytes: 0.1 * GIB },
    sessions: {},
    roles: {},
});

afterEach(() => {
    app?.unmount();
    app = undefined;
    document.body.innerHTML = ``;
    showLiveMetrics.value = false;
});

describe(`the status bar`, () => {
    it(`draws nothing while the metrics are off, whatever was left open, unless its host keeps it`, () => {
        const element = mount({ open: `metrics` });
        expect(element.querySelector(`[role="region"]`)).toBeNull();
        expect(element.querySelector(`[data-status-panel]`)).toBeNull();
        // Left open while the metrics were turned off, it comes back as it was left once they are on again.
        expect(openPanel.value).toBe(`metrics`);
    });

    // The desktop shell's bar: always there at one height, its start the host's, and no metrics segment while they're off.
    it(`keeps a persistent bar with its host's start and no metrics segment while they are off`, () => {
        const element = mount({ persistent: true, start: `Terminal`, open: `metrics` });
        expect(element.querySelector(`[role="region"]`)?.getAttribute(`aria-label`)).toBe(`Status bar`);
        expect(wordsOf(element.querySelector(`[data-chip="terminal"]`))).toBe(`Terminal`);
        expect(element.querySelector(`[data-segment]`)).toBeNull();
        expect(element.querySelector(`[data-status-panel]`)).toBeNull();
    });

    it(`draws the host's start before the metrics segment, which sits at the far end`, () => {
        const element = mount({ persistent: true, start: `Terminal`, metrics: metrics() });
        const controls = [...element.querySelectorAll<HTMLElement>(`[data-chip], [data-segment]`)].map(
            (control) => control.dataset[`chip`] ?? control.dataset[`segment`],
        );
        expect(controls).toEqual([`terminal`, `metrics`]);
        expect(segment(element).className).toContain(`ml-auto`);
    });

    // The bar carries the metrics and nothing else: no segment of any check.
    it(`carries the geek metrics and nothing else, and opens their panel above it`, async () => {
        const element = mount({ metrics: metrics() });
        expect(element.querySelector(`[role="region"]`)?.getAttribute(`aria-label`)).toBe(`Status bar`);
        const segments = [...element.querySelectorAll<HTMLElement>(`[data-segment]`)].map((control) => control.dataset[`segment`]);
        expect(segments).toEqual([`metrics`]);
        expect([...element.querySelectorAll<HTMLElement>(`a, button`)].map((control) => control.dataset[`segment`])).toEqual([`metrics`]);
        expect(element.textContent).not.toContain(`Main`);
        expect(wordsOf(segment(element))).toContain(`CPU 23%`);
        expect(segment(element).getAttribute(`aria-expanded`)).toBe(`false`);

        segment(element).click();
        await nextTick();
        expect(openPanel.value).toBe(`metrics`);
        expect(segment(element).getAttribute(`aria-expanded`)).toBe(`true`);
        const docked = panel(element)!;
        expect(segment(element).getAttribute(`aria-controls`)).toBe(docked.id);
        expect(wordsOf(docked.querySelector(`h3`))).toBe(`Sandbox resources`);
        expect([...element.querySelectorAll<HTMLElement>(`[data-panel]`)].map((section) => section.dataset[`panel`])).toEqual([`metrics`]);
    });

    // Opened to be watched: nothing but the reader closes it.
    it(`keeps the panel through a click elsewhere, and closes it on its segment, its ×, or Escape inside it, handing focus back`, async () => {
        const element = mount({ metrics: metrics(), open: `metrics` });

        document.body.click();
        document.body.dispatchEvent(new PointerEvent(`pointerdown`, { bubbles: true }));
        await nextTick();
        expect(panel(element)).not.toBeNull();

        segment(element).click();
        await nextTick();
        expect(panel(element)).toBeNull();

        segment(element).click();
        await nextTick();
        panel(element)!.querySelector<HTMLButtonElement>(`button[aria-label="Close Sandbox resources"]`)!.click();
        await nextTick();
        expect(panel(element)).toBeNull();

        openPanel.value = `metrics`;
        await nextTick();
        panel(element)!.dispatchEvent(new KeyboardEvent(`keydown`, { key: `Escape`, bubbles: true }));
        await nextTick();
        await nextTick();
        expect(panel(element)).toBeNull();
        expect(document.activeElement).toBe(segment(element));
    });

    // One maximum for the seam and the drawing: a height kept from a taller window is drawn at this one's half, never
    // saved as something the panel cannot show.
    it(`draws a panel no taller than half the window, and no taller than 720px anywhere`, async () => {
        const element = mount({ metrics: metrics(), open: `metrics` });
        const drawn = (): string => element.querySelector<HTMLElement>(`[data-status-panel]`)!.style.height;
        panelHeight.value = 700;
        await nextTick();
        expect([window.innerHeight, drawn()]).toEqual([768, `384px`]);
    });
});
