// secrets: user-supplied env-var secrets the daemon writes to desired-state/.env
import { z } from "zod";
// The web posts a Cloudflare token / GitHub PAT / another-host SSH key straight to the sandbox daemon (never
// through the platform); `apply` reloads .env each run so a new secret is picked up with NO restart. `list`
// returns KEYS ONLY, the values never leave the sandbox; `reveal` is the one deliberate, owner-only exception.
export const SecretSetSchema = z.object({
    key: z
        .string()
        .regex(/^[A-Za-z_][A-Za-z0-9_]*$/)
        .max(128)
        .describe("The name to store it under, which is the name a process will find it by."),
    value: z.string().min(1).describe("The value. It goes straight to your sandbox and never through the platform."),
});
export const SecretKeysSchema = z.object({
    keys: z.array(z.string()).describe("The names that exist here. Only the names: the values never leave the sandbox."),
});
export const SecretKeyParamSchema = z.object({ key: z.string().describe("Which secret, by name.") });
export const SecretRevealSchema = z.object({ value: z.string().describe("The value itself. The only place in this API one is ever returned.") });
// One entry per secret the sandbox knows about, across every store: intent env secrets and intentic-generated
// passwords (from the desired-state repo), capability credentials, and AI-provider accounts. Values never ride
// this shape, `revealable` says whether `reveal` can return one (everything but provider accounts).
export const SecretInventoryEntrySchema = z.object({
    // Env-var key for env|generated; `<provider>:<accountId>` for provider entries; capability instance id
    // otherwise. Unique within the inventory, several accounts of one provider each get their own entry.
    key: z.string().describe("What identifies it. Unique across the whole inventory, so several accounts of one provider each get their own entry."),
    kind: z
        .enum(["env", "generated", "capability", "provider"])
        .describe("Where it came from: you set it, the sandbox generated it, a connection needs it, or it is a model account's credential."),
    // Display name for provider entries: "<ProviderName> · <accountLabel>". Absent on env/generated entries.
    label: z.string().optional().describe("A friendlier name, for entries that have one."),
    status: z.enum(["missing", "set", "connected"]).describe("Whether it exists and, for a connection, whether it is working."),
    // The artifact resources referencing this secret ({$secret} refs); [] for capability/provider entries.
    requiredBy: z
        .array(z.object({ resourceId: z.string().describe("Which resource."), type: z.string().describe("What kind of resource it is.") }))
        .describe("What is waiting on it. Empty for a connection's or an account's own credential."),
    // Human-readable provenance, e.g. "desired-state/.env", the UI's "where does this live" line.
    storedAt: z.string().describe("Where it actually lives, in words."),
    revealable: z.boolean().describe("Whether its value can be shown at all. Everything except a model account's credential can be."),
    // Forgejo Actions replication state, present only after adopt on env|generated entries.
    ci: z
        .object({
            synced: z.boolean().describe("Whether the pipeline has it."),
            pushedAt: z.string().optional().describe("When it was last sent there."),
        })
        .optional()
        .describe("Whether a copy has been given to the build pipeline."),
    /* The newest row of the use ledger that concerns this entry, when the agent last SPENT it, on which lane
     * (a shell command, a JS run's script, a browser field), and where it went (the head of the command or
     * script, or the page's host). Names and destinations only, never values. Absent while a secret has never
     * been used, which most never are. */
    lastUse: z
        .object({
            at: z.number().describe("When, in milliseconds."),
            lane: z.enum(["shell", "code", "browser"]).describe("How it was used: a command, a script, or typed into a page."),
            detail: z
                .string()
                .optional()
                .describe("Where it went: the start of the command or script, or the site. Names and destinations only, never values."),
        })
        .optional()
        .describe("The last time an agent actually spent this secret. Absent while it never has been, which most never are."),
});
export type SecretInventoryEntry = z.infer<typeof SecretInventoryEntrySchema>;
export const SecretInventorySchema = z.object({
    entries: z
        .array(SecretInventoryEntrySchema)
        .describe("One entry per secret this sandbox knows about, from every place they live. No values, ever."),
});
