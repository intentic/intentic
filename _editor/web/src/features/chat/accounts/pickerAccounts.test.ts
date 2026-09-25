import { type AccountState, headroomState } from "@intentic/sandbox-contract";
import { capacityCounts, matchAccounts } from "./pickerAccounts";
import type { PlanHeadroom } from "../session/usageStatus";
import { fakeSandboxRpc } from "../../../testing/sandboxRpcFake";

// The two derivations behind a folded account list: the summary line a fold states in place of its
// rows, and the filter that finds one row inside it. Both pure functions.

// pickerAccounts reaches useChat for live account lists; stub its side-effecting seams so import
// stays inert.
jest.mock("../../sandbox/client/sandboxRpc", () => ({ sandboxRpc: fakeSandboxRpc() }));
jest.mock("./useChat-accounts", () => ({
    accountsOf: jest.fn(() => []),
    refreshConnections: jest.fn(async () => {}),
    subscriptionOnly: jest.fn(() => false),
}));

const headroom = (percent: number): PlanHeadroom => ({
    percent,
    tone: `text-link`,
    stale: false,
    measuredAt: 0,
    unread: undefined,
    pools: [],
    binding: undefined,
});

// A row as the picker builds it: its ring, and the verdict the contract's rule gives that reading.
const row = (label: string, percent?: number, subtitle?: string, state?: AccountState) => ({
    label,
    subtitle,
    headroom: percent === undefined ? undefined : headroom(percent),
    state:
        state ??
        headroomState(percent === undefined ? undefined : { measuredAt: 0, windows: [{ kind: `seven_day`, utilization: percent, gates: `all` }] }),
});

test("bands a pool by account count, worst first: the one figure that survives folding", () => {
    // Banded off each row's verdict, so this summary and the Usage tab's bar agree on the same account: spent is the
    // contract's line (100), tight a tint from 75.
    const counts = capacityCounts(`claude`, [row(`a`, 12), row(`b`, 80), row(`c`, 100), row(`d`, 40), row(`e`, 95)]);
    expect(counts.map((count) => [count.band, count.count])).toEqual([
        [`spent`, 1],
        [`tight`, 2],
        [`room`, 2],
    ]);
    // A seat nothing can run on is not a degree of fullness, whatever its ring says.
    const blocked = capacityCounts(`claude`, [row(`a`, 3, undefined, { kind: `blocked`, fix: `admin`, reason: `No seat.` })]);
    expect(blocked.map((count) => [count.band, count.count])).toEqual([[`blocked`, 1]]);
});

test("counts a never-measured account as unread rather than as room: unknown is not headroom", () => {
    const counts = capacityCounts(`claude`, [row(`a`, 5), row(`b`)]);
    expect(counts.find((count) => count.band === `unread`)?.count).toBe(1);
    expect(counts.find((count) => count.band === `room`)?.count).toBe(1);
});

test("says nothing at all for a plan that publishes no limits, rather than reporting it as a degree of fullness", () => {
    // SuperGrok publishes no pools; every row bands as `none` and the capacity line drops it entirely.
    expect(capacityCounts(`grok`, [row(`a`), row(`b`)])).toEqual([]);
});

test("matches the identity line as well as the name: a pool is looked up by the part of the address you remember", () => {
    const rows = [row(`Google`, 10, `radarsuspam12@gmail.com`), row(`Google`, 10, `radratdev@gmail.com`)];
    expect(matchAccounts(rows, `spam12`)).toEqual([rows[0]!]);
    expect(matchAccounts(rows, `RADRATDEV`)).toEqual([rows[1]!]);
});

test("an empty or blank query is not a filter: the whole list comes back", () => {
    const rows = [row(`a`, 10), row(`b`, 10)];
    expect(matchAccounts(rows, ``)).toBe(rows);
    expect(matchAccounts(rows, `   `)).toBe(rows);
});
