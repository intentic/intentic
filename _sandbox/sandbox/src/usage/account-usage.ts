import {
    type AccountUsage,
    AccountUsageSchema,
    bindingWindow,
    gatingWindows,
    type ModelRef,
    type UsageUnread,
    type UsageWindow,
    windowLive,
} from "@intentic/sandbox-contract";
import { z } from "zod";
import { at, pinDefault } from "../store/conversions.js";
import { defineDocument } from "../store/documents.js";
import { jsonFile } from "../store/json-file.js";

// Latest plan-limit snapshot per account, any provider, at <historyRoot>/account-usage.json: one shape
// (`windows`+`measuredAt`) regardless of which reader filled it (Claude's turn stream, or the translator's pull).
// Persisted so a page load doesn't owe a round trip; distinct from usage-store.ts, which counts spend, not headroom.

const StoredUsageSchema = z.record(z.string(), AccountUsageSchema);

export const accountUsageDocument = defineDocument({
    root: "history",
    path: "account-usage.json",
    schema: AccountUsageSchema,
    granularity: "record",
    // A window measured before gates existed applied to every model.
    history: [at("windows.*", pinDefault("gates", "all"))],
});

export interface AccountUsageStore {
    // Every account's snapshot, keyed by account; windows already reset are omitted, and an account left with none is
    // absent rather than measured-and-empty.
    readonly read: () => Promise<Record<string, AccountUsage>>;
    readonly record: (account: string, usage: AccountUsage) => Promise<void>;
    // Says a re-read failed on the snapshot it failed to replace, in one write: a read-then-record would put back a
    // reading a turn's stream landed in between. Keeps the first failure's `since` while failures run on. Answers the
    // snapshot as written, or undefined when there is none to mark (nothing on screen for the failure to date).
    readonly markUnread: (account: string, unread: UsageUnread) => Promise<AccountUsage | undefined>;
    readonly clear: (account: string) => Promise<void>;
}

// Utilization only climbs within a window, so a reading is a valid floor until `resetsAt`; past it the window no longer
// exists. A window with no published reset is retired by its own length instead (windowLive): a five-hour pool read as
// empty says nothing about the window that opened after it, and without this a provider that publishes no reset for an
// idle pool leaves a 0% on screen for as long as nothing can be re-read.
const liveWindows = (usage: AccountUsage, now: number): UsageWindow[] =>
    usage.windows.filter((window) => windowLive(window, usage.measuredAt, now));

// Reset of the pool that refused the turn: the fullest pool this model spends (bindingWindow), scoped to the model
// since a separately metered pool (e.g. Opus at 100%) must not name its reset over a refused Sonnet turn.
export const accountLimitReset = async (store: AccountUsageStore, account: string | undefined, model: ModelRef | undefined): Promise<number | undefined> => {
    if (account === undefined) {
        return undefined;
    }
    return bindingWindow((await store.read())[account], model)?.resetsAt;
};

// Which account an unnamed caller runs on. Four tiers, since "no reading", "read as 100%", and "refused" are different
// facts, worst last:
// 0 measured with room, headroom proven
// 1 never measured, no evidence either way
// 2 measured at the cap, known spent
// 3 refused a turn, worse than spent since an idle meter still looks best
// Within a tier the lowest spend wins; ties keep the caller's order. Spend is read only on the pools the turn's model
// spends (gatingWindows), so an unrelated per-model slice can't bench an account for another model.
export const accountWithHeadroom = async (
    store: AccountUsageStore,
    accounts: readonly string[],
    // Account with a refusal still standing, if any; undefined leaves the ranking as it was.
    refused?: string,
    model?: ModelRef,
): Promise<string | undefined> => {
    const [first] = accounts;
    // The only account there is runs regardless of refusal; a failure now explains itself, unlike a stale refusal.
    if (first === undefined || accounts.length === 1) {
        return first;
    }
    // read() has already dropped reset windows, so what's left is what the plan still counts.
    const usage = await store.read();
    const ranked = accounts.map((account) => {
        const windows = gatingWindows(usage[account], model);
        const spent = windows.reduce((worst, window) => Math.max(worst, window.utilization), 0);
        return { account, tier: account === refused ? 3 : windows.length === 0 ? 1 : spent >= 100 ? 2 : 0, spent };
    });
    return ranked.reduce((best, next) => (next.tier !== best.tier ? (next.tier < best.tier ? next : best) : next.spent < best.spent ? next : best))
        .account;
};

export const fileAccountUsageStore = (path: string): AccountUsageStore => {
    // File is the authority, not a cached copy: two writers (a Claude stream, the translator's pull) need read-through
    // so a fresh snapshot is never served stale; the atomic swap stops concurrent writes from tearing the file.
    const file = jsonFile<Record<string, AccountUsage>>(path, {
        parse: (raw) => StoredUsageSchema.safeParse(raw).data,
        fallback: () => ({}),
        document: accountUsageDocument,
    });

    return {
        read: async () => {
            const now = Date.now();
            return Object.fromEntries(
                Object.entries(await file.read())
                    .map(([id, usage]): [string, AccountUsage] => [id, { ...usage, windows: liveWindows(usage, now) }])
                    .filter(([, usage]) => usage.windows.length > 0),
            );
        },
        record: async (account, usage) => {
            await file.update((current) => ({ ...current, [account]: usage }));
        },
        markUnread: async (account, unread) => {
            let marked: AccountUsage | undefined;
            await file.update((current) => {
                const usage = current[account];
                if (usage === undefined) {
                    return current;
                }
                marked = { ...usage, unread: { ...unread, since: usage.unread?.since ?? unread.since } };
                return { ...current, [account]: marked };
            });
            return marked === undefined ? undefined : { ...marked, windows: liveWindows(marked, Date.now()) };
        },
        clear: async (account) => {
            await file.update((current) => {
                if (!(account in current)) {
                    return current;
                }
                const { [account]: _dropped, ...rest } = current;
                return rest;
            });
        },
    };
};
