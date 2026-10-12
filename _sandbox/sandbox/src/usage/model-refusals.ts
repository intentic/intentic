import { z } from "zod";
import { defineDocument } from "../store/evolution/documents.js";
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

export const modelRefusalsDocument = defineDocument({
    root: "history",
    path: "model-refusals.json",
    schema: StoredModelRefusalSchema,
    granularity: "record",
});

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

// A refusal here takes a model off the picker for a day, which from outside reads as a model that vanished; each one
// recorded writes a line through `log`, so the disappearance has a cause on file.
export interface ModelRefusalStoreOptions {
    readonly log?: (fields: Record<string, unknown>, message: string) => void;
}

export const fileModelRefusalStore = (path: string, options: ModelRefusalStoreOptions = {}): ModelRefusalStore => {
    const log = options.log ?? (() => undefined);
    const file = jsonFile<Record<string, StoredModelRefusal>>(path, {
        parse: (raw) => StoredRefusalsSchema.safeParse(raw).data,
        fallback: () => ({}),
        document: modelRefusalsDocument,
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
            let known = false;
            await file.update((current) => {
                const previous = current[keyOf(provider, model)];
                known = previous !== undefined && previous.at > refusal.at - FORGET_AFTER_MS;
                return { ...current, [keyOf(provider, model)]: refusal };
            });
            // A model refused again is the same fact restated; only its first refusal (or one after the last aged out)
            // changes what the picker shows.
            if (!known) {
                log({ provider, model, reason: refusal.message }, `model refusal: ${provider} ${model} refused for this sandbox's credentials, hidden from the picker for a day`);
            }
        },
    };
};
