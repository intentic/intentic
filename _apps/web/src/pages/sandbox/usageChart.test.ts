import type { UsageRollupRow } from "@intentic/sandbox-contract";
import { describe, expect, it } from "vitest";
import {
    bucketFor,
    cacheHitRate,
    daySpan,
    deltaPercent,
    formatCompact,
    formatDelta,
    formatUsd,
    formatUsdHero,
    inWindow,
    niceMax,
    previousWindow,
    PROVIDER_SERIES,
    providersIn,
    rankByCost,
    rankedColor,
    rankedKey,
    seriesColor,
    shiftDay,
    sparkPoints,
    totalsOf,
    totalTokens,
    usageCsv,
    usageSeries,
    windowFor,
} from "./usageChart";

/* The Usage tab is a money screen, and every number on it is one of these functions. The cases that matter are
 * the ones where a plausible implementation lies: a window that silently drops its edges, a delta with no
 * baseline, a rank whose bars sum to less than the headline, a CSV that shifts a column on a comma. */

const row = (over: Partial<UsageRollupRow> = {}): UsageRollupRow => ({
    day: `2026-07-20`,
    provider: `claude`,
    harness: `native`,
    turns: 1,
    inputTokens: 100,
    outputTokens: 50,
    cacheReadTokens: 300,
    cacheCreationTokens: 20,
    costUsd: 1,
    durationMs: 1_000,
    ...over,
});

describe(`day arithmetic`, () => {
    it(`shifts across a month boundary in UTC`, () => {
        expect(shiftDay(`2026-08-01`, -1)).toBe(`2026-07-31`);
        expect(shiftDay(`2026-02-28`, 1)).toBe(`2026-03-01`);
    });

    it(`counts a span inclusively — one day is 1`, () => {
        expect(daySpan(`2026-07-20`, `2026-07-20`)).toBe(1);
        expect(daySpan(`2026-07-20`, `2026-07-26`)).toBe(7);
    });
});

describe(`windows`, () => {
    it(`makes a preset span exactly its many days, today included`, () => {
        expect(windowFor(`7d`, `2026-07-26`)).toEqual({ from: `2026-07-20`, to: `2026-07-26` });
        expect(daySpan(`2026-07-20`, `2026-07-26`)).toBe(7);
        expect(windowFor(`30d`, `2026-07-26`).from).toBe(`2026-06-27`);
    });

    it(`leaves All time unbounded rather than reaching back to a sentinel date`, () => {
        expect(windowFor(`all`, `2026-07-26`)).toEqual({ to: `2026-07-26` });
    });

    it(`puts the previous window immediately before, same length, no overlap`, () => {
        const previous = previousWindow(windowFor(`7d`, `2026-07-26`));
        expect(previous).toEqual({ from: `2026-07-13`, to: `2026-07-19` });
    });

    it(`has no previous window for All time — there is nothing before everything`, () => {
        expect(previousWindow(windowFor(`all`, `2026-07-26`))).toBeUndefined();
    });

    it(`includes BOTH bounds when filtering`, () => {
        const rows = [row({ day: `2026-07-19` }), row({ day: `2026-07-20` }), row({ day: `2026-07-26` }), row({ day: `2026-07-27` })];
        expect(inWindow(rows, windowFor(`7d`, `2026-07-26`)).map((entry) => entry.day)).toEqual([`2026-07-20`, `2026-07-26`]);
    });

    it(`keeps everything up to today when unbounded`, () => {
        const rows = [row({ day: `2020-01-01` }), row({ day: `2026-07-26` })];
        expect(inWindow(rows, windowFor(`all`, `2026-07-26`))).toHaveLength(2);
    });
});

describe(`totals`, () => {
    it(`sums every measure across rows`, () => {
        const totals = totalsOf([row(), row({ costUsd: 2, turns: 3 })]);
        expect(totals).toMatchObject({ costUsd: 3, turns: 4, inputTokens: 200, cacheReadTokens: 600 });
        expect(totalTokens(totals)).toBe(200 + 100 + 600 + 40);
    });

    it(`is zero — not NaN — over no rows`, () => {
        expect(totalsOf([])).toMatchObject({ costUsd: 0, turns: 0 });
        expect(cacheHitRate(totalsOf([]))).toBeUndefined();
    });

    it(`rates cache hits against prompt input only, excluding the cost of filling the cache`, () => {
        // 300 read against 100 uncached input = 75%. The 20 creation tokens are what it cost to populate the
        // cache, not a lookup that could have hit, so they stay out of the denominator.
        expect(cacheHitRate(totalsOf([row()]))).toBeCloseTo(75);
    });

    it(`gives no delta without a baseline, and none against zero`, () => {
        expect(deltaPercent(10, undefined)).toBeUndefined();
        expect(deltaPercent(10, 0)).toBeUndefined();
        expect(deltaPercent(12, 10)).toBeCloseTo(20);
        expect(deltaPercent(8, 10)).toBeCloseTo(-20);
    });
});

describe(`series identity`, () => {
    it(`assigns a slot by provider identity, in the validated palette order`, () => {
        expect(PROVIDER_SERIES).toEqual([`claude`, `codex`, `kimi`, `grok`, `gemini`]);
        expect(seriesColor(`claude`)).toBe(`var(--color-series-1)`);
        expect(seriesColor(`gemini`)).toBe(`var(--color-series-5)`);
    });

    it(`folds an unknown provider into the achromatic tail rather than inventing a sixth hue`, () => {
        expect(seriesColor(`some-acp-agent`)).toBe(`var(--color-series-other)`);
    });

    it(`orders present providers by slot, unknowns last`, () => {
        const rows = [row({ provider: `gemini` }), row({ provider: `zed` }), row({ provider: `claude` }), row({ provider: `acme` })];
        expect(providersIn(rows)).toEqual([`claude`, `gemini`, `acme`, `zed`]);
    });
});

describe(`usage series`, () => {
    const window = windowFor(`7d`, `2026-07-26`);

    it(`zero-fills idle days so a gap in spend is visible as a gap`, () => {
        const series = usageSeries([row({ day: `2026-07-22`, costUsd: 5 })], window, [`claude`]);
        expect(series).toHaveLength(7);
        expect(series.map((bucket) => bucket.totals.costUsd)).toEqual([0, 0, 5, 0, 0, 0, 0]);
        expect(series[0]?.start).toBe(`2026-07-20`);
    });

    it(`carries every provider as a segment in every column, so the stack order never shifts`, () => {
        const series = usageSeries([row({ day: `2026-07-21`, provider: `codex`, costUsd: 3 })], window, [`claude`, `codex`]);
        expect(series.every((bucket) => bucket.segments.map((segment) => segment.key).join() === `claude,codex`)).toBe(true);
        expect(series[1]?.segments).toEqual([
            { key: `claude`, value: 0 },
            { key: `codex`, value: 3 },
        ]);
    });

    it(`sums same-day rows of one provider into that column`, () => {
        const series = usageSeries([row({ day: `2026-07-26`, costUsd: 1 }), row({ day: `2026-07-26`, costUsd: 2, model: `sonnet-5` })], window, [
            `claude`,
        ]);
        expect(series.at(-1)?.totals.costUsd).toBe(3);
    });

    it(`spans the data itself when the window is unbounded`, () => {
        const series = usageSeries([row({ day: `2026-07-24` }), row({ day: `2026-07-26` })], { to: `2026-07-26` }, [`claude`]);
        expect(series.map((bucket) => bucket.start)).toEqual([`2026-07-24`, `2026-07-25`, `2026-07-26`]);
    });

    it(`is empty rather than a crash when an unbounded window has no rows at all`, () => {
        expect(usageSeries([], { to: `2026-07-26` }, [])).toEqual([]);
    });

    it(`ignores a row outside the window instead of stretching the axis to reach it`, () => {
        const series = usageSeries([row({ day: `2026-01-01`, costUsd: 99 })], window, [`claude`]);
        expect(series).toHaveLength(7);
        expect(series.reduce((sum, bucket) => sum + bucket.totals.costUsd, 0)).toBe(0);
    });

    it(`widens the bucket past a quarter so a column stays a readable mark`, () => {
        expect(bucketFor(92)).toBe(`day`);
        expect(bucketFor(93)).toBe(`week`);
        expect(bucketFor(731)).toBe(`month`);
    });

    it(`anchors weekly buckets so the newest one ends on the window's last day`, () => {
        const long = { from: `2026-01-01`, to: `2026-07-26` };
        const series = usageSeries([row({ day: `2026-07-26`, costUsd: 4 }), row({ day: `2026-07-20`, costUsd: 1 })], long, [`claude`]);
        // Both days land in the final 7-day bucket (Jul 20–26), which is the one ending on `to`.
        expect(series.at(-1)).toMatchObject({ start: `2026-07-20`, totals: { costUsd: 5 } });
        expect(series.every((bucket) => bucket.start <= long.to)).toBe(true);
    });

    it(`buckets by calendar month over multi-year spans`, () => {
        const series = usageSeries([row({ day: `2024-03-15`, costUsd: 2 })], { from: `2024-01-01`, to: `2026-07-26` }, [`claude`]);
        const march = series.find((bucket) => bucket.start === `2024-03-01`);
        expect(march).toMatchObject({ totals: { costUsd: 2 }, label: `Mar 2024` });
    });
});

describe(`sparkline`, () => {
    it(`passes a short series through untouched`, () => {
        expect(sparkPoints([3, 1, 4])).toEqual([3, 1, 4]);
    });

    it(`averages a long series down to the point budget`, () => {
        const points = sparkPoints(
            Array.from({ length: 24 }, (_, index) => index),
            12,
        );
        expect(points).toHaveLength(12);
        // Averaging, not sampling: the first pair (0,1) averages to 0.5.
        expect(points[0]).toBeCloseTo(0.5);
    });
});

describe(`ranked bars`, () => {
    const label = (key: string): string => key;

    it(`ranks by cost, biggest first`, () => {
        const rows = [row({ model: `opus-5`, costUsd: 3 }), row({ model: `sonnet-5`, costUsd: 9 })];
        expect(rankByCost(rows, (entry) => entry.model, label, `Provider default`).map((entry) => entry.label)).toEqual([`sonnet-5`, `opus-5`]);
    });

    it(`names rows with no value for the dimension instead of dropping their spend`, () => {
        const ranked = rankByCost([row({ costUsd: 4 })], (entry) => entry.model, label, `Provider default`);
        expect(ranked).toEqual([{ key: undefined, kind: `unattributed`, label: `Provider default`, value: 4, providers: [`claude`] }]);
        expect(rankedKey(ranked[0]!)).toBe(`unattributed:`);
    });

    it(`colors a bar by its provider, and only when the bar has exactly one`, () => {
        const [single] = rankByCost([row({ model: `opus-5` })], (entry) => entry.model, label, `default`);
        expect(rankedColor(single!)).toBe(`var(--color-series-1)`);

        // A dimension value served by two providers (a routed model, say) has no single identity to wear.
        const rows = [row({ model: `shared` }), row({ model: `shared`, provider: `codex` })];
        const [mixed] = rankByCost(rows, (entry) => entry.model, label, `default`);
        expect(mixed?.providers).toEqual([`claude`, `codex`]);
        expect(rankedColor(mixed!)).toBe(`var(--color-series-other)`);
    });

    it(`keeps a dimension value literally named "other" distinct from the fold bucket`, () => {
        const rows = Array.from({ length: 10 }, (_, index) => row({ model: index === 0 ? `other` : `m${index}`, costUsd: 10 - index }));
        const ranked = rankByCost(rows, (entry) => entry.model, label, `default`, 8);
        expect(ranked[0]).toMatchObject({ key: `other`, kind: `value`, value: 10 });
        expect(ranked.at(-1)).toMatchObject({ key: undefined, kind: `other` });
        expect(new Set(ranked.map(rankedKey)).size).toBe(ranked.length);
    });

    it(`folds the tail into one bucket so the bars still sum to the headline`, () => {
        const rows = Array.from({ length: 12 }, (_, index) => row({ model: `m${index}`, costUsd: 12 - index }));
        const ranked = rankByCost(rows, (entry) => entry.model, label, `default`, 8);
        expect(ranked).toHaveLength(8);
        expect(ranked.at(-1)).toMatchObject({ label: `5 more`, value: 5 + 4 + 3 + 2 + 1 });
        expect(ranked.reduce((sum, entry) => sum + entry.value, 0)).toBe(totalsOf(rows).costUsd);
    });

    it(`drops a zero-cost dimension rather than drawing an invisible bar`, () => {
        expect(rankByCost([row({ model: `free`, costUsd: 0 })], (entry) => entry.model, label, `default`)).toEqual([]);
    });
});

describe(`axis and formatting`, () => {
    it(`rounds an axis top to a number a person would say`, () => {
        expect(niceMax(0.4)).toBe(0.5);
        expect(niceMax(47.2)).toBe(50);
        expect(niceMax(230)).toBe(250);
        expect(niceMax(1_100)).toBe(2_000);
    });

    it(`never returns a zero axis top — a flat chart still needs somewhere to draw`, () => {
        expect(niceMax(0)).toBe(1);
        expect(niceMax(-5)).toBe(1);
    });

    it(`says a tiny non-zero cost is tiny rather than printing it as free`, () => {
        expect(formatUsd(0)).toBe(`$0.00`);
        expect(formatUsd(0.004)).toBe(`<$0.01`);
        expect(formatUsd(47.2)).toBe(`$47.20`);
    });

    it(`keeps the hero amount inside its tile by stepping precision down with magnitude`, () => {
        // Cents where they carry meaning, then whole dollars, then compacted — nine glyphs at worst, so the
        // number can't grow out of the card the way a fixed 48px "$1,234.56" does.
        expect(formatUsdHero(36.62)).toBe(`$36.62`);
        expect(formatUsdHero(9_999.99)).toBe(`$9,999.99`);
        expect(formatUsdHero(12_480.4)).toBe(`$12,480`);
        expect(formatUsdHero(1_240_000)).toBe(`$1.2M`);
    });

    it(`compacts counts past a thousand`, () => {
        expect(formatCompact(999)).toBe(`999`);
        expect(formatCompact(1_284)).toBe(`1.3K`);
        expect(formatCompact(18_400_000)).toBe(`18.4M`);
    });

    it(`signs a delta with a real minus and one decimal only while it is small`, () => {
        expect(formatDelta(18.4)).toBe(`+18%`);
        expect(formatDelta(-4.25)).toBe(`−4.3%`);
        expect(formatDelta(undefined)).toBeUndefined();
    });
});

describe(`csv export`, () => {
    it(`writes a header and one line per row, blank for absent attribution`, () => {
        const lines = usageCsv([row({ account: `work`, model: `opus-5`, conversationId: `agent-1` }), row()]).split(`\n`);
        expect(lines[0]).toBe(
            `day,provider,account,model,harness,agent,turns,inputTokens,outputTokens,cacheReadTokens,cacheCreationTokens,costUsd,durationMs`,
        );
        expect(lines[1]).toBe(`2026-07-20,claude,work,opus-5,native,agent-1,1,100,50,300,20,1,1000`);
        expect(lines[2]).toBe(`2026-07-20,claude,,,native,,1,100,50,300,20,1,1000`);
    });

    it(`quotes a field containing a comma or a quote, so a model id can't shift every later column`, () => {
        const [, line] = usageCsv([row({ model: `weird,"name"` })]).split(`\n`);
        expect(line).toContain(`"weird,""name"""`);
        // Still 13 columns once the quoted field is accounted for.
        expect(line?.split(`","`)).toHaveLength(1);
    });
});
