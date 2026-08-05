import type { AgentEvent } from "@intentic/sandbox-contract";

// The turn's accounting frame. A turn can emit several — one per steered follow-up turn — and every consumer
// that answers "what did this turn cost" (the spend ledger, the activity log) wants their SUM, not the last.
export type UsageFrame = Extract<AgentEvent, { kind: "usage" }>;

const add = (a: number | undefined, b: number | undefined): number | undefined => (a === undefined ? b : b === undefined ? a : a + b);

// Add two accounting frames. Every field is optional per provider, so a field is present iff either side
// reported it. `durationMs` sums as compute time spent rather than wall clock. Adding to a running total that
// may not exist yet is the common call, so a defined addend gives a defined total (the first overload) with no
// re-narrowing at the site.
export function sumUsage(a: UsageFrame | undefined, b: UsageFrame): UsageFrame;
export function sumUsage(a: UsageFrame | undefined, b: UsageFrame | undefined): UsageFrame | undefined;
export function sumUsage(a: UsageFrame | undefined, b: UsageFrame | undefined): UsageFrame | undefined {
    if (a === undefined) {
        return b;
    }
    if (b === undefined) {
        return a;
    }
    const account = a.account ?? b.account;
    const costUsd = add(a.costUsd, b.costUsd);
    const inputTokens = add(a.inputTokens, b.inputTokens);
    const outputTokens = add(a.outputTokens, b.outputTokens);
    const cacheReadTokens = add(a.cacheReadTokens, b.cacheReadTokens);
    const cacheCreationTokens = add(a.cacheCreationTokens, b.cacheCreationTokens);
    const durationMs = add(a.durationMs, b.durationMs);
    const numTurns = add(a.numTurns, b.numTurns);
    return {
        kind: "usage",
        ...(account !== undefined ? { account } : {}),
        ...(costUsd !== undefined ? { costUsd } : {}),
        ...(inputTokens !== undefined ? { inputTokens } : {}),
        ...(outputTokens !== undefined ? { outputTokens } : {}),
        ...(cacheReadTokens !== undefined ? { cacheReadTokens } : {}),
        ...(cacheCreationTokens !== undefined ? { cacheCreationTokens } : {}),
        ...(durationMs !== undefined ? { durationMs } : {}),
        ...(numTurns !== undefined ? { numTurns } : {}),
    };
}
