import { z } from "zod";
import { jsonFile } from "../store/json-file.js";

/* THE MODELS THIS SANDBOX'S CREDENTIALS ARE NOT ALLOWED TO RUN (<historyRoot>/model-refusals.json, beside
 * provider-refusals.json and account-usage.json, on the /history volume and outside the agent's reach for the
 * same reason: a turn must not be able to rewrite what the picker reports about it).
 *
 * The third of the three refusal records, and the one none of the other two can hold. account-usage.ts keeps
 * HEADROOM, which is about a pool. provider-refusals.ts keeps the moment a PROVIDER said no, one entry per
 * provider, which is right for a spent plan or a dead credential and exactly wrong here: Kimi refusing
 * kimi-k2.7-code-highspeed says nothing whatever about kimi-k3, which the same subscription serves in a
 * second. So this one is keyed by provider AND model, and it is the only refusal here that is a fact about
 * the CATALOG rather than about a moment.
 *
 * WHY IT IS WORTH PERSISTING AT ALL: a routed provider's catalog is what the vendor publishes, not what the
 * connected plan pays for (the translator lists all eight Kimi models on a plan that serves six). Nothing in
 * the model list can tell those apart, so the only evidence is a turn that tried — and without somewhere to
 * put that evidence, every user rediscovers it the same way, by watching a session hang.
 *
 * Written from the turn's own error path (agent.routes.ts), where the refusal arrives with the provider and
 * the model still in hand, and read by the catalog seam (provider-registry.ts), which drops the rows. */

const StoredModelRefusalSchema = z.object({
    at: z.number(),
    // The vendor's own sentence, kept so a surface that wants to say WHY a row is missing has the words. The
    // frame the user actually read is the turn's; this is the record of it.
    message: z.string(),
});
export type StoredModelRefusal = z.infer<typeof StoredModelRefusalSchema>;

const StoredRefusalsSchema = z.record(z.string(), StoredModelRefusalSchema);

// One entry's key. The model id alone is not unique across providers (two vendors can publish the same name),
// and the catalog is asked per provider, so the pair is both the identity and the query.
const keyOf = (provider: string, model: string): string => `${provider}:${model}`;

export interface ModelRefusalStore {
    // The models this provider's credentials were refused, as ids. Empty for nearly every provider, which is
    // the point: this is read on the catalog path, so it must cost one file read and no thought.
    readonly refused: (provider: string) => Promise<ReadonlySet<string>>;
    // The instant is the caller's, like provider-refusals next door: it is the one field a test has to be able
    // to place, and a store that stamped its own clock could only be tested by faking time.
    readonly record: (provider: string, model: string, refusal: StoredModelRefusal) => Promise<void>;
}

/* A DAY, and the trade behind the number is the one thing worth arguing about here.
 *
 * The refusal is not permanent in the way the store's neighbours' are: what makes it true is the PLAN, and a
 * plan is a thing people upgrade — often within minutes of reading a refusal that names the tier they need. A
 * store that forgot after the week provider-refusals keeps would hide a model somebody had just paid for,
 * with nothing on screen to explain where it went. A day is long enough that the picker stays clean through
 * the session that discovered the refusal and everything after it that day, and short enough that buying the
 * plan is repaid by tomorrow. Whoever upgrades sooner has one honest way back: the model reappears, and if the
 * plan still refuses it, one turn files it again.
 *
 * Forgotten on READ rather than pruned on write, like provider-refusals: a sandbox that never refuses again
 * must still stop hiding the model, and nothing would be writing to prune it. */
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
