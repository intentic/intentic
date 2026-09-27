// jsdom: the subject is what a reader sees, the board's line and a card's, in the English the catalog holds.
import "@intentic/testing/dom";
import type { SandboxMetrics } from "@intentic/sandbox-contract";
import { formatPercent, setFormatLocale } from "@intentic/ui/format";
import { IconStub } from "@intentic/ui/testing";
import { type App, type Component, computed, createApp, h, nextTick } from "vue";

const opened = jest.fn((_conversationId: string, _title?: string) => undefined);
// Two of the reading's conversations are on the board, under their titles; the rest are named by their ids.
jest.mock("../fleet/useAgents", () => ({
    useAgents: () => ({
        agentById: (id: string) =>
            id === `a1` ? { title: `Wire the checkout`, status: `running` } : id === `b2` ? { title: `Translate the notes`, status: `running` } : undefined,
    }),
}));
jest.mock("../fleet/useAgents-actions", () => ({ openById: opened }));

const { default: SessionMetrics } = await import("./SessionMetrics.vue");
const { default: SandboxMetricsSummary } = await import("./SandboxMetricsSummary.vue");
const { default: SandboxMetricsDetails } = await import("./SandboxMetricsDetails.vue");
const { LIVE_METRICS_KEY } = await import("./liveMetrics");

const GIB = 2 ** 30;
const MIB = 2 ** 20;

// The daemon's verdict on memory for a person's turn: this much free against the gibibyte it needs.
const room = (freeBytes: number): SandboxMetrics[`sandbox`][`memoryRoom`] => ({
    freeBytes,
    reservedBytes: 0,
    personNeedBytes: GIB,
    stallPercent: 0,
    stallLimitPercent: 20,
});

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
        machineCores: 32,
        processes: 104,
        pressure: { cpu: 0.2, memory: 0, io: 0.1 },
        memoryRoom: room(10 * GIB),
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
    // What a hover would say, kept on the element so a test can read it.
    const tip = (element: HTMLElement, binding: { readonly value: unknown }): void => {
        element.dataset[`tip`] = String(binding.value);
    };
    app.directive(`tooltip`, { mounted: tip, updated: tip });
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
    opened.mockClear();
});

// Each figure as the reader meets it: its words, in the order the line or the panel draws them.
const figuresOf = (el: HTMLElement, section?: string): string[] =>
    [...el.querySelectorAll(section === undefined ? `[data-figure]` : `[data-section="${section}"] [data-figure]`)].map((figure) => wordsOf(figure));

// An element's text pieces joined by a space, as they read; the compiled template keeps no whitespace between them.
const wordsOf = (node: Node): string =>
    [...node.childNodes]
        .map((child) => (child.nodeType === Node.TEXT_NODE ? (child.textContent ?? ``) : wordsOf(child)).trim())
        .filter((piece) => piece !== ``)
        .join(` `);

// The panel's plain figures, a term and its reading.
const termsOf = (el: HTMLElement): string[] =>
    [...el.querySelectorAll(`[data-section="figures"] dt`)].map(
        (term) => `${term.textContent?.trim()}: ${term.nextElementSibling?.textContent?.trim()}`,
    );

describe("a card's figure", () => {
    // One figure in the card's stats row, memory first since memory is what runs out; the whole reading is its hover.
    it("says what the conversation's processes hold and use, with the whole reading on hover", () => {
        const figure = mount(SessionMetrics, { conversationId: `a1` }, reading()).querySelector<HTMLElement>(`[data-session-metrics]`)!;
        expect(figure.textContent?.trim()).toBe(`412 MB · 37%`);
        expect(figure.dataset[`tip`]).toBe(
            `37% CPU · 412 MB · 12 processes. What this conversation's processes are using: CPU over the last few seconds, where 100% is one full core, and resident memory.`,
        );
        expect(figure.classList.contains(`text-warning`)).toBe(false);
    });

    it("leaves CPU out of a first reading rather than guessing it", () => {
        const figure = mount(SessionMetrics, { conversationId: `fresh` }, reading()).querySelector<HTMLElement>(`[data-session-metrics]`)!;
        expect(figure.textContent?.trim()).toBe(`40 MB`);
        expect(figure.dataset[`tip`]?.startsWith(`40 MB · 1 process. `)).toBe(true);
    });

    // A quarter of a 16 GB limit is 4 GB: the boundary itself tints, a byte under it does not.
    it("tints a conversation holding a quarter of the sandbox's memory, and none holding less", () => {
        const holding = (rssBytes: number): boolean => {
            const metrics = { ...reading(), sessions: { a1: { processes: 3, rssBytes, cpuPercent: 80 } } };
            const tinted = mount(SessionMetrics, { conversationId: `a1` }, metrics).querySelector(`[data-session-metrics]`)!.classList.contains(`text-warning`);
            app?.unmount();
            app = undefined;
            document.body.innerHTML = ``;
            return tinted;
        };
        expect([holding(4 * GIB), holding(4 * GIB - 1)]).toEqual([true, false]);
    });

    it("draws nothing for a conversation with nothing running, or on a card the board did not provide a reading to", () => {
        expect(mount(SessionMetrics, { conversationId: `idle` }, reading()).textContent).toBe(``);
        app?.unmount();
        expect(mount(SessionMetrics, { conversationId: `a1` }).textContent).toBe(``);
    });
});

describe("the sandbox segment", () => {
    it("reads the three figures that run out, as short as the line allows, and nothing else while all is well", () => {
        expect(figuresOf(mount(SandboxMetricsSummary, { metrics: reading() }))).toEqual([`CPU 23%`, `Memory 5.5 / 16 GB`, `Disk 400 / 1,000 GB`]);
    });

    it("keeps both units when used and total differ, and a dash for a first reading's CPU", () => {
        const el = mount(SandboxMetricsSummary, { metrics: reading({ sandbox: { cpuPercent: undefined, memoryBytes: 900 * MIB } }) });
        expect(figuresOf(el).slice(0, 2)).toEqual([`CPU –`, `Memory 900 MB / 16 GB`]);
    });

    it("raises a figure past its limit onto the line, tinted, so it needs no click to be seen", () => {
        const el = mount(SandboxMetricsSummary, {
            metrics: reading({
                sandbox: { memoryBytes: 15 * GIB, memoryRoom: room(GIB / 2), pressure: { cpu: 0, memory: 30, io: 0 } },
                daemon: { eventLoopPercent: 95 },
            }),
        });
        expect(figuresOf(el)).toEqual([
            `CPU 23%`,
            `Memory 15 / 16 GB`,
            `Disk 400 / 1,000 GB`,
            `Pressure CPU 0.0% · memory 30% · I/O 0.0%`,
            `Daemon 412 MB · 2.0% CPU · loop 95%`,
        ]);
        const tinted = [...el.querySelectorAll(`[data-figure]`)].filter(
            (figure) => figure.matches(`.text-warning`) || figure.querySelector(`.text-warning`) !== null,
        );
        expect(tinted.map((figure) => wordsOf(figure).split(` `)[0])).toEqual([`Memory`, `Pressure`, `Daemon`]);
    });
});

describe("the sandbox panel", () => {
    it("reads capacity against use, and leaves out what is quiet: no swap in use, no pressure worth naming", () => {
        const el = mount(SandboxMetricsDetails, { metrics: reading() });
        expect(figuresOf(el, `gauges`)).toEqual([`CPU 23% of 16 cores`, `Memory 5.5 GB / 16 GB`, `Disk 400 GB / 1,000 GB`]);
        expect(termsOf(el)).toEqual([`Machine load: 1.5 of 32 cores busy · steady`, `Processes: 104`, `Daemon: 412 MB · 2.0% CPU · loop 4.5%`]);
        expect(figuresOf(el, `roles`)).toEqual([`builds and tests 2.0 GB`, `browsers 1.2 GB`]);
    });

    it("says which way the machine's load is heading, and its cores' worth alone from a daemon that does not send its cores", () => {
        const rising = mount(SandboxMetricsDetails, { metrics: reading({ sandbox: { loadAverage: [6, 3, 2] } }) });
        expect(termsOf(rising)[0]).toBe(`Machine load: 6.0 of 32 cores busy · rising`);
        app?.unmount();
        const older = mount(SandboxMetricsDetails, { metrics: reading({ sandbox: { loadAverage: [0.5, 1, 2.5], machineCores: undefined } }) });
        expect(termsOf(older)[0]).toBe(`Machine load: 0.5 cores busy · easing`);
    });

    it("folds the kinds under 100 MB past the heaviest few behind one line that sums them, and unfolds them on a click", async () => {
        const el = mount(SandboxMetricsDetails, {
            metrics: {
                ...reading(),
                roles: {
                    toolchain: { processes: 4, rssBytes: 2 * GIB },
                    browser: { processes: 20, rssBytes: 1.2 * GIB },
                    other: { processes: 3, rssBytes: 60 * MIB },
                    git: { processes: 1, rssBytes: 30 * MIB },
                    terminal: { processes: 2, rssBytes: 10 * MIB },
                },
            },
        });
        expect(figuresOf(el, `roles`)).toEqual([`builds and tests 2.0 GB`, `browsers 1.2 GB`, `other 60 MB`]);
        const fold = el.querySelector<HTMLButtonElement>(`[data-small-roles]`)!;
        expect(wordsOf(fold)).toBe(`2 smaller kinds · 40 MB`);
        expect(fold.getAttribute(`aria-expanded`)).toBe(`false`);
        fold.click();
        await nextTick();
        expect(figuresOf(el, `roles`)).toEqual([`builds and tests 2.0 GB`, `browsers 1.2 GB`, `other 60 MB`, `git 30 MB`, `terminals 10 MB`]);
        expect(fold.getAttribute(`aria-expanded`)).toBe(`true`);
    });

    it("folds nothing when only one small kind would go, since hiding a single row saves nothing", () => {
        const el = mount(SandboxMetricsDetails, {
            metrics: {
                ...reading(),
                roles: {
                    toolchain: { processes: 4, rssBytes: 2 * GIB },
                    browser: { processes: 20, rssBytes: 1.2 * GIB },
                    searchEngine: { processes: 1, rssBytes: 800 * MIB },
                    git: { processes: 1, rssBytes: 30 * MIB },
                },
            },
        });
        expect(figuresOf(el, `roles`)).toHaveLength(4);
        expect(el.querySelector(`[data-small-roles]`)).toBeNull();
    });

    it("names the capacity alone on a first reading, and swap and pressure once there is some", () => {
        const el = mount(SandboxMetricsDetails, {
            metrics: reading({ sandbox: { cpuPercent: undefined, swapBytes: 3 * GIB, pressure: { cpu: 2, memory: 12.5, io: 0 } } }),
        });
        expect(figuresOf(el, `gauges`)[0]).toBe(`CPU 16 cores`);
        expect(termsOf(el)).toContain(`Swap: 3.0 GB`);
        expect(termsOf(el)).toContain(`Pressure: CPU 2.0% · memory 13% · I/O 0.0%`);
    });

    it("lists where the memory went by session, heaviest first, each as its card names it, and opens one on a press", async () => {
        const el = mount(SandboxMetricsDetails, {
            metrics: {
                ...reading(),
                sessions: {
                    fresh: { processes: 1, rssBytes: 40 * MIB },
                    a1: { processes: 12, rssBytes: 412 * MIB, cpuPercent: 37.2 },
                    b2: { processes: 27, rssBytes: 1.3 * GIB, cpuPercent: 179 },
                },
            },
        });
        expect(wordsOf(el.querySelector(`[data-section="sessions"] h4`)!)).toBe(`By session`);
        expect(figuresOf(el, `sessions`)).toEqual([`Translate the notes 1.3 GB 179%`, `Wire the checkout 412 MB 37%`, `fresh 40 MB –`]);
        const rows = [...el.querySelectorAll<HTMLElement>(`[data-section="sessions"] [data-figure]`)];
        expect(rows[0]!.querySelector<HTMLElement>(`button`)!.dataset[`tip`]).toBe(`179% CPU · 1.3 GB · 27 processes`);

        rows[1]!.querySelector<HTMLButtonElement>(`button`)!.click();
        await nextTick();
        expect(opened).toHaveBeenCalledWith(`a1`, `Wire the checkout`);
        // One the board carries no card for opens by its id alone, with no title to guess.
        rows[2]!.querySelector<HTMLButtonElement>(`button`)!.click();
        expect(opened).toHaveBeenLastCalledWith(`fresh`, undefined);
    });

    it("tints a session holding a quarter of the sandbox's memory in the list too", () => {
        const el = mount(SandboxMetricsDetails, {
            metrics: { ...reading(), sessions: { b2: { processes: 30, rssBytes: 5 * GIB, cpuPercent: 250 }, a1: { processes: 12, rssBytes: 412 * MIB } } },
        });
        const values = [...el.querySelectorAll(`[data-section="sessions"] [data-figure]`)].map((row) => row.querySelector(`.text-warning`)?.textContent?.trim());
        expect(values).toEqual([`5.0 GB`, undefined]);
    });

    it("folds the sessions past the heaviest five behind one line that sums them, and unfolds them on a click", async () => {
        const sessions = Object.fromEntries(
            Array.from({ length: 7 }, (_, at) => [`s${at + 1}`, { processes: 2, rssBytes: (700 - at * 100) * MIB, cpuPercent: 10 }]),
        );
        const el = mount(SandboxMetricsDetails, { metrics: { ...reading(), sessions } });
        expect(figuresOf(el, `sessions`).map((row) => row.split(` `)[0])).toEqual([`s1`, `s2`, `s3`, `s4`, `s5`]);
        const fold = el.querySelector<HTMLButtonElement>(`[data-small-sessions]`)!;
        expect(wordsOf(fold)).toBe(`2 more sessions · 300 MB`);
        fold.click();
        await nextTick();
        expect(figuresOf(el, `sessions`)).toHaveLength(7);
        expect(fold.getAttribute(`aria-expanded`)).toBe(`true`);
    });

    it("folds nothing when only one session would go, and draws no list while nothing runs", () => {
        const six = Object.fromEntries(Array.from({ length: 6 }, (_, at) => [`s${at + 1}`, { processes: 2, rssBytes: (700 - at * 100) * MIB }]));
        const el = mount(SandboxMetricsDetails, { metrics: { ...reading(), sessions: six } });
        expect(figuresOf(el, `sessions`)).toHaveLength(6);
        expect(el.querySelector(`[data-small-sessions]`)).toBeNull();
        app?.unmount();

        const idle = mount(SandboxMetricsDetails, { metrics: { ...reading(), sessions: {} } });
        expect(idle.querySelector(`[data-section="sessions"]`)).toBeNull();
    });

    it("tints only the figures near their limit", () => {
        const el = mount(SandboxMetricsDetails, {
            metrics: reading({
                sandbox: { memoryBytes: 15 * GIB, memoryRoom: room(GIB / 2), pressure: { cpu: 0, memory: 30, io: 0 } },
                daemon: { eventLoopPercent: 95 },
            }),
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
