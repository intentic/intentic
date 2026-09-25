import { z } from "zod";
import { defineDocument } from "../store/documents.js";
import { jsonFile } from "../store/json-file.js";

// When a model reopens, at <historyRoot>/model-cooldowns.json, outside the agent's reach. Keyed by provider and model,
// like model-refusals.ts, and deliberately separate from it: that store keeps what a plan never covered and hides the
// row for a day, this keeps a model every credential is benched on right now and says when it comes back.
// The gap it closes: a routed provider balances across credentials, so a spent allowance is a fact about the MODEL, not
// about any one account. Without it every account ring can read 2% while the model they all refuse stays on the list.

const StoredCooldownSchema = z.object({
    // Epoch ms, unlike a window's `resetsAt`: this is read against Date.now(), never drawn beside a plan's pools.
    until: z.number(),
    // Provider's own sentence, so a surface can say why in the words that refused.
    message: z.string(),
});
export type StoredCooldown = z.infer<typeof StoredCooldownSchema>;

const StoredSchema = z.record(z.string(), StoredCooldownSchema);

export const modelCooldownsDocument = defineDocument({
    root: "history",
    path: "model-cooldowns.json",
    schema: StoredCooldownSchema,
    granularity: "record",
});

// Model id alone isn't unique across providers, and the catalog is asked per provider, so the pair is the key.
const keyOf = (provider: string, model: string): string => `${provider}:${model}`;

export interface ModelCooldownStore {
    // Models this provider cannot serve right now, to the instant each reopens; empty for nearly every provider, so
    // this must cost one file read and no thought.
    readonly cooling: (provider: string) => Promise<ReadonlyMap<string, StoredCooldown>>;
    readonly record: (provider: string, model: string, cooldown: StoredCooldown) => Promise<void>;
}

export const fileModelCooldownStore = (path: string): ModelCooldownStore => {
    const file = jsonFile<Record<string, StoredCooldown>>(path, {
        parse: (raw) => StoredSchema.safeParse(raw).data,
        fallback: () => ({}),
        document: modelCooldownsDocument,
    });
    return {
        cooling: async (provider) => {
            const now = Date.now();
            const prefix = `${provider}:`;
            const stored = await file.read();
            // Expired on read, not pruned on write, like the refusal stores beside it: an entry whose instant has passed
            // is a model that has already reopened, and nothing has to run for that to become true.
            return new Map(
                Object.entries(stored)
                    .filter(([key, cooldown]) => key.startsWith(prefix) && cooldown.until > now)
                    .map(([key, cooldown]) => [key.slice(prefix.length), cooldown] as const),
            );
        },
        record: async (provider, model, cooldown) => {
            await file.update((current) => ({ ...current, [keyOf(provider, model)]: cooldown }));
        },
    };
};
