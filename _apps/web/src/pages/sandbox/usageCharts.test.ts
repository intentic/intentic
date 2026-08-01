// @vitest-environment jsdom
//
// jsdom because these assertions are about rendered GEOMETRY — the percentages, the stack order, the rounded
// data-end — which is exactly the class of thing a chart gets wrong silently. A NaN width or an inverted stack
// throws nothing and fails no type check; it just draws a lie.
import { afterEach, describe, expect, it, vi } from "vitest";
import { type App, createApp, h } from "vue";
import { BarChart } from "@intentic-app/ui";
import UsageColumnChart from "./UsageColumnChart.vue";
import UsageSparkline from "./UsageSparkline.vue";
import { type RankedEntry, rankedBars, type SpendBucket, type UsageTotals } from "./usageChart";

// The ranked bars render through the design system's <BarChart>, so importing it brings the barrel — and with
// it `useDevice`, which reads window.matchMedia at module scope. jsdom ships `window` but not that method.
// vi.hoisted runs above every import in the transformed module, which is exactly what it is for.
vi.hoisted(() => {
    globalThis.matchMedia ??= ((query: string) => ({
        matches: false,
        media: query,
        onchange: null,
        addEventListener: () => {},
        removeEventListener: () => {},
        dispatchEvent: () => false,
    })) as unknown as typeof globalThis.matchMedia;
});

const totals = (over: Partial<UsageTotals> = {}): UsageTotals => ({
    costUsd: 0,
    turns: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    durationMs: 0,
    ...over,
});

const bucket = (start: string, costUsd: number, segments: { key: string; value: number }[]): SpendBucket => ({
    start,
    label: start,
    totals: totals({ costUsd, turns: 1 }),
    segments,
});

let app: App | undefined;
const host = (): HTMLElement => {
    const element = document.createElement(`div`);
    document.body.append(element);
    return element;
};

// The charts carry `v-tooltip` (installed app-wide by installUi). A no-op stand-in
// keeps these tests off the whole UI plugin — the tooltip's CONTENT is not what is under test here.
const mount = (component: unknown, props: Record<string, unknown>): HTMLElement => {
    const element = host();
    app = createApp({ render: () => h(component as never, props) });
    app.directive(`tooltip`, {});
    app.mount(element);
    return element;
};

afterEach(() => {
    app?.unmount();
    app = undefined;
    document.body.innerHTML = ``;
});

const percent = (style: string, property: string): number => Number(new RegExp(`${property}:\\s*([\\d.]+)%`).exec(style)?.[1] ?? Number.NaN);

describe(`UsageColumnChart`, () => {
    const series = [
        bucket(`2026-07-20`, 0, [
            { key: `claude`, value: 0 },
            { key: `codex`, value: 0 },
        ]),
        bucket(`2026-07-21`, 4, [
            { key: `claude`, value: 3 },
            { key: `codex`, value: 1 },
        ]),
        bucket(`2026-07-22`, 8, [
            { key: `claude`, value: 8 },
            { key: `codex`, value: 0 },
        ]),
    ];

    it(`scales columns against the axis top, never against the tallest column`, () => {
        const element = mount(UsageColumnChart, { series, providers: [`claude`, `codex`] });
        const columns = [...element.querySelectorAll(`[style*="height"]`)].filter((node) => node.classList.contains(`max-w-6`));
        // niceMax(8) is 10, so the $8 column is 80% tall — not 100%, which is what scaling to the leader would give.
        expect(columns.map((node) => percent(node.getAttribute(`style`) ?? ``, `height`))).toEqual([0, 40, 80]);
    });

    it(`stacks bottom-up in slot order, so the first provider sits on the baseline`, () => {
        const element = mount(UsageColumnChart, { series, providers: [`claude`, `codex`] });
        const tallest = [...element.querySelectorAll(`.max-w-6`)].at(-2); // the $4 column, the only one with two segments
        const segments = [...(tallest?.children ?? [])];
        expect(segments).toHaveLength(2);
        // A flex column paints its first child at the top, so DOM order is top-down: codex above claude.
        expect(segments[0]?.getAttribute(`style`)).toContain(`--color-series-2`);
        expect(segments[1]?.getAttribute(`style`)).toContain(`--color-series-1`);
        // Only the topmost segment carries the rounded data-end; the baseline stays square.
        expect(segments[0]?.classList.contains(`rounded-t-[4px]`)).toBe(true);
        expect(segments[1]?.classList.contains(`rounded-t-[4px]`)).toBe(false);
    });

    it(`draws no segment at all for a period nothing ran — a gap, not a zero-height sliver`, () => {
        const element = mount(UsageColumnChart, { series, providers: [`claude`, `codex`] });
        expect([...element.querySelectorAll(`.max-w-6`)][0]?.children).toHaveLength(0);
    });

    it(`never emits a NaN dimension, whatever the totals are`, () => {
        const element = mount(UsageColumnChart, { series, providers: [`claude`, `codex`] });
        expect(element.innerHTML).not.toContain(`NaN`);
    });

    it(`shows a legend for two series and none for one — a single swatch would just restate the title`, () => {
        expect(mount(UsageColumnChart, { series, providers: [`claude`, `codex`] }).querySelector(`figcaption`)).not.toBeNull();
        app?.unmount();
        app = undefined;
        const single = mount(UsageColumnChart, { series: [bucket(`2026-07-21`, 4, [{ key: `claude`, value: 4 }])], providers: [`claude`] });
        expect(single.querySelector(`figcaption`)).toBeNull();
    });

    it(`labels only the ends of the axis`, () => {
        const element = mount(UsageColumnChart, { series, providers: [`claude`] });
        const ends = element.querySelector(`.justify-between.pl-13`);
        expect(ends?.children).toHaveLength(2);
        expect(ends?.textContent).toContain(`2026-07-20`);
        expect(ends?.textContent).toContain(`2026-07-22`);
    });
});

// The ranked cost bars render through the design system's shared <BarChart>; what is asserted here is the
// projection into it (rankedBars) plus the geometry the figure owes — the same four claims the app-local copy
// of this chart used to make on its own.
describe(`ranked cost bars`, () => {
    const entry = (label: string, value: number, providers: string[]): RankedEntry => ({ key: label, kind: `value`, label, value, providers });

    it(`scales bars against the leader, which fills the track`, () => {
        const element = mount(BarChart, { items: rankedBars([entry(`opus-5`, 10, [`claude`]), entry(`sonnet-5`, 2.5, [`claude`])]) });
        const bars = [...element.querySelectorAll(`[style*="width"]`)];
        expect(bars.map((node) => percent(node.getAttribute(`style`) ?? ``, `width`))).toEqual([100, 25]);
    });

    it(`colors each bar by its own provider, not by its rank`, () => {
        const element = mount(BarChart, { items: rankedBars([entry(`opus-5`, 10, [`claude`]), entry(`gpt`, 2, [`codex`])]) });
        const bars = [...element.querySelectorAll(`[style*="width"]`)];
        expect(bars[0]?.getAttribute(`style`)).toContain(`--color-series-1`);
        expect(bars[1]?.getAttribute(`style`)).toContain(`--color-series-2`);
    });

    it(`directly labels every bar with its value — the relief the low-contrast fills owe`, () => {
        const element = mount(BarChart, { items: rankedBars([entry(`opus-5`, 12.5, [`claude`])]) });
        expect(element.textContent).toContain(`$12.50`);
    });

    it(`survives an all-zero set without dividing by zero`, () => {
        const element = mount(BarChart, { items: rankedBars([entry(`free`, 0, [`claude`])]) });
        expect(element.innerHTML).not.toContain(`NaN`);
    });
});

describe(`UsageSparkline`, () => {
    it(`plots the highest point at the top and the lowest at the bottom`, () => {
        const element = mount(UsageSparkline, { points: [0, 10] });
        expect(element.querySelector(`path`)?.getAttribute(`d`)).toBe(`M0.00,19.00 L100.00,1.00`);
    });

    it(`sits a flat series on the baseline rather than dividing by zero`, () => {
        const path = mount(UsageSparkline, { points: [0, 0, 0] })
            .querySelector(`path`)
            ?.getAttribute(`d`);
        expect(path).not.toContain(`NaN`);
        expect(path).toBe(`M0.00,19.00 L50.00,19.00 L100.00,19.00`);
    });

    it(`draws nothing from a single point — one dot is not a trend`, () => {
        expect(mount(UsageSparkline, { points: [5] }).querySelector(`svg`)).toBeNull();
    });
});
