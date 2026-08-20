import type { FigureAccent } from "@intentic/ui/markdown";
import type { BarItem } from "@intentic/ui";
import { seriesColor } from "@intentic/ui/series";
import type { UsageRollupRow } from "@intentic/sandbox-contract";

/* Every number and every mark on the Usage tab, as pure functions over the daemon's rollup rows. The screen
 * itself only binds; the projections live here so the arithmetic that a money readout stands on is testable
 * without mounting a component, the same split as toolPresentation.ts. */

const DAY_MS = 86_400_000;
const dayToMs = (day: string): number => Date.parse(`${day}T00:00:00Z`);
const msToDay = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

// The UTC day an instant falls in, the same bucket the daemon stamps rows with (usage-store.ts), so the
// browser's window bounds and the ledger's days are the same calendar.
export const todayUtc = (now: number = Date.now()): string => msToDay(now);
export const shiftDay = (day: string, days: number): string => msToDay(dayToMs(day) + days * DAY_MS);
// Inclusive day count: a from/to pair covering one day is 1, not 0.
export const daySpan = (from: string, to: string): number => Math.round((dayToMs(to) - dayToMs(from)) / DAY_MS) + 1;

// ---- the window ------------------------------------------------------------------------------------------

export type RangePreset = "7d" | "30d" | "90d" | "all";
// Mutable by design — <SegmentedControl> takes its options array as-is.
export const RANGE_PRESETS: { label: string; value: RangePreset }[] = [
    { label: `7 days`, value: `7d` },
    { label: `30 days`, value: `30d` },
    { label: `90 days`, value: `90d` },
    { label: `All time`, value: `all` },
];

// An inclusive UTC day range. `from` absent ⇒ unbounded start (All time), deliberately NOT a sentinel date,
// because "since the ledger began" and "since some very old day" differ the moment a comparison is drawn.
export interface DayWindow {
    readonly from?: string;
    readonly to: string;
}

const PRESET_DAYS: Record<Exclude<RangePreset, "all">, number> = { "7d": 7, "30d": 30, "90d": 90 };

export const windowFor = (preset: RangePreset, today: string): DayWindow =>
    preset === `all` ? { to: today } : { from: shiftDay(today, -(PRESET_DAYS[preset] - 1)), to: today };

// The equally-long window immediately before this one, what a delta compares against. Undefined for All time:
// there is nothing before "everything", and inventing a baseline would put a confident ±% under a number that
// has none.
export const previousWindow = (window: DayWindow): DayWindow | undefined => {
    if (window.from === undefined) {
        return undefined;
    }
    const days = daySpan(window.from, window.to);
    return { from: shiftDay(window.from, -days), to: shiftDay(window.from, -1) };
};

export const inWindow = (rows: readonly UsageRollupRow[], window: DayWindow): UsageRollupRow[] =>
    rows.filter((row) => (window.from === undefined || row.day >= window.from) && row.day <= window.to);

// ---- totals ----------------------------------------------------------------------------------------------

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

// The share of PROMPT input that came off the provider's cache, how well prefix caching is working. Cache
// creation is excluded from the denominator on purpose: it is the cost of filling the cache, not a lookup that
// could have hit. Undefined when nothing was sent, so an idle window reads as "—" rather than a confident 0%.
export const cacheHitRate = (totals: UsageTotals): number | undefined => {
    const lookups = totals.cacheReadTokens + totals.inputTokens;
    return lookups === 0 ? undefined : (100 * totals.cacheReadTokens) / lookups;
};

// Signed percent change against the previous window. Undefined when there is no baseline (All time) or the
// baseline is zero, a jump from nothing to something is not "+∞%", it is a first period.
export const deltaPercent = (current: number, previous: number | undefined): number | undefined =>
    previous === undefined || previous === 0 ? undefined : (100 * (current - previous)) / previous;

// ---- series identity -------------------------------------------------------------------------------------

/* The categorical slot order. This IS the validated palette order (primitive-colors.css): the colorblind
 * checks measure ADJACENT pairs, so the sequence is part of the result, not a display preference, swapping
 * kimi and grok here drops the worst pair from ΔE 12.5 to 4.0 and fails the check. Charts render series in
 * this order for that reason. A provider outside the list (an installed ACP agent) takes the achromatic tail
 * slot rather than a sixth generated hue. */
export const PROVIDER_SERIES = [`claude`, `codex`, `kimi`, `grok`, `gemini`] as const;

/* Colour follows the ENTITY, for good: the slot comes from the provider's identity, never from its rank in the
 * current filter, so hiding a provider can't repaint the survivors.
 *
 * Named for the provider it keys on, not for the palette it lands in, as `seriesColor` it collided with the
 * design system's own `seriesColor` (a figure's authored slot → the same CSS var). Two functions of one name
 * mapping different domains into one palette is a collision an import line cannot show you. This one owns the
 * provider→slot half only; the slot→var half stays where it always was. */
const providerAccent = (key: string): FigureAccent => {
    const slot = PROVIDER_SERIES.indexOf(key as (typeof PROVIDER_SERIES)[number]);
    return slot === -1 ? `neutral` : (String(slot + 1) as FigureAccent);
};

export const providerColor = (key: string): string => seriesColor(providerAccent(key));

// The providers actually present in these rows, in slot order (unknown providers last, alphabetical). Drives
// both the stack order and the legend, so the two can never disagree.
export const providersIn = (rows: readonly UsageRollupRow[]): string[] => {
    const present = new Set(rows.map((row) => row.provider));
    const known = PROVIDER_SERIES.filter((provider) => present.has(provider));
    const unknown = [...present].filter((provider) => !PROVIDER_SERIES.includes(provider as (typeof PROVIDER_SERIES)[number])).toSorted();
    return [...known, ...unknown];
};

// ---- the time series -------------------------------------------------------------------------------------

// How the columns are bucketed. A day per column is the honest grain, but 365 columns in a card is a smear,
// past a quarter the bucket widens so a column stays a readable mark instead of a hairline.
export type Bucket = "day" | "week" | "month";
export const bucketFor = (days: number): Bucket => (days <= 92 ? `day` : days <= 730 ? `week` : `month`);

export interface SpendBucket {
    // The bucket's first day (YYYY-MM-DD), its identity and sort key.
    readonly start: string;
    readonly label: string;
    // Every measure for the bucket, so the columns and the stat tiles' trends come off ONE pass, and can't
    // drift into disagreeing about the same period.
    readonly totals: UsageTotals;
    // Cost split by provider: one entry per provider present in the window, in slot order. Zero-value segments
    // are kept so the stack's colour order is identical in every column.
    readonly segments: readonly { readonly key: string; readonly value: number }[];
}

const MONTHS = [`Jan`, `Feb`, `Mar`, `Apr`, `May`, `Jun`, `Jul`, `Aug`, `Sep`, `Oct`, `Nov`, `Dec`] as const;
const monthLabel = (day: string): string => `${MONTHS[Number(day.slice(5, 7)) - 1] ?? ``} ${day.slice(0, 4)}`;
const dayLabel = (day: string): string => `${MONTHS[Number(day.slice(5, 7)) - 1] ?? ``} ${Number(day.slice(8, 10))}`;

// The bucket a day belongs to: days anchor to themselves, weeks to a fixed grid running back from the window's
// last day (so the newest bucket is always a full-width one), months to the first of the month.
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

// Usage over time, zero-filled: a period nothing ran is a gap in the columns, not a missing column, so the
// shape tells the truth about idle stretches. `window.from` absent (All time) spans the data itself.
export const usageSeries = (rows: readonly UsageRollupRow[], window: DayWindow, providers: readonly string[]): SpendBucket[] => {
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
                value: bucketRows.reduce((sum, row) => (row.provider === key ? sum + row.costUsd : sum), 0),
            })),
        }));
};

// Down-sample a series to at most `count` points for a stat tile's sparkline, a shape cue, not a readable
// plot, so averaging is the right compression (a max would make one spike look like a plateau).
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

// ---- ranked bars -----------------------------------------------------------------------------------------

/* One bar. `kind` rather than a sentinel key, so a real model or agent literally named "other" can't be
 * mistaken for the fold bucket, and so the two special rows are distinguishable in code without string
 * matching. `unattributed` covers rows carrying no value for this dimension (a provider default served the
 * turn, a main-tree turn has no agent): named rather than dropped, because that spend is real and hiding it
 * makes the bars sum to less than the headline above them. */
export interface RankedEntry {
    readonly key: string | undefined;
    readonly kind: "value" | "unattributed" | "other";
    readonly label: string;
    readonly value: number;
    // The distinct providers whose turns make up this bar. A model or an agent almost always has exactly one,
    // which lets the bar wear that provider's series colour, identity, not a value ramp on bar length. More
    // than one (or none) falls back to the achromatic slot rather than picking a winner.
    readonly providers: readonly string[];
}

// A stable, collision-free v-for key, the kind disambiguates, so no reserved string is needed.
export const rankedKey = (entry: RankedEntry): string => `${entry.kind}:${entry.key ?? ``}`;

// Cost by <dimension>, biggest first, tail folded. Never more slots than the palette has, and the fold is
// explicit so a reader can see how much is in it.
export const rankByCost = (
    rows: readonly UsageRollupRow[],
    keyOf: (row: UsageRollupRow) => string | undefined,
    labelOf: (key: string) => string,
    unattributedLabel: string,
    limit = 8,
): RankedEntry[] => {
    const totals = new Map<string | undefined, { value: number; providers: Set<string> }>();
    for (const row of rows) {
        const key = keyOf(row);
        const current = totals.get(key) ?? { value: 0, providers: new Set<string>() };
        current.value += row.costUsd;
        current.providers.add(row.provider);
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

// The bar's palette SLOT: its provider's when the bar belongs to exactly one provider, the achromatic tail
// otherwise. Never a ramp keyed to the bar's own length, that double-encodes what the length already says.
// A slot rather than a colour, because <BarChart> takes accents and owns the slot→var step for every figure.
export const rankedAccent = (entry: RankedEntry): FigureAccent => (entry.providers.length === 1 ? providerAccent(entry.providers[0]!) : `neutral`);

// One ranked cost list → the shared bar figure's items. The money formatting, the fold/unattributed rows'
// quieter type and the collision-proof key all live here, where the domain is, rather than in the chart.
export const rankedBars = (entries: readonly RankedEntry[]): BarItem[] =>
    entries.map((entry) => ({
        label: entry.label,
        value: entry.value,
        display: formatUsd(entry.value),
        accent: rankedAccent(entry),
        key: rankedKey(entry),
        muted: entry.kind !== `value`,
    }));

// ---- axis ------------------------------------------------------------------------------------------------

// Round a maximum up to a clean axis top (1 / 2 / 2.5 / 5 × a power of ten) so the ticks read as numbers a
// person would say. Zero data still yields a positive top, a chart with a 0-height axis has nowhere to draw.
export const niceMax = (max: number): number => {
    if (max <= 0) {
        return 1;
    }
    const magnitude = 10 ** Math.floor(Math.log10(max));
    const normalized = max / magnitude;
    const step = normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 2.5 ? 2.5 : normalized <= 5 ? 5 : 10;
    return step * magnitude;
};

// ---- formatting ------------------------------------------------------------------------------------------

// Money, always two decimals so a column of costs aligns. A non-zero amount that rounds to nothing says so
// rather than printing $0.00, which reads as free.
export const formatUsd = (value: number): string =>
    value > 0 && value < 0.005 ? `<$0.01` : `$${value.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/* Money at hero size, where WIDTH is a constraint the tile can't negotiate away: at 48px a stray thousands
 * group is the difference between a number and a number that has left its card. So precision steps down with
 * magnitude, cents below $10k (where they're the difference between "$36.62" and a shrug), whole dollars to
 * $1M, then compacted. Nine glyphs, worst case, at any amount a sandbox can reach.
 *
 * Nothing is lost by this: the chart header, the table and the CSV all carry the exact figure, and this is the
 * one place where a reader is looking at the ORDER of a number rather than reconciling it. */
export const formatUsdHero = (value: number): string => {
    if (value < 10_000) {
        return formatUsd(value);
    }
    return value < 1_000_000 ? `$${Math.round(value).toLocaleString()}` : `$${formatCompact(value)}`;
};

// Counts, compacted past a thousand: 999 / 1.3K / 18.4M / 124M. Three significant digits, a tenth is what
// separates "18.4M tokens" from a flat "18M", and past 100 that digit is noise.
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

// ---- export ----------------------------------------------------------------------------------------------

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

// RFC-4180 quoting: a field is wrapped only when it contains a delimiter, a quote or a newline, and an inner
// quote is doubled. Model and agent ids are provider/user data, assuming they're comma-free is how an export
// silently shifts every later column.
const csvField = (value: string | number | undefined): string => {
    const text = value === undefined ? `` : String(value);
    return /[",\r\n]/.test(text) ? `"${text.replaceAll(`"`, `""`)}"` : text;
};

// The filtered rollup as CSV, the escape hatch for anyone who wants to reconcile a number themselves. Exports
// exactly what the screen is showing, filters included; a file that quietly held more than the view would be a
// different kind of lie.
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
