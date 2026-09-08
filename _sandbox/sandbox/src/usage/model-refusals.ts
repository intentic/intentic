import { z } from "zod";
import { jsonFile } from "../store/json-file.js";

// Models this sandbox's credentials are refused for, at <historyRoot>/model-refusals.json, outside the agent's reach.
// Keyed by provider and model, unlike provider-refusals.ts's one entry per provider: a routed catalog lists models the
// plan may not serve, and a refusal of one says nothing about a sibling.

const StoredModelRefusalSchema = z.object({
    at: z.number(),
    // Vendor's own sentence, kept so a surface can say why a row is missing.
    message: z.string(),
});
export type StoredModelRefusal = z.infer<typeof StoredModelRefusalSchema>;

const StoredRefusalsSchema = z.record(z.string(), StoredModelRefusalSchema);

// Model id alone isn't unique across providers, and the catalog is asked per provider, so the pair is the key.
const keyOf = (provider: string, model: string): string => `${provider}:${model}`;

export interface ModelRefusalStore {
    // Models this provider's credentials were refused, as ids; empty for nearly every provider, so this must cost one
    // file read and no thought.
    readonly refused: (provider: string) => Promise<ReadonlySet<string>>;
    // Instant is the caller's, like provider-refusals, so a test can place it without faking the clock.
    readonly record: (provider: string, model: string, refusal: StoredModelRefusal) => Promise<void>;
}

// A day: long enough to hide a refused model through the session that found it, short enough that an upgrade is repaid
// by tomorrow. Forgotten on read, not pruned on write, like provider-refusals.
const FORGET_AFTER_MS = 24 * 60 * 60_000;

export const fileModelRefusalStore = (path: string): ModelRefusalStore => {
    const file = jsonFile<Record<string, StoredModelRefusal>>(path, {
        parse: (raw) => StoredRefusalsSchema.safeParse(raw).data,
        fallback: () => ({}),
    });
    return {
        refused: async (provider) => {
            const cutoff = Date.now() - FORGET_AFTER_MS;
            const prefix = `${provider}:`;
            const stored = await file.read();
            return new Set(
                Object.entries(stored)
                    .filter(([key, refusal]) => key.startsWith(prefix) && refusal.at > cutoff)
                    .map(([key]) => key.slice(prefix.length)),
            );
        },
        record: async (provider, model, refusal) => {
            await file.update((current) => ({ ...current, [keyOf(provider, model)]: refusal }));
        },
    };
};
