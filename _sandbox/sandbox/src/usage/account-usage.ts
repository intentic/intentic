import { type AccountUsage, AccountUsageSchema, type UsageContradiction, type UsageUnread } from "@intentic/sandbox-contract/schemas/providers/plan-limits";
import { bindingWindow, type ModelRef, currentWindows } from "@intentic/sandbox-contract/models/plan-pools";
import { z } from "zod";
import { at, pinDefault } from "../store/evolution/conversions.js";
import { defineDocument } from "../store/evolution/documents.js";
import { jsonFile } from "../store/json-file.js";
import { continueReading } from "./drift/continuity.js";

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
    // Every account's snapshot, keyed by account; a window already reset is kept as lapsed (currentWindows), and an
    // account with no window still current is absent rather than measured-and-empty.
    readonly read: () => Promise<Record<string, AccountUsage>>;
    // `whole`: the reader vouches this reading names every pool the account has, so a pool the last one named and this
    // one does not is kept, marked missing (drift/continuity.ts), rather than dropped without a word.
    readonly record: (account: string, usage: AccountUsage, options?: { readonly whole?: boolean }) => Promise<void>;
    // Says a re-read failed on the snapshot it failed to replace, in one write: a read-then-record would put back a
    // reading a turn's stream landed in between. Keeps the first failure's `since` while failures run on. Answers the
    // snapshot as written, or undefined when there is none to mark (nothing on screen for the failure to date).
    readonly markUnread: (account: string, unread: UsageUnread) => Promise<AccountUsage | undefined>;
    // Says a turn on `contradiction.model` was answered against this reading (AccountUsage.contradicted), in one write,
    // and only on a reading taken before `takenBefore`, when the answered request went out: a later one is the
    // provider's later word. Answers the snapshot as written, or undefined when nothing was marked.
    readonly contradict: (account: string, contradiction: UsageContradiction, takenBefore: number) => Promise<AccountUsage | undefined>;
    readonly clear: (account: string) => Promise<void>;
}

// Reset of the pool that refused the turn: the fullest pool this model spends (bindingWindow), scoped to the model
// since a separately metered pool (e.g. Opus at 100%) must not name its reset over a refused Sonnet turn.
export const accountLimitReset = async (store: AccountUsageStore, account: string | undefined, model: ModelRef | undefined): Promise<number | undefined> => {
    if (account === undefined) {
        return undefined;
    }
    return bindingWindow((await store.read())[account], model)?.resetsAt;
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
            // Utilization only climbs within a window, so a reading is a valid floor until `resetsAt` (or, with none
            // published, its own length). Past it the pool is kept as lapsed at the floor of 0, not dropped: dropping it
            // is how an account whose re-reads kept failing lost its five-hour row within hours while the weekly stayed.
            return Object.fromEntries(
                Object.entries(await file.read())
                    .map(([id, usage]): [string, AccountUsage] => [id, { ...usage, windows: currentWindows(usage, now) }])
                    .filter(([, usage]) => usage.windows.length > 0),
            );
        },
        record: async (account, usage, options) => {
            await file.update((current) => ({ ...current, [account]: continueReading(current[account], usage, options?.whole === true) }));
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
            return marked === undefined ? undefined : { ...marked, windows: currentWindows(marked, Date.now()) };
        },
        contradict: async (account, contradiction, takenBefore) => {
            let marked: AccountUsage | undefined;
            await file.update((current) => {
                const usage = current[account];
                if (usage === undefined || usage.measuredAt >= takenBefore) {
                    return current;
                }
                marked = { ...usage, contradicted: contradiction };
                return { ...current, [account]: marked };
            });
            return marked === undefined ? undefined : { ...marked, windows: currentWindows(marked, Date.now()) };
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
