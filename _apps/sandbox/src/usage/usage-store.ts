import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { type UsageRollupRow, type UsageTurn, UsageTurnSchema } from "@intentic/sandbox-contract";

/* The durable spend ledger (historyRoot/usage.jsonl): one append-only line per attributed turn, written by the
 * daemon only. Living under historyRoot keeps it outside the agent's /work mount, so the agent can't rewrite
 * its own spend record — the same placement rationale as the activity log and workspace history.
 *
 * Why a second log rather than reusing activity.jsonl: that log prunes to its most recent entries, which is
 * right for an audit feed and wrong for money. Under pruning a spend total SHRINKS as newer turns evict older
 * ones, so "what did this month cost" is not merely unavailable but actively misreported. This log is never
 * pruned. A row is ~250 bytes and a heavy day is ~100 turns, so a year of hard use lands near 9 MB — cheap
 * enough that exactness beats compaction.
 * ponytail: if a multi-year sandbox ever makes the read cost matter, fold days older than the current quarter
 * into one pre-rolled line per day. That is a pure compaction of rows this schema already describes — no
 * migration, because `rollup` sums whatever granularity it finds. */

export interface UsageStore {
    // Fills `at` + `day`. Called once per turn from the turn-end path; a failure surfaces to its caller (which
    // logs and moves on) and never poisons later appends.
    readonly record: (turn: Omit<UsageTurn, "at" | "day">) => Promise<void>;
    // Grouped by day × provider × account × model × harness × conversation, oldest day first. Inclusive UTC
    // day bounds.
    readonly rollup: (query: { from?: string | undefined; to?: string | undefined }) => Promise<UsageRollupRow[]>;
}

// The UTC calendar day an instant falls in. UTC, not the container's local zone: the sandbox's TZ is incidental
// (it is a container), and a stable bucket the browser can reason about beats one that shifts with the host. A
// viewer east or west of UTC sees turns within a few hours of midnight attributed to the neighbouring day; the
// total over any range is exact either way, which is what a cost readout is actually read for.
export const utcDay = (at: number): string => new Date(at).toISOString().slice(0, 10);

// The rollup's grouping key. JSON of the tuple rather than a string join: model and account ids are provider
// data, and a separator-based key would collide the moment one contained the separator.
const groupKey = (row: Pick<UsageTurn, "day" | "provider" | "account" | "model" | "harness" | "conversationId">): string =>
    JSON.stringify([row.day, row.provider, row.account, row.model, row.harness, row.conversationId]);

export const fileUsageStore = (path: string, now: () => number = Date.now): UsageStore => {
    let queue: Promise<unknown> = Promise.resolve();

    const read = async (): Promise<UsageTurn[]> => {
        let raw: string;
        try {
            raw = await readFile(path, "utf8");
        } catch {
            return [];
        }
        return raw
            .split("\n")
            .filter((line) => line !== "")
            .flatMap((line) => {
                try {
                    const parsed = UsageTurnSchema.safeParse(JSON.parse(line));
                    return parsed.success ? [parsed.data] : [];
                } catch {
                    // A torn line (crash mid-append) loses one turn's numbers, never the ledger.
                    return [];
                }
            });
    };

    return {
        record: (turn) => {
            const step = queue.then(async () => {
                await mkdir(dirname(path), { recursive: true });
                const at = now();
                const record: UsageTurn = { at, day: utcDay(at), ...turn };
                await appendFile(path, `${JSON.stringify(record)}\n`);
            });
            // A failed step surfaces to ITS caller; the chain itself never poisons later appends.
            queue = step.catch(() => undefined);
            return step;
        },
        rollup: async (query) => {
            const rows = new Map<string, UsageRollupRow>();
            for (const turn of await read()) {
                if ((query.from !== undefined && turn.day < query.from) || (query.to !== undefined && turn.day > query.to)) {
                    continue;
                }
                const key = groupKey(turn);
                const current = rows.get(key);
                if (current === undefined) {
                    // Spread the optional attribution fields rather than assigning them: an absent account or
                    // model must stay absent, not become an explicit undefined the wire schema would carry.
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
                    durationMs: current.durationMs + turn.durationMs,
                });
            }
            // Oldest day first: every consumer plots or sums left-to-right in time.
            return [...rows.values()].toSorted((left, right) => left.day.localeCompare(right.day));
        },
    };
};
