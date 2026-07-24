import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { type AccountUsage, AccountUsageSchema } from "@intentic/sandbox-contract";
import { z } from "zod";

/* The latest subscription-usage snapshot per Claude account (<historyRoot>/claude-usage.json — on the /history
 * volume beside agents.json, so the agent can't rewrite what the account picker reports, and NOT in the
 * credential dir, whose every .json is read back as an account). The SDK reports rate_limit_event on the turn
 * stream at no token cost; until now the daemon forwarded it and forgot it, so the numbers lived only in
 * browser memory and died on reload. Persisting them is what lets the picker answer "which account has room
 * left" before a turn is spent finding out. */

const StoredUsageSchema = z.record(z.string(), AccountUsageSchema);

export interface ClaudeUsageStore {
    // Every account's snapshot, keyed by account id — windows that have already reset are omitted, so a caller
    // never sees a utilization the provider has since zeroed.
    readonly read: () => Promise<Record<string, AccountUsage>>;
    readonly record: (accountId: string, usage: AccountUsage) => Promise<void>;
    readonly clear: (accountId: string) => Promise<void>;
}

// A snapshot describes its window until that window resets. Utilization only climbs within a window, so an
// un-reset snapshot is a valid floor however old it is; past `resetsAt` it describes a window that no longer
// exists. A snapshot the SDK sent without a reset instant has no expiry basis — keep it and let `measuredAt`
// carry the caveat, rather than silently discarding the only reading we have.
const live = (usage: AccountUsage, now: number): boolean => usage.resetsAt === undefined || usage.resetsAt * 1000 > now;

export const fileClaudeUsageStore = (path: string): ClaudeUsageStore => {
    // One in-memory record is the authority (the daemon is the only writer); the file is its durable echo.
    let loaded: Promise<Record<string, AccountUsage>> | undefined;
    const load = (): Promise<Record<string, AccountUsage>> => {
        loaded ??= readFile(path, "utf8")
            .then((raw) => StoredUsageSchema.parse(JSON.parse(raw)))
            .catch(() => ({}) as Record<string, AccountUsage>);
        return loaded;
    };

    // Writes are serialized because turns on different accounts finish concurrently and node makes no promise
    // about overlapping writeFile calls to one path — each truncates then writes, so two in flight can leave a
    // torn file. `then(flush, flush)` also means one failed write doesn't poison every write after it.
    let writes: Promise<void> = Promise.resolve();
    const persist = async (mutate: (current: Record<string, AccountUsage>) => void): Promise<void> => {
        const current = await load();
        mutate(current);
        const flush = async (): Promise<void> => {
            await mkdir(dirname(path), { recursive: true });
            await writeFile(path, `${JSON.stringify(current, undefined, 2)}\n`);
        };
        writes = writes.then(flush, flush);
        return writes;
    };

    return {
        read: async () => {
            const now = Date.now();
            return Object.fromEntries(Object.entries(await load()).filter(([, usage]) => live(usage, now)));
        },
        record: (accountId, usage) =>
            persist((current) => {
                current[accountId] = usage;
            }),
        clear: (accountId) =>
            persist((current) => {
                delete current[accountId];
            }),
    };
};
