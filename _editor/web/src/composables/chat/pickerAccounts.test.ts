import { expect, test, vi } from "vitest";
import { capacityCounts, matchAccounts } from "./pickerAccounts";
import type { PlanHeadroom } from "./usageStatus";

/* The two derivations that let the model picker's footer survive a POOL rather than a handful of accounts: the
 * line a folded list states in place of its rows, and the filter that finds one row inside an opened fold.
 *
 * Both are pure, and both are the reason folding is not just hiding: a fold that dropped the readings would make
 * the footer smaller and less useful at once. */

// pickerAccounts reaches useChat for the live account lists; stub its side-effecting seams so the import is inert.
vi.mock("../sandbox/sandboxClient", () => ({ sandboxRequest: vi.fn() }));
vi.mock("./useChat", () => ({ accountsOf: vi.fn(() => []), refreshConnections: vi.fn(async () => {}), subscriptionOnly: vi.fn(() => false) }));

const headroom = (percent: number): PlanHeadroom => ({
    percent,
    tone: `text-link`,
    stale: false,
    measuredAt: 0,
    pools: [],
    binding: undefined,
});

const row = (label: string, percent?: number, subtitle?: string) => ({
    label,
    subtitle,
    headroom: percent === undefined ? undefined : headroom(percent),
});

test("bands a pool by account count, worst first: the one figure that survives folding", () => {
    // 90 and 75 are the shared thresholds (SPENT_PERCENT / TIGHT_PERCENT), so the footer's summary and the Usage
    // tab's capacity bar cannot call the same account by two different names.
    const counts = capacityCounts(`claude`, [row(`a`, 12), row(`b`, 80), row(`c`, 95), row(`d`, 40)]);
    expect(counts.map((count) => [count.band, count.count])).toEqual([
        [`spent`, 1],
        [`tight`, 1],
        [`room`, 2],
    ]);
});

test("counts a never-measured account as unread rather than as room: unknown is not headroom", () => {
    const counts = capacityCounts(`claude`, [row(`a`, 5), row(`b`)]);
    expect(counts.find((count) => count.band === `unread`)?.count).toBe(1);
    expect(counts.find((count) => count.band === `room`)?.count).toBe(1);
});

test("says nothing at all for a plan that publishes no limits, rather than reporting it as a degree of fullness", () => {
    // SuperGrok publishes no pools: every row bands as `none`, which the capacity line drops entirely, the
    // disclosure then carries the count alone.
    expect(capacityCounts(`grok`, [row(`a`), row(`b`)])).toEqual([]);
});

test("matches the identity line as well as the name: a pool is looked up by the part of the address you remember", () => {
    const rows = [row(`Google`, 10, `radarsuspam12@gmail.com`), row(`Google`, 10, `radratdev@gmail.com`)];
    expect(matchAccounts(rows, `spam12`)).toEqual([rows[0]]);
    expect(matchAccounts(rows, `RADRATDEV`)).toEqual([rows[1]]);
});

test("an empty or blank query is not a filter: the whole list comes back", () => {
    const rows = [row(`a`, 10), row(`b`, 10)];
    expect(matchAccounts(rows, ``)).toBe(rows);
    expect(matchAccounts(rows, `   `)).toBe(rows);
});
