import { type AccountUsage, AccountUsageSchema, type UsageWindow } from "@intentic/sandbox-contract";
import { z } from "zod";
import { jsonFile } from "../store/json-file.js";

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
    /* The FILE is the authority, not an in-memory record it echoes. This used to load once and answer every
     * read from that copy, which was defensible while the daemon was the only writer — but the two writers
     * here (a Claude turn's stream, the translator's pull) are exactly the concurrency `update`'s queue is
     * for, and reading through means a snapshot one of them just recorded is never served stale. Turns on
     * different accounts do finish at the same moment, and a bare writeFile truncates before it fills, so
     * the atomic swap is what stops one of those overlaps from leaving a torn file behind. */
    const file = jsonFile<Record<string, AccountUsage>>(path, {
        parse: (raw) => StoredUsageSchema.safeParse(raw).data,
        fallback: () => ({}),
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
