import { z } from "zod";
import { defineDocument } from "../store/evolution/documents.js";
import { jsonEntries } from "../store/json-file.js";
import { stateRelPath } from "../state-paths.js";

// One row per moment a stored secret actually left (resolved into a command, typed into a browser field), joined onto
// the inventory as "last used". Never a value or the full command: `detail` keeps only the head of the line. Capped and
// newest-last; the conversation transcript is the full record.

const USE_CAP = 200;
export const DETAIL_MAX = 80;

const SecretUseSchema = z.object({
    // The registry name the reference carried, `CLOUDFLARE_API_TOKEN`, `reddit/password`.
    name: z.string(),
    // Which exit spent it: a shell command, a JS run's script, or a typed browser field.
    lane: z.enum(["shell", "code", "browser"]),
    // Where it went, in the reader's terms: the head of the agent's command line, or the page's host.
    detail: z.string().optional(),
    // The verified email that released a gated use, never from an unverified click; absent on an ungated use.
    approvedBy: z.string().optional(),
    // Epoch ms, the store's clock, stamped at record time.
    at: z.number(),
});
export type SecretUse = z.infer<typeof SecretUseSchema>;

export const secretUsesDocument = defineDocument({ path: stateRelPath(".intentic/records/secret-uses.json"), schema: SecretUseSchema, granularity: "entries" });

export interface SecretUsesStore {
    readonly record: (use: SecretUse) => Promise<void>;
    readonly all: () => Promise<readonly SecretUse[]>;
}

export const fileSecretUses = (path: string): SecretUsesStore => {
    const file = jsonEntries<SecretUse>(path, { entry: (raw) => SecretUseSchema.safeParse(raw).data, mode: 0o600, document: secretUsesDocument });
    return {
        record: async (use) => {
            await file.update((current) => [...current, use].slice(-USE_CAP));
        },
        all: () => file.read(),
    };
};

// The newest row per name; rows are appended in time order, so the last one wins by construction.
export const lastUseByName = (uses: readonly SecretUse[]): ReadonlyMap<string, SecretUse> => {
    const byName = new Map<string, SecretUse>();
    for (const use of uses) {
        byName.set(use.name, use);
    }
    return byName;
};
