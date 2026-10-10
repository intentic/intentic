import { computed } from "vue";
import {
    formatBinaryBytes,
    formatBytes,
    formatCompact,
    formatCount,
    formatDate,
    formatElapsed,
    formatList,
    formatMoney,
    formatTokens,
    setFormatLocale,
    timeAgo,
} from "@intentic/ui/format";

// The kit's one formatter per concept (format.ts), each in two languages: the separators, the unit words and the
// compact suffixes are the language's own, while the rounding rule is the same in every one of them. Polish separates
// with a no-break space, spelled \u00a0 here so the expectation shows it.

afterEach(() => setFormatLocale(`en`));

const inLocale = <T>(tag: string, read: () => T): T => {
    setFormatLocale(tag);
    return read();
};

describe(`formatBinaryBytes: resource counters in explicit binary units`, () => {
    it(`retains unknown and zero, then scales at powers of 1024 with the existing compact rounding`, () => {
        expect([
            formatBinaryBytes(undefined),
            formatBinaryBytes(0),
            formatBinaryBytes(1023),
            formatBinaryBytes(1024),
            formatBinaryBytes(9.94 * 1024),
            formatBinaryBytes(10 * 1024),
            formatBinaryBytes(2 ** 20),
            formatBinaryBytes(5.5 * 2 ** 30),
            formatBinaryBytes(2 ** 40),
        ]).toEqual([``, `0 B`, `1023 B`, `1.0 KiB`, `9.9 KiB`, `10 KiB`, `1.0 MiB`, `5.5 GiB`, `1.0 TiB`]);
        expect(formatBytes(2 ** 30)).toBe(`1.0 GB`);
    });

    it(`uses Polish decimals and grouping without changing unit symbols`, () => {
        expect(inLocale(`pl`, () => [formatBinaryBytes(5.5 * 2 ** 30), formatBinaryBytes(12_345 * 2 ** 40)])).toEqual([`5,5 GiB`, `12 345 TiB`]);
    });

    it(`reformats an already cached reactive reading after the locale changes`, () => {
        const text = computed(() => formatBinaryBytes(1.5 * 2 ** 20));
        expect(text.value).toBe(`1.5 MiB`);
        setFormatLocale(`pl`);
        expect(text.value).toBe(`1,5 MiB`);
    });
});

describe(`formatElapsed: a span of time in its two largest units, rounded down`, () => {
    it(`speaks English narrowly, drops a zero second unit, and never rounds up`, () => {
        expect([formatElapsed(0), formatElapsed(45.9), formatElapsed(187), formatElapsed(14 * 60), formatElapsed(2 * 3_600 + 5 * 60 + 59)]).toEqual([
            `0s`,
            `45s`,
            `3m 7s`,
            `14m`,
            `2h 5m`,
        ]);
        expect([formatElapsed(3 * 86_400 + 4 * 3_600 + 59 * 60), formatElapsed(-5), formatElapsed(Number.NaN)]).toEqual([`3d 4h`, `0s`, `0s`]);
    });

    it(`keeps an allowance in hours when asked`, () => {
        expect([formatElapsed(217 * 3_600, { largest: `hours` }), formatElapsed(95 * 60, { largest: `hours` })]).toEqual([`217h`, `1h 35m`]);
    });

    it(`speaks Polish in Polish`, () => {
        expect(inLocale(`pl`, () => [formatElapsed(187), formatElapsed(45)])).toEqual([`3 min i 7 s`, `45 s`]);
    });
});

describe(`formatMoney: always cents, and nothing spent only when nothing was`, () => {
    it(`writes dollars the English way`, () => {
        expect([formatMoney(0), formatMoney(0.004), formatMoney(0.005), formatMoney(47.2), formatMoney(1_234.5)]).toEqual([
            `$0.00`,
            `<$0.01`,
            `$0.01`,
            `$47.20`,
            `$1,234.50`,
        ]);
    });

    it(`steps a hero figure down to whole dollars, then a compact one`, () => {
        expect([
            formatMoney(9_999.99, { compact: true }),
            formatMoney(12_480.4, { compact: true }),
            formatMoney(1_240_000, { compact: true }),
        ]).toEqual([`$9,999.99`, `$12,480`, `$1.2M`]);
    });

    it(`writes dollars the Polish way`, () => {
        expect(inLocale(`pl`, () => [formatMoney(47.2), formatMoney(0.004)])).toEqual([`47,20\u00a0USD`, `<0,01\u00a0USD`]);
    });
});

describe(`formatCount and formatCompact: exact and grouped, or at chip width`, () => {
    it(`groups an exact count by the language's own separator, and rounds a fraction away`, () => {
        expect([formatCount(1_234_567), formatCount(9.6)]).toEqual([`1,234,567`, `10`]);
        expect(inLocale(`pl`, () => formatCount(1_234_567))).toBe(`1\u00a0234\u00a0567`);
        expect(inLocale(`de`, () => formatCount(1_234_567))).toBe(`1.234.567`);
    });

    it(`compacts past a thousand, one decimal while the scaled figure is under a hundred`, () => {
        expect([formatCompact(999), formatCompact(1_284), formatCompact(142_345), formatCompact(18_400_000), formatCompact(99_960)]).toEqual([
            `999`,
            `1.3K`,
            `142K`,
            `18.4M`,
            `100K`,
        ]);
        expect(inLocale(`pl`, () => [formatCompact(1_284), formatCompact(18_400_000)])).toEqual([`1,3\u00a0tys.`, `18,4\u00a0mln`]);
    });

    it(`counts tokens as a compact count`, () => {
        expect([formatTokens(1_400_000), formatTokens(12_345), formatTokens(512)]).toEqual([`1.4M`, `12.3K`, `512`]);
    });
});

describe(`formatList: joined with the language's own words`, () => {
    it(`says "and" or "or" as the language does, and follows a language change`, () => {
        expect([formatList([`a`, `b`, `c`]), formatList([`a`, `b`], `disjunction`)]).toEqual([`a, b, and c`, `a or b`]);
        expect(inLocale(`pl`, () => [formatList([`a`, `b`, `c`]), formatList([`a`, `b`], `disjunction`)])).toEqual([`a, b i c`, `a lub b`]);
    });
});

describe(`timeAgo with days: an age for a week, then the day itself`, () => {
    const now = Date.UTC(2026, 9, 5, 12);
    it(`floors every unit, in the language's own words`, () => {
        expect([timeAgo(now - 90 * 60_000, { now, days: true }), timeAgo(now - 6 * 86_400_000, { now, days: true })]).toEqual([`1h ago`, `6d ago`]);
        expect(inLocale(`pl`, () => timeAgo(now - 90 * 60_000, { now, days: true }))).toBe(`1 g. temu`);
    });

    it(`gives the calendar day from a week back`, () => {
        const old = now - 7 * 86_400_000;
        expect(timeAgo(old, { now, days: true })).toBe(formatDate(old));
    });
});
