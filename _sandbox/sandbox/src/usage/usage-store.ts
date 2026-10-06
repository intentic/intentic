import { type UsageRollupRow, type UsageTurn, UsageTurnSchema, utcDayOf } from "@intentic/sandbox-contract";
import { dropAll } from "../store/evolution/conversions.js";
import { defineDocument } from "../store/evolution/documents.js";
import { openLedger } from "../store/open-document.js";

// Durable spend-and-outcome ledger (historyRoot/usage.jsonl): one append-only line per turn, daemon-written only,
// outside the agent's /work mount.
// Never pruned, unlike activity.jsonl: pruning a money log would shrink historical totals as newer turns evict older
// ones.
// `rollup` sums only billed turns (see `billed`), so a ledger holding every failure still projects a cost panel that
// holds none of them.

// One turn per line. A document so a change to a turn's shape ships with its conversion and the shape check sees it;
// `boot: false` since it is JSON Lines, converted line by line on every read.
export const usageLedgerDocument = defineDocument({
    root: "history",
    path: "usage.jsonl",
    schema: UsageTurnSchema,
    granularity: "entries",
    boot: false,
    // The short-guidance experiment's stamps (2026-10-06): the form lost, and the experiment went with it.
    history: [...dropAll(["guidanceArm", "guidanceCohort"])],
});

export interface UsageStore {
    // Fills `at` + `day`; a failed call surfaces to its caller and never poisons later appends.
    readonly record: (turn: Omit<UsageTurn, "at" | "day">) => Promise<void>;
    // Grouped by day, provider, account, model, harness, conversation; oldest day first, inclusive UTC bounds.
    readonly rollup: (query: { from?: string | undefined; to?: string | undefined }) => Promise<UsageRollupRow[]>;
    // The rows themselves, same bounds; unlike rollup, this keeps the per-turn spread that turn-level experiments need
    // for a variance margin.
    readonly turns: (query: { from?: string | undefined; to?: string | undefined }) => Promise<UsageTurn[]>;
}

// UTC calendar day of an instant, deliberately, not the owner's zone: a money log's buckets must not move when
// somebody changes a setting, or last month's totals would change with it. Turns near the owner's midnight land on
// the neighbouring day; totals over any range stay exact, and every screen that shows these says which midnight.
// Re-exported rather than respelled so there is one definition of "UTC day" in the tree (contract's time/zone.ts).
export const utcDay = utcDayOf;

// The rollup's grouping key; JSON of the tuple, not a string join, since a provider id could contain any separator.
const groupKey = (row: Pick<UsageTurn, "day" | "provider" | "account" | "model" | "harness" | "conversationId">): string =>
    JSON.stringify([row.day, row.provider, row.account, row.model, row.harness, row.conversationId]);

// Inclusive UTC day bounds; an absent bound is unbounded on that side.
const inWindow = (turn: UsageTurn, query: { from?: string | undefined; to?: string | undefined }): boolean =>
    (query.from === undefined || turn.day >= query.from) && (query.to === undefined || turn.day <= query.to);

// Whether a turn belongs in the money rollup; a refused turn has all-zero fields and would add empty rows. Reads
// `turns`, not `costUsd`, since a real turn can legitimately cost nothing.
const billed = (turn: UsageTurn): boolean => turn.turns > 0;

export const fileUsageStore = (path: string, now: () => number = Date.now): UsageStore => {
    let queue: Promise<unknown> = Promise.resolve();

    // Only an absent ledger is empty; a torn line (crash mid-append) loses one turn's numbers, never the ledger.
    const ledger = openLedger(usageLedgerDocument, path);
    const read = (): Promise<UsageTurn[]> => ledger.read();

    return {
        record: (turn) => {
            const step = queue.then(async () => {
                const at = now();
                await ledger.append({ at, day: utcDay(at), ...turn });
            });
            // A failed step surfaces to its own caller; the queue chain never poisons later appends.
            queue = step.catch(() => undefined);
            return step;
        },
        turns: async (query) => (await read()).filter((turn) => inWindow(turn, query)),
        rollup: async (query) => {
            const rows = new Map<string, UsageRollupRow>();
            for (const turn of await read()) {
                if (!inWindow(turn, query) || !billed(turn)) {
                    continue;
                }
                const key = groupKey(turn);
                const current = rows.get(key);
                if (current === undefined) {
                    // Spreads optional fields rather than assigning them, so an absent account or model stays absent,
                    // not an explicit undefined.
                    rows.set(key, {
                        day: turn.day,
                        provider: turn.provider,
                        ...(turn.account !== undefined ? { account: turn.account } : {}),
                        ...(turn.model !== undefined ? { model: turn.model } : {}),
                        harness: turn.harness,
                        ...(turn.conversationId !== undefined ? { conversationId: turn.conversationId } : {}),
                        turns: turn.turns,
                        inputTokens: turn.inputTokens,
                        outputTokens: turn.outputTokens,
                        cacheReadTokens: turn.cacheReadTokens,
                        cacheCreationTokens: turn.cacheCreationTokens,
                        costUsd: turn.costUsd,
                        ...(turn.costKnown === false ? { costKnown: false } : {}),
                        durationMs: turn.durationMs,
                    });
                    continue;
                }
                rows.set(key, {
                    ...current,
                    turns: current.turns + turn.turns,
                    inputTokens: current.inputTokens + turn.inputTokens,
                    outputTokens: current.outputTokens + turn.outputTokens,
                    cacheReadTokens: current.cacheReadTokens + turn.cacheReadTokens,
                    cacheCreationTokens: current.cacheCreationTokens + turn.cacheCreationTokens,
                    costUsd: current.costUsd + turn.costUsd,
                    // One unpriced turn in a group makes the whole group's cost a lower bound.
                    ...(current.costKnown === false || turn.costKnown === false ? { costKnown: false } : {}),
                    durationMs: current.durationMs + turn.durationMs,
                });
            }
            // Oldest day first: every consumer plots or sums left-to-right in time.
            return [...rows.values()].toSorted((left, right) => left.day.localeCompare(right.day));
        },
    };
};
