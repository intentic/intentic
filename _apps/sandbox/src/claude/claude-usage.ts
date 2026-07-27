import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { type AccountUsage, AccountUsageSchema, type UsageWindow } from "@intentic/sandbox-contract";
import { z } from "zod";

/* The latest subscription-usage snapshot per Claude account (<historyRoot>/claude-usage.json — on the /history
 * volume beside agents.json, so the agent can't rewrite what the account picker reports, and NOT in the
 * credential dir, whose every .json is read back as an account). Every plan-limit window, read from the CLI's
 * usage endpoint at turn end at no token cost (see claudeUsageWindows); until now the daemon forwarded the
 * stream's single-window rate_limit_event and forgot it, so the numbers lived only in browser memory and died
 * on reload. Persisting them is what lets the picker answer "which account has room left" before a turn is
 * spent finding out. */

const StoredUsageSchema = z.record(z.string(), AccountUsageSchema);

export interface ClaudeUsageStore {
    // Every account's snapshot, keyed by account id — windows that have already reset are omitted, so a caller
    // never sees a utilization the provider has since zeroed, and an account left with no live window at all
    // is absent rather than reported as measured-and-empty.
    readonly read: () => Promise<Record<string, AccountUsage>>;
    readonly record: (accountId: string, usage: AccountUsage) => Promise<void>;
    readonly clear: (accountId: string) => Promise<void>;
}

// A window describes its pool until that pool resets. Utilization only climbs within a window, so an un-reset
// reading is a valid floor however old it is; past `resetsAt` it describes a window that no longer exists. A
// window the provider sent without a reset instant has no expiry basis — keep it and let `measuredAt` carry
// the caveat, rather than silently discarding the only reading we have.
const liveWindows = (usage: AccountUsage, now: number): UsageWindow[] =>
    usage.windows.filter((window) => window.resetsAt === undefined || window.resetsAt * 1000 > now);

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
            return Object.fromEntries(
                Object.entries(await load())
                    .map(([id, usage]): [string, AccountUsage] => [id, { ...usage, windows: liveWindows(usage, now) }])
                    .filter(([, usage]) => usage.windows.length > 0),
            );
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
