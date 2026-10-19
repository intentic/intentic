import { z } from "zod";
import { defineDocument } from "../store/evolution/documents.js";
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
    // Epoch ms the refusal that benched it was filed: an answer to a request sent before then settles nothing. Absent
    // from an entry an older build wrote, which any answer settles, as it always did.
    since: z.number().optional(),
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
    // A model that just served content is open, whatever the stored instant says: a credential came back early, or the
    // refusal that benched it was one account's and not the whole pool's. Without this the row reads "Back at …" while
    // turns on it go through. `askedAt` is when the answering request went out; a bench filed at or after it stands.
    readonly clear: (provider: string, model: string, askedAt?: number) => Promise<void>;
}

// A cooldown hides a model from the picker, so one recorded and never cleared reads, from outside, as a model that
// vanished. Each change writes one line through `log`: benched (until when, in whose words) and reopened (because a turn
// on it served, and how early that was). A clear that finds nothing, the case on nearly every turn, writes nothing.
export interface ModelCooldownStoreOptions {
    readonly log?: (fields: Record<string, unknown>, message: string) => void;
}

export const fileModelCooldownStore = (path: string, options: ModelCooldownStoreOptions = {}): ModelCooldownStore => {
    const log = options.log ?? (() => undefined);
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
            log({ provider, model, until: new Date(cooldown.until).toISOString(), reason: cooldown.message }, `model cooldown: ${provider} ${model} benched until ${new Date(cooldown.until).toISOString()}`);
        },
        // Returns the same object when nothing is stored, so the common case (no cooldown) never writes the file.
        clear: async (provider, model, askedAt) => {
            let reopened: StoredCooldown | undefined;
            await file.update((current) => {
                const key = keyOf(provider, model);
                const stored = current[key];
                // Benched while the answering request was already in flight: its answer says nothing about the bench.
                reopened = stored !== undefined && askedAt !== undefined && stored.since !== undefined && stored.since >= askedAt ? undefined : stored;
                if (reopened === undefined) {
                    return current;
                }
                const { [key]: _reopened, ...rest } = current;
                return rest;
            });
            if (reopened !== undefined) {
                // An entry already past its instant was over anyway; only one cut short says a turn proved it open early.
                const early = reopened.until - Date.now();
                log(
                    { provider, model, until: new Date(reopened.until).toISOString(), ...(early > 0 ? { earlyByMs: early } : {}) },
                    `model cooldown: ${provider} ${model} reopened, a turn on it served`,
                );
            }
        },
    };
};
