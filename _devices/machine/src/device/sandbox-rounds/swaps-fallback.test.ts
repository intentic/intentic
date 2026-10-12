import { readFileSync } from "node:fs";
import { join } from "node:path";
import { repoRoot } from "@intentic/constants/node";
import type { DeviceSwap } from "@intentic/sandbox-contract";
import { CUTOVER_HEARTBEAT_SECS, CUTOVER_STALE_MS, cutoverInProgress, swapOfRecord } from "./swaps-fallback.js";

/* COMPAT(ic-swaps): remove with swaps-fallback.ts. The fallback for an ic without `ic sandbox swaps` applies ic's rule,
and is held to it by the contract's golden: the same file ic's Rust test builds every row of (ic/src/sandbox/swaps.rs). */

interface VerdictCase {
    readonly name: string;
    readonly record: string;
    readonly now: number;
    readonly swap: DeviceSwap | null;
}

// SAFETY: the golden is this repository's own file; the assertions below fail on any field it lacks.
const GOLDEN = JSON.parse(readFileSync(join(repoRoot(import.meta.url), "_shared/sandbox-contract/golden/swap-verdicts.json"), "utf8")) as {
    readonly slug: string;
    readonly heartbeatSecs: number;
    readonly staleMs: number;
    readonly cases: VerdictCase[];
};

test("the fallback's constants are the ones the golden records for ic", () => {
    expect({ heartbeatSecs: CUTOVER_HEARTBEAT_SECS, staleMs: CUTOVER_STALE_MS }).toEqual({ heartbeatSecs: GOLDEN.heartbeatSecs, staleMs: GOLDEN.staleMs });
});

test.each(GOLDEN.cases)("$name", ({ record, now, swap }) => {
    expect(swapOfRecord(GOLDEN.slug, record, now) ?? null).toEqual(swap);
});

test("the rule is read off the heartbeat when there is one and the start when there is not, at the boundary", () => {
    expect(cutoverInProgress("cutover", 1_000, undefined, 1_000 + CUTOVER_STALE_MS - 1)).toBe(true);
    expect(cutoverInProgress("cutover", 1_000, undefined, 1_000 + CUTOVER_STALE_MS)).toBe(false);
    expect(cutoverInProgress("cutover", 1_000, 50_000, 50_000 + CUTOVER_STALE_MS - 1)).toBe(true);
    expect(cutoverInProgress("cutover", 1_000, 50_000, 50_000 + CUTOVER_STALE_MS)).toBe(false);
    expect(cutoverInProgress("probation", 1_000, 1_000, 1_001)).toBe(false);
});
