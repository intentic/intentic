import { z } from "zod";
import { jsonFile } from "../store/json-file.js";

/* THE AUDIT TRAIL: one row per moment a stored secret actually LEFT, resolved into a shell command or typed
 * into a browser field. Substitution turns "the agent mentioned a secret" into "the agent spent one", and the
 * moment that happens must be visible somewhere the owner already looks; the secrets view joins these rows
 * onto its inventory as each entry's "last used".
 *
 * NEVER a value, and never the full command: the command text is reference-form by construction (resolution
 * is what fires the record), but it can name OTHER secrets and paths, `detail` keeps only the head of the
 * line, enough to answer "used where" without archiving the agent's shell history a second time.
 *
 * Capped, newest last. This is a "what happened recently" surface, not a ledger, the conversation transcript
 * remains the full record of what ran. */

const USE_CAP = 200;
export const DETAIL_MAX = 80;

const SecretUseSchema = z.object({
    // The registry name the reference carried, `CLOUDFLARE_API_TOKEN`, `reddit/password`.
    name: z.string(),
    // Which exit spent it: resolved into a shell command, resolved into a JS run's script, or typed into a
    // browser field.
    lane: z.enum(["shell", "code", "browser"]),
    // Where it went, in the reader's terms: the head of the agent's command line, or the page's host.
    detail: z.string().optional(),
    // Epoch ms, the store's clock, stamped at record time.
    at: z.number(),
});
export type SecretUse = z.infer<typeof SecretUseSchema>;

export interface SecretUsesStore {
    readonly record: (use: SecretUse) => Promise<void>;
    readonly all: () => Promise<readonly SecretUse[]>;
}

export const fileSecretUses = (path: string): SecretUsesStore => {
    const file = jsonFile<SecretUse[]>(path, {
        parse: (raw) => {
            const parsed = z.array(SecretUseSchema).safeParse(raw);
            return parsed.success ? parsed.data : undefined;
        },
        fallback: () => [],
        mode: 0o600,
    });
    return {
        record: async (use) => {
            await file.update((current) => [...current, use].slice(-USE_CAP));
        },
        all: () => file.read(),
    };
};

// The newest row per name, what the inventory join reads. Rows are appended in time order, so the last
// mention wins by construction.
export const lastUseByName = (uses: readonly SecretUse[]): ReadonlyMap<string, SecretUse> => {
    const byName = new Map<string, SecretUse>();
    for (const use of uses) {
        byName.set(use.name, use);
    }
    return byName;
};
