import { type ProviderRefusal, ProviderRefusalSchema } from "@intentic/sandbox-contract";
import { z } from "zod";
import { jsonFile } from "../store/json-file.js";

/* THE LAST REFUSAL PER PROVIDER (<historyRoot>/provider-refusals.json — beside account-usage.json, on the
 * /history volume and outside the agent's reach, for the same reason: a turn must not be able to rewrite what
 * the account surfaces report about it).
 *
 * The observed counterpart to account-usage.ts next door. That store holds HEADROOM — polled, account-wide, and
 * a floor by construction. This one holds the moment a plan actually said no, which is the fact a poll cannot
 * produce: five minutes of staleness is the entire distance between a green meter and a turn that will not run.
 * See ProviderRefusalSchema for why the key is the provider rather than the account.
 *
 * Written from the turn's own error path (agent.routes.ts), which is the only place that sees a refusal with the
 * provider it belongs to still in hand. Last one wins — this answers "when did this last happen", not "how often",
 * and the spend ledger already carries the per-turn history for anyone counting. */

const StoredRefusalsSchema = z.record(z.string(), ProviderRefusalSchema);

export interface ProviderRefusalStore {
    // Every provider's last refusal, keyed by provider — refusals old enough to describe a window that has
    // certainly reopened are omitted rather than served (see FORGET_AFTER_MS).
    readonly read: () => Promise<Record<string, ProviderRefusal>>;
    readonly record: (provider: string, refusal: ProviderRefusal) => Promise<void>;
}

/* A week, which is the longest pool cycle any of these providers sells. Past it a limit refusal describes a
 * window that has certainly reopened and an auth refusal describes a credential that has certainly been used
 * since or is long dead — either way it has stopped being something to act on, and a stale one sitting under a
 * healthy meter is worse than nothing there at all.
 *
 * Forgotten on READ rather than pruned on write: a daemon that never refuses again must still stop reporting
 * the refusal it has on file, and nothing would be writing to prune it. */
const FORGET_AFTER_MS = 7 * 24 * 60 * 60_000;

export const fileProviderRefusalStore = (path: string): ProviderRefusalStore => {
    const file = jsonFile<Record<string, ProviderRefusal>>(path, {
        parse: (raw) => StoredRefusalsSchema.safeParse(raw).data,
        fallback: () => ({}),
    });

    return {
        read: async () => {
            const cutoff = Date.now() - FORGET_AFTER_MS;
            return Object.fromEntries(Object.entries(await file.read()).filter(([, refusal]) => refusal.at > cutoff));
        },
        record: async (provider, refusal) => {
            await file.update((current) => ({ ...current, [provider]: refusal }));
        },
    };
};
