import { AgentProviderSchema } from "@intentic/sandbox-contract";
import { z } from "zod";
import { defineDocument } from "../store/documents.js";
import { jsonFile } from "../store/json-file.js";

// Per-account stay-away for a provider's usage endpoint, at <historyRoot>/usage-parks.json. On disk rather than in
// memory because this daemon restarts far more often than a provider's rate-limit window runs: a park held only in
// memory is dropped by every restart, and the sweep that runs at boot then spends the one read the provider was
// refusing, which answers with a stay-away measured from the new moment. Three restarts in a day is three more hours
// of a frozen number.

const ParkedReadSchema = z.object({
    provider: AgentProviderSchema,
    // Epoch ms: the provider's own retry-after, resolved to an instant, so a restart reads the same deadline.
    until: z.number(),
});
export type ParkedRead = z.infer<typeof ParkedReadSchema>;

const StoredParksSchema = z.record(z.string(), ParkedReadSchema);

export const usageParksDocument = defineDocument({ root: "history", path: "usage-parks.json", schema: ParkedReadSchema, granularity: "record" });

export interface UsageParkStore {
    // Every standing park, keyed the way the usage store keys an account; one whose instant has passed is omitted, not
    // served.
    readonly read: () => Promise<Record<string, ParkedRead>>;
    readonly record: (account: string, parked: ParkedRead) => Promise<void>;
    readonly clear: (account: string) => Promise<void>;
}

export const fileUsageParkStore = (path: string): UsageParkStore => {
    const file = jsonFile<Record<string, ParkedRead>>(path, {
        parse: (raw) => StoredParksSchema.safeParse(raw).data,
        fallback: () => ({}),
        document: usageParksDocument,
    });

    return {
        read: async () => {
            const now = Date.now();
            return Object.fromEntries(Object.entries(await file.read()).filter(([, parked]) => parked.until > now));
        },
        record: async (account, parked) => {
            await file.update((current) => ({ ...current, [account]: parked }));
        },
        clear: async (account) => {
            await file.update((current) => {
                if (!(account in current)) {
                    return current;
                }
                const { [account]: _lifted, ...rest } = current;
                return rest;
            });
        },
    };
};

/** A park store for a caller with nothing to persist to, e.g. a test harness or the demo daemon. */
export const memoryUsageParkStore = (): UsageParkStore => {
    const parks = new Map<string, ParkedRead>();
    return {
        read: async () => {
            const now = Date.now();
            return Object.fromEntries([...parks].filter(([, parked]) => parked.until > now));
        },
        record: async (account, parked) => {
            parks.set(account, parked);
        },
        clear: async (account) => {
            parks.delete(account);
        },
    };
};
