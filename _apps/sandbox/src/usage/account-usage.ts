import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { type AccountUsage, AccountUsageSchema, type UsageWindow } from "@intentic/sandbox-contract";
import { z } from "zod";

/* The latest plan-limit snapshot per ACCOUNT, whichever provider it belongs to (<historyRoot>/account-usage.json
 * — on the /history volume beside agents.json, so the agent can't rewrite what the account picker reports, and
 * NOT in the credential dir, whose every .json is read back as an account).
 *
 * ONE store for every provider, because a snapshot is one idea: `windows` + `measuredAt`, however it was
 * obtained. What differs per provider is only the READER — Claude's rides the turn stream at no token cost
 * (claudeUsageWindows), the routed subscriptions are pulled through the translator's management call
 * (translator-usage.ts) — and a reader's job ends the moment it hands a snapshot here. That split is what keeps
 * "which account has room left" a single question with a single answer: the picker, the composer chip and the
 * Agent tab's rings all read this file's shape and never care who filled it.
 *
 * Persisting matters for the same reason it did when this held Claude alone: before it existed the daemon
 * forwarded the stream's rate_limit_event and forgot it, so the numbers lived in browser memory and died on
 * reload. A pulled reading has the sharper version of that problem — without a durable snapshot every page load
 * would owe an upstream round-trip per account before it could draw a single ring.
 *
 * Distinct from usage-store.ts next door, which counts SPEND (turns, tokens, dollars). This one is headroom:
 * what the plan still allows. */

const StoredUsageSchema = z.record(z.string(), AccountUsageSchema);

export interface AccountUsageStore {
    // Every account's snapshot, keyed by account — windows that have already reset are omitted, so a caller
    // never sees a utilization the provider has since zeroed, and an account left with no live window at all
    // is absent rather than reported as measured-and-empty.
    readonly read: () => Promise<Record<string, AccountUsage>>;
    readonly record: (account: string, usage: AccountUsage) => Promise<void>;
    readonly clear: (account: string) => Promise<void>;
}

// A window describes its pool until that pool resets. Utilization only climbs within a window, so an un-reset
// reading is a valid floor however old it is; past `resetsAt` it describes a window that no longer exists. A
// window the provider sent without a reset instant has no expiry basis — keep it and let `measuredAt` carry
// the caveat, rather than silently discarding the only reading we have.
const liveWindows = (usage: AccountUsage, now: number): UsageWindow[] =>
    usage.windows.filter((window) => window.resetsAt === undefined || window.resetsAt * 1000 > now);

/* When a spent account's window reopens, for a refusal whose own stream never named an instant: the persisted
 * snapshots above. The pool that refused the turn is the account's FULLEST one, so its reset is when the wait
 * ends — the same binding-window rule the browser's usage readouts apply. It is what lets a rate_limit frame
 * say "resets Friday 11:22 PM" rather than only that the allowance is gone. */
export const accountLimitReset = async (store: AccountUsageStore, account: string | undefined): Promise<number | undefined> => {
    if (account === undefined) {
        return undefined;
    }
    const usage = (await store.read())[account];
    return usage?.windows.reduce<UsageWindow | undefined>(
        (worst, window) => (worst === undefined || window.utilization > worst.utilization ? window : worst),
        undefined,
    )?.resetsAt;
};

export const fileAccountUsageStore = (path: string): AccountUsageStore => {
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
        record: (account, usage) =>
            persist((current) => {
                current[account] = usage;
            }),
        clear: (account) =>
            persist((current) => {
                delete current[account];
            }),
    };
};
