// jsdom: the subject is what a reader sees, the board's line and a card's, in the English the catalog holds.
import "@intentic/testing/dom";
import type { SandboxMetrics } from "@intentic/sandbox-contract";
import { formatPercent, setFormatLocale } from "@intentic/ui/format";
import { IconStub } from "@intentic/ui/testing";
import { type App, type Component, computed, createApp, h } from "vue";

const { default: SessionMetrics } = await import("./SessionMetrics.vue");
const { default: SandboxMetricsStrip } = await import("./SandboxMetricsStrip.vue");
const { LIVE_METRICS_KEY } = await import("./liveMetrics");

const GIB = 2 ** 30;
const MIB = 2 ** 20;

const reading = (patch: { sandbox?: Partial<SandboxMetrics[`sandbox`]>; daemon?: Partial<SandboxMetrics[`daemon`]> } = {}): SandboxMetrics => ({
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
        pressure: { cpu: 0.2, memory: 0, io: 0.1 },
        ...patch.sandbox,
    },
    daemon: { rssBytes: 412 * MIB, heapUsedBytes: 100 * MIB, cpuPercent: 2, eventLoopPercent: 4.5, ...patch.daemon },
    sessions: { a1: { processes: 12, rssBytes: 412 * MIB, cpuPercent: 37.2 }, fresh: { processes: 1, rssBytes: 40 * MIB } },
    roles: {
        toolchain: { processes: 4, rssBytes: 2 * GIB },
        browser: { processes: 20, rssBytes: 1.2 * GIB },
        other: { processes: 3, rssBytes: 0 },
    },
});

let app: App | undefined;
// Icon and v-tooltip are registered app-wide by installUi; stand-ins keep the whole UI plugin out.
const mount = (component: Component, props: Record<string, unknown>, provided?: SandboxMetrics): HTMLElement => {
    const el = document.createElement(`div`);
    document.body.append(el);
    app = createApp({ render: () => h(component, props) });
    app.component(`Icon`, IconStub);
    app.directive(`tooltip`, {});
    if (provided !== undefined) {
        app.provide(
            LIVE_METRICS_KEY,
            computed(() => provided),
        );
    }
    app.mount(el);
    return el;
};

afterEach(() => {
    app?.unmount();
    app = undefined;
    document.body.innerHTML = ``;
});

// Each figure as the reader meets it: its label and its value, in the order the line draws them.
const figuresOf = (el: HTMLElement): string[] =>
    [...el.querySelectorAll(`[role="group"] > span`)].map((figure) => [...figure.children].map((part) => part.textContent?.trim()).join(`: `));

describe("a card's line", () => {
    it("says what the conversation's processes use", () => {
        expect(mount(SessionMetrics, { conversationId: `a1` }, reading()).textContent?.trim()).toBe(`37% CPU · 412 MB · 12 processes`);
    });

    it("leaves CPU out of a first reading rather than guessing it", () => {
        expect(mount(SessionMetrics, { conversationId: `fresh` }, reading()).textContent?.trim()).toBe(`40 MB · 1 process`);
    });

    it("draws nothing for a conversation with nothing running, or on a card the board did not provide a reading to", () => {
        expect(mount(SessionMetrics, { conversationId: `idle` }, reading()).textContent).toBe(``);
        app?.unmount();
        expect(mount(SessionMetrics, { conversationId: `a1` }).textContent).toBe(``);
    });
});

describe("the sandbox line", () => {
    it("reads capacity against use, and leaves out what is quiet: no swap in use, no pressure worth naming", () => {
        expect(figuresOf(mount(SandboxMetricsStrip, { metrics: reading() }))).toEqual([
            `CPU: 23% of 16 cores`,
            `Memory: 5.5 GB / 16 GB`,
            `Disk: 400 GB / 1,000 GB`,
            `Load: 1.50 1.25 1.00`,
            `Processes: 104`,
            `Daemon: 412 MB · 2.0% CPU · loop 4.5%`,
            `Memory by kind: builds and tests 2.0 GB · browsers 1.2 GB`,
        ]);
    });

    it("names the capacity alone on a first reading, and swap and pressure once there is some", () => {
        const figures = figuresOf(
            mount(SandboxMetricsStrip, {
                metrics: reading({ sandbox: { cpuPercent: undefined, swapBytes: 3 * GIB, pressure: { cpu: 2, memory: 12.5, io: 0 } } }),
            }),
        );
        expect(figures).toContain(`CPU: 16 cores`);
        expect(figures).toContain(`Swap: 3.0 GB`);
        expect(figures).toContain(`Pressure: CPU 2.0% · memory 13% · I/O 0.0%`);
    });

    it("tints only the figures near their limit", () => {
        const el = mount(SandboxMetricsStrip, {
            metrics: reading({ sandbox: { memoryBytes: 15 * GIB, pressure: { cpu: 0, memory: 30, io: 0 } }, daemon: { eventLoopPercent: 95 } }),
        });
        const warned = [...el.querySelectorAll(`.text-warning`)].map((value) => value.previousElementSibling?.textContent?.trim());
        expect(warned).toEqual([`Memory`, `Pressure`, `Daemon`]);
    });
});

describe("formatPercent", () => {
    it("writes a decimal only under ten, in the reader's own number format", () => {
        try {
            expect([formatPercent(4.26), formatPercent(37.2), formatPercent(412)]).toEqual([`4.3%`, `37%`, `412%`]);
            setFormatLocale(`de`);
            // German parts the sign from the number with a no-break space and marks the decimal with a comma.
            expect([formatPercent(4.26), formatPercent(37.2)]).toEqual([`4,3 %`, `37 %`]);
        } finally {
            setFormatLocale(`en`);
        }
    });
});
