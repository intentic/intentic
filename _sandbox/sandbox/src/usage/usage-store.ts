import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { type UsageRollupRow, type UsageTurn, UsageTurnSchema } from "@intentic/sandbox-contract";

/* The durable spend AND OUTCOME ledger (historyRoot/usage.jsonl): one append-only line per turn, written by the
 * daemon only. Living under historyRoot keeps it outside the agent's /work mount, so the agent can't rewrite
 * its own spend record, the same placement rationale as the activity log and workspace history.
 *
 * It carries two things now, and the second one is why every turn lands rather than only the billed ones: what
 * the turn cost, and how it ENDED. A turn's fate used to live in the activity feed, which prunes to its most
 * recent entries, so an incident was readable until the feed rolled past it and unanswerable afterwards. Money
 * needed a log that never prunes; it turns out a post-mortem needs the same log, and the row is the same row.
 * `rollup` keeps the money honest by summing only turns the provider counted (see `billed`), so a file that
 * holds every failure still projects a cost panel that holds none of them.
 *
 * Why a second log rather than reusing activity.jsonl: that log prunes to its most recent entries, which is
 * right for an audit feed and wrong for money. Under pruning a spend total SHRINKS as newer turns evict older
 * ones, so "what did this month cost" is not merely unavailable but actively misreported. This log is never
 * pruned. A row is ~250 bytes and a heavy day is ~100 turns, so a year of hard use lands near 9 MB, cheap
 * enough that exactness beats compaction.
 * ponytail: if a multi-year sandbox ever makes the read cost matter, fold days older than the current quarter
 * into one pre-rolled line per day. That is a pure compaction of rows this schema already describes, no
 * migration, because `rollup` sums whatever granularity it finds. */

export interface UsageStore {
    // Fills `at` + `day`. Called once per turn from the turn-end path; a failure surfaces to its caller (which
    // logs and moves on) and never poisons later appends.
    readonly record: (turn: Omit<UsageTurn, "at" | "day">) => Promise<void>;
    // Grouped by day × provider × account × model × harness × conversation, oldest day first. Inclusive UTC
    // day bounds.
    readonly rollup: (query: { from?: string | undefined; to?: string | undefined }) => Promise<UsageRollupRow[]>;
    // The rows themselves, same bounds. The rollup is a projection built for the cost panels and cannot answer
    // a question about the SPREAD of turns, the terse experiment needs a per-turn variance to put a margin on
    // its delta, and summing that out of grouped rows is exactly the information the grouping destroyed.
    readonly turns: (query: { from?: string | undefined; to?: string | undefined }) => Promise<UsageTurn[]>;
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

// Inclusive UTC day bounds; an absent bound is unbounded on that side.
const inWindow = (turn: UsageTurn, query: { from?: string | undefined; to?: string | undefined }): boolean =>
    (query.from === undefined || turn.day >= query.from) && (query.to === undefined || turn.day <= query.to);

/* DID THIS TURN COST ANYTHING. The rollup's filter, and the line that lets the ledger hold every turn while the
 * money projection still only sums money.
 *
 * The ledger records failures now (see the outcome fields on UsageTurnSchema), and a turn refused before the
 * provider charged a token carries nothing but zeros. Those rows are the point of recording failures at all and
 * they have no business in a cost readout: grouped, they would add rows reading "0 turns, $0.00" to every panel
 * that groups by model, one per distinct failure key per day.
 *
 * `turns`, not `costUsd`: a real turn can legitimately cost nothing (a cached-through exchange on a plan with no
 * per-token price) and it still happened and still belongs in the count. A turn the provider never counted is
 * the one that did not. */
const billed = (turn: UsageTurn): boolean => turn.turns > 0;

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
