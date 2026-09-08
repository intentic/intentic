import type { FigureAccent } from "@intentic/ui/markdown";
import type { BarItem } from "@intentic/ui";
import { seriesColor } from "@intentic/ui/series";
import type { UsageRollupRow } from "@intentic/sandbox-contract";

// Every number and mark on the Usage tab, as pure functions over the daemon's rollup rows; the screen only binds.
// Same split as toolPresentation.ts, so a money readout's arithmetic is testable without mounting a component.

const DAY_MS = 86_400_000;
const dayToMs = (day: string): number => Date.parse(`${day}T00:00:00Z`);
const msToDay = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

// UTC day of an instant, matching the daemon's own row-stamping bucket (usage-store.ts).
export const todayUtc = (now: number = Date.now()): string => msToDay(now);
export const shiftDay = (day: string, days: number): string => msToDay(dayToMs(day) + days * DAY_MS);
// Inclusive day count: a from/to pair covering one day is 1, not 0.
export const daySpan = (from: string, to: string): number => Math.round((dayToMs(to) - dayToMs(from)) / DAY_MS) + 1;

// the window

export type RangePreset = "7d" | "30d" | "90d" | "all";
// Mutable by design: <SegmentedControl> takes its options array as-is.
export const RANGE_PRESETS: { label: string; value: RangePreset }[] = [
    { label: `7 days`, value: `7d` },
    { label: `30 days`, value: `30d` },
    { label: `90 days`, value: `90d` },
    { label: `All time`, value: `all` },
];

// Inclusive UTC range. Absent `from` means unbounded (All time), not a sentinel date: the two read differently
// once compared.
export interface DayWindow {
    readonly from?: string;
    readonly to: string;
}

const PRESET_DAYS: Record<Exclude<RangePreset, "all">, number> = { "7d": 7, "30d": 30, "90d": 90 };

export const windowFor = (preset: RangePreset, today: string): DayWindow =>
    preset === `all` ? { to: today } : { from: shiftDay(today, -(PRESET_DAYS[preset] - 1)), to: today };

// Equal-length window just before this one, for deltas; undefined for All time (no baseline to compare).
export const previousWindow = (window: DayWindow): DayWindow | undefined => {
    if (window.from === undefined) {
        return undefined;
    }
    const days = daySpan(window.from, window.to);
    return { from: shiftDay(window.from, -days), to: shiftDay(window.from, -1) };
};

export const inWindow = (rows: readonly UsageRollupRow[], window: DayWindow): UsageRollupRow[] =>
    rows.filter((row) => (window.from === undefined || row.day >= window.from) && row.day <= window.to);

// totals

export interface UsageTotals {
    readonly costUsd: number;
    readonly turns: number;
    readonly inputTokens: number;
    readonly outputTokens: number;
    readonly cacheReadTokens: number;
    readonly cacheCreationTokens: number;
    readonly durationMs: number;
}

const EMPTY_TOTALS: UsageTotals = {
    costUsd: 0,
    turns: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    durationMs: 0,
};

export const totalsOf = (rows: readonly UsageRollupRow[]): UsageTotals =>
    rows.reduce<UsageTotals>(
        (sum, row) => ({
            costUsd: sum.costUsd + row.costUsd,
            turns: sum.turns + row.turns,
            inputTokens: sum.inputTokens + row.inputTokens,
            outputTokens: sum.outputTokens + row.outputTokens,
            cacheReadTokens: sum.cacheReadTokens + row.cacheReadTokens,
            cacheCreationTokens: sum.cacheCreationTokens + row.cacheCreationTokens,
            durationMs: sum.durationMs + row.durationMs,
        }),
        EMPTY_TOTALS,
    );

// Every token the request carried, cached or not, the "18.4M tokens" headline.
export const totalTokens = (totals: UsageTotals): number =>
    totals.inputTokens + totals.outputTokens + totals.cacheReadTokens + totals.cacheCreationTokens;

// Prefix-cache hit over prompt input (creation excluded); undefined when idle, not a false 0%.
export const cacheHitRate = (totals: UsageTotals): number | undefined => {
    const lookups = totals.cacheReadTokens + totals.inputTokens;
    return lookups === 0 ? undefined : (100 * totals.cacheReadTokens) / lookups;
};

// Signed % change vs. previous window; undefined with no or zero baseline (not a false +Inf%).
export const deltaPercent = (current: number, previous: number | undefined): number | undefined =>
    previous === undefined || previous === 0 ? undefined : (100 * (current - previous)) / previous;

// series identity

// Slot order is the validated palette order (primitive-colors.css): colorblind checks measure adjacent pairs, so
// reordering (e.g. swapping kimi/grok) fails them. An unlisted provider takes the achromatic tail slot, not a new hue.
export const PROVIDER_SERIES = [`claude`, `codex`, `kimi`, `grok`, `gemini`] as const;

// Colour follows the provider's identity, not its rank in the current filter, so hiding one can't repaint
// survivors. Named apart from the design system's own `seriesColor` (which owns slot -> CSS var); this owns provider ->
// slot only.
const providerAccent = (key: string): FigureAccent => {
    const slot = PROVIDER_SERIES.indexOf(key as (typeof PROVIDER_SERIES)[number]);
    return slot === -1 ? `neutral` : (String(slot + 1) as FigureAccent);
};

export const providerColor = (key: string): string => seriesColor(providerAccent(key));

// Which series a row belongs to, injected rather than read here: this module stays a pure function over rows,
// with no access to the live capability list. The tab passes `providerGroup` (providerCatalog.ts, same fold as the
// model picker); tests pass identity or whatever fold they assert.
export type ProviderGroup = (provider: string) => string;

// Series present, slot-ordered (unknowns last, alphabetical); drives the pills, stack and legend alike.
export const providersIn = (rows: readonly UsageRollupRow[], groupOf: ProviderGroup): string[] => {
    const present = new Set(rows.map((row) => groupOf(row.provider)));
    const known = PROVIDER_SERIES.filter((provider) => present.has(provider));
    const unknown = [...present].filter((provider) => !PROVIDER_SERIES.includes(provider as (typeof PROVIDER_SERIES)[number])).toSorted();
    return [...known, ...unknown];
};

// the time series

// Bucket widens past a quarter (365 daily columns would smear) so each column stays a readable mark.
export type Bucket = "day" | "week" | "month";
export const bucketFor = (days: number): Bucket => (days <= 92 ? `day` : days <= 730 ? `week` : `month`);

export interface SpendBucket {
    // The bucket's first day (YYYY-MM-DD), its identity and sort key.
    readonly start: string;
    readonly label: string;
    // Every measure for the bucket, so columns and stat-tile trends share one pass and can't disagree.
    readonly totals: UsageTotals;
    // Cost by provider, slot-ordered; zero-value segments kept so the stack's colour order matches every column.
    readonly segments: readonly { readonly key: string; readonly value: number }[];
}

const MONTHS = [`Jan`, `Feb`, `Mar`, `Apr`, `May`, `Jun`, `Jul`, `Aug`, `Sep`, `Oct`, `Nov`, `Dec`] as const;
const monthLabel = (day: string): string => `${MONTHS[Number(day.slice(5, 7)) - 1] ?? ``} ${day.slice(0, 4)}`;
const dayLabel = (day: string): string => `${MONTHS[Number(day.slice(5, 7)) - 1] ?? ``} ${Number(day.slice(8, 10))}`;

// Days anchor to themselves; weeks grid back from the window's last day; months to the 1st.
const bucketStart = (day: string, bucket: Bucket, window: { from: string; to: string }): string => {
    if (bucket === `day`) {
        return day;
    }
    if (bucket === `month`) {
        return `${day.slice(0, 7)}-01`;
    }
    const offset = Math.floor((dayToMs(window.to) - dayToMs(day)) / DAY_MS);
    return shiftDay(window.to, -(offset - (offset % 7)) - 6);
};

// Zero-filled: an idle period is a gap, not a missing column. Absent `window.from` spans the data itself.
export const usageSeries = (
    rows: readonly UsageRollupRow[],
    window: DayWindow,
    providers: readonly string[],
    groupOf: ProviderGroup,
): SpendBucket[] => {
    const from = window.from ?? rows.map((row) => row.day).toSorted()[0];
    if (from === undefined || from > window.to) {
        return [];
    }
    const bounded = { from, to: window.to };
    const bucket = bucketFor(daySpan(from, window.to));

    // Every bucket in range first, so empty ones exist before any row is folded in.
    const buckets = new Map<string, UsageRollupRow[]>();
    for (let day = from; day <= window.to; day = shiftDay(day, 1)) {
        const start = bucketStart(day, bucket, bounded);
        if (!buckets.has(start)) {
            buckets.set(start, []);
        }
    }
    for (const row of rows) {
        buckets.get(bucketStart(row.day, bucket, bounded))?.push(row);
    }

    return [...buckets.entries()]
        .toSorted(([left], [right]) => left.localeCompare(right))
        .map(([start, bucketRows]) => ({
            start,
            label: bucket === `month` ? monthLabel(start) : dayLabel(start),
            totals: totalsOf(bucketRows),
            segments: providers.map((key) => ({
                key,
                value: bucketRows.reduce((sum, row) => (groupOf(row.provider) === key ? sum + row.costUsd : sum), 0),
            })),
        }));
};

// Down-samples to a shape cue, not a plot; averages (not max) so a spike doesn't read as a plateau.
export const sparkPoints = (values: readonly number[], count = 12): number[] => {
    if (values.length <= count) {
        return [...values];
    }
    const size = values.length / count;
    return Array.from({ length: count }, (_, index) => {
        const slice = values.slice(Math.floor(index * size), Math.floor((index + 1) * size));
        return slice.reduce((sum, value) => sum + value, 0) / Math.max(1, slice.length);
    });
};

// ranked bars

// `kind`, not a sentinel key, so an entity actually named "other" can't collide with the fold bucket.
// `unattributed` covers rows with no value for this dimension; kept, not dropped, since that spend is real.
export interface RankedEntry {
    readonly key: string | undefined;
    readonly kind: "value" | "unattributed" | "other";
    readonly label: string;
    readonly value: number;
    // Distinct providers behind this bar; exactly one colours it, more than one falls back to achromatic.
    readonly providers: readonly string[];
}

// A stable, collision-free v-for key, the kind disambiguates, so no reserved string is needed.
export const rankedKey = (entry: RankedEntry): string => `${entry.kind}:${entry.key ?? ``}`;

// Cost by dimension, biggest first, tail folded so a reader sees how much was folded in.
export const rankByCost = (
    rows: readonly UsageRollupRow[],
    keyOf: (row: UsageRollupRow) => string | undefined,
    labelOf: (key: string) => string,
    unattributedLabel: string,
    groupOf: ProviderGroup,
    limit = 8,
): RankedEntry[] => {
    const totals = new Map<string | undefined, { value: number; providers: Set<string> }>();
    for (const row of rows) {
        const key = keyOf(row);
        const current = totals.get(key) ?? { value: 0, providers: new Set<string>() };
        current.value += row.costUsd;
        current.providers.add(groupOf(row.provider));
        totals.set(key, current);
    }
    const ranked = [...totals.entries()]
        .map(([key, { value, providers }]): RankedEntry => ({
            key,
            kind: key === undefined ? `unattributed` : `value`,
            label: key === undefined ? unattributedLabel : labelOf(key),
            value,
            providers: [...providers],
        }))
        .filter((entry) => entry.value > 0)
        .toSorted((left, right) => right.value - left.value);
    if (ranked.length <= limit) {
        return ranked;
    }
    const tail = ranked.slice(limit - 1);
    return [
        ...ranked.slice(0, limit - 1),
        {
            key: undefined,
            kind: `other`,
            label: `${tail.length} more`,
            value: tail.reduce((sum, entry) => sum + entry.value, 0),
            // The fold mixes providers by construction, so it takes the achromatic slot.
            providers: [],
        },
    ];
};

// Palette slot, not a colour (`<BarChart>` owns slot->var): the provider's if singular, else achromatic.
export const rankedAccent = (entry: RankedEntry): FigureAccent => (entry.providers.length === 1 ? providerAccent(entry.providers[0]!) : `neutral`);

// Money formatting, muted fold/unattributed styling, and the key all live here, not in the chart.
export const rankedBars = (entries: readonly RankedEntry[]): BarItem[] =>
    entries.map((entry) => ({
        label: entry.label,
        value: entry.value,
        display: formatUsd(entry.value),
        accent: rankedAccent(entry),
        key: rankedKey(entry),
        muted: entry.kind !== `value`,
    }));

// axis

// Rounds up to a clean top (1/2/2.5/5 x10^n); zero data still yields a positive top to draw against.
export const niceMax = (max: number): number => {
    if (max <= 0) {
        return 1;
    }
    const magnitude = 10 ** Math.floor(Math.log10(max));
    const normalized = max / magnitude;
    const step = normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 2.5 ? 2.5 : normalized <= 5 ? 5 : 10;
    return step * magnitude;
};

// formatting

// Always two decimals for column alignment; a nonzero amount rounding to $0.00 prints "<$0.01" instead.
export const formatUsd = (value: number): string =>
    value > 0 && value < 0.005 ? `<$0.01` : `$${value.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

// Precision steps down with magnitude (cents below $10k, whole dollars to $1M, then compacted) to fit hero-size
// width; at most nine glyphs. The exact figure lives in the header, table and CSV; this view is only for the number's
// order.
export const formatUsdHero = (value: number): string => {
    if (value < 10_000) {
        return formatUsd(value);
    }
    return value < 1_000_000 ? `$${Math.round(value).toLocaleString()}` : `$${formatCompact(value)}`;
};

// Compacted past 1,000 (999 / 1.3K / 18.4M); one decimal below 100 scaled, none above (noise past there).
export const formatCompact = (value: number): string => {
    if (value < 1_000) {
        return String(Math.round(value));
    }
    const [divisor, suffix] = value < 1_000_000 ? [1_000, `K`] : value < 1_000_000_000 ? [1_000_000, `M`] : [1_000_000_000, `B`];
    const scaled = value / divisor;
    return `${scaled.toLocaleString(undefined, { maximumFractionDigits: scaled < 100 ? 1 : 0 })}${suffix}`;
};

export const formatPercent = (value: number | undefined): string => (value === undefined ? `—` : `${Math.round(value)}%`);

export const formatDelta = (value: number | undefined): string | undefined =>
    value === undefined ? undefined : `${value >= 0 ? `+` : `−`}${Math.abs(value) < 10 ? Math.abs(value).toFixed(1) : Math.round(Math.abs(value))}%`;

// export

const CSV_COLUMNS = [
    `day`,
    `provider`,
    `account`,
    `model`,
    `harness`,
    `agent`,
    `turns`,
    `inputTokens`,
    `outputTokens`,
    `cacheReadTokens`,
    `cacheCreationTokens`,
    `costUsd`,
    `durationMs`,
] as const;

// RFC-4180 quoting: wraps only fields with a delimiter, quote or newline (ids are user data, not comma-free).
const csvField = (value: string | number | undefined): string => {
    const text = value === undefined ? `` : String(value);
    return /[",\r\n]/.test(text) ? `"${text.replaceAll(`"`, `""`)}"` : text;
};

// Exports exactly what the screen shows, filters included; more than the view would be its own kind of lie.
export const usageCsv = (rows: readonly UsageRollupRow[]): string =>
    [
        CSV_COLUMNS.join(`,`),
        ...rows.map((row) =>
            [
                row.day,
                row.provider,
                row.account,
                row.model,
                row.harness,
                row.conversationId,
                row.turns,
                row.inputTokens,
                row.outputTokens,
                row.cacheReadTokens,
                row.cacheCreationTokens,
                row.costUsd,
                row.durationMs,
            ]
                .map(csvField)
                .join(`,`),
        ),
    ].join(`\n`);
