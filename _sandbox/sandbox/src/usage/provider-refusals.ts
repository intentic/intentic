import { type ProviderRefusal, ProviderRefusalSchema } from "@intentic/sandbox-contract";
import { z } from "zod";
import { jsonFile } from "../store/json-file.js";

// Last refusal per provider, at <historyRoot>/provider-refusals.json, outside the agent's reach. account-usage.ts holds
// polled headroom; this holds the moment a plan actually said no, which polling can't produce. Written from the turn's
// own error path; last one wins, answering "when did this last happen", not "how often".

const StoredRefusalsSchema = z.record(z.string(), ProviderRefusalSchema);

export interface ProviderRefusalStore {
    // Every provider's last refusal, keyed by provider; one old enough to describe a reopened window is omitted, not
    // served.
    readonly read: () => Promise<Record<string, ProviderRefusal>>;
    readonly record: (provider: string, refusal: ProviderRefusal) => Promise<void>;
    // Settles a provider's refusal when a scoped turn runs on the account it named, the only proof an entitlement
    // refusal gets since it outlives any contradicting reading. A routed (nameless) refusal is settled by any success.
    readonly clear: (provider: string, account: string | undefined) => Promise<void>;
    // Fires on every write, with the refusal as it now stands or undefined once settled; what /events forwards, so open
    // windows update within the same beat.
    readonly onChange: (listener: (provider: string, refusal: ProviderRefusal | undefined) => void) => () => void;
}

// A week, the longest pool cycle any provider sells: past it a refusal's window has certainly reopened or its
// credential churned, so a stale one is worse than nothing. Forgotten on read, not pruned on write.
const FORGET_AFTER_MS = 7 * 24 * 60 * 60_000;

export const fileProviderRefusalStore = (path: string): ProviderRefusalStore => {
    const file = jsonFile<Record<string, ProviderRefusal>>(path, {
        parse: (raw) => StoredRefusalsSchema.safeParse(raw).data,
        fallback: () => ({}),
    });

    const listeners = new Set<(provider: string, refusal: ProviderRefusal | undefined) => void>();
    const announce = (provider: string, refusal: ProviderRefusal | undefined): void => {
        for (const listener of listeners) {
            listener(provider, refusal);
        }
    };

    return {
        read: async () => {
            const cutoff = Date.now() - FORGET_AFTER_MS;
            return Object.fromEntries(Object.entries(await file.read()).filter(([, refusal]) => refusal.at > cutoff));
        },
        record: async (provider, refusal) => {
            await file.update((current) => ({ ...current, [provider]: refusal }));
            announce(provider, refusal);
        },
        clear: async (provider, account) => {
            let settled = false;
            await file.update((current) => {
                const stored = current[provider];
                // A refusal naming a different account belongs to someone else, and is still true.
                if (stored === undefined || (stored.account !== undefined && stored.account !== account)) {
                    return current;
                }
                settled = true;
                const { [provider]: _settled, ...rest } = current;
                return rest;
            });
            if (settled) {
                announce(provider, undefined);
            }
        },
        onChange: (listener) => {
            listeners.add(listener);
            return () => listeners.delete(listener);
        },
    };
};
