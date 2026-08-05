import { type Capability, CapabilitySchema } from "@intentic/sandbox-contract";
import { jsonFile } from "../store/json-file.js";

// The sandbox-owned manifest of active capabilities (<workspace>/.intentic/capabilities.json). Source of truth
// for what's active; mcp entries also feed the agent's MCP servers. On the secret denylist (an mcp token lives
// in its config) so the agent can't read it via the file routes.
//
// Entries are validated ONE AT A TIME, and an entry that fails validation is skipped rather than failing the
// read. Parsing the file as `z.array(CapabilitySchema)` made a single bad entry return an EMPTY manifest — so
// one stale entry (a kind whose config shape changed under it, or a hand-edit) silently took down every
// unrelated capability with it: devops, docker, mcp, ssh. The blast radius has to be the one bad entry.
//
// A skipped entry is preserved in the file, never rewritten away: the writes below operate on the RAW array, so
// an entry this daemon can't read stays intact for a daemon that can (and for the user to fix by re-adding it).
export interface CapabilitiesStore {
    readonly list: () => Promise<Capability[]>;
    readonly get: (id: string) => Promise<Capability | undefined>;
    // Upsert by id (re-adding the same id edits its config).
    readonly upsert: (capability: Capability) => Promise<void>;
    // True when a capability of that id existed and was removed.
    readonly remove: (id: string) => Promise<boolean>;
}

// An entry's id without trusting its shape — enough to key the raw read-modify-write below, and to name the
// entry in the warning when it doesn't validate.
const rawId = (entry: unknown): string | undefined => {
    const id = (entry as { id?: unknown } | null)?.id;
    return typeof id === "string" ? id : undefined;
};

// A JSON file store, used in production at <workspace>/.intentic/capabilities.json. `onInvalid` reports an
// entry that could not be read, so a capability disappearing from the UI is never silent.
export const fileCapabilitiesStore = (path: string, onInvalid?: (id: string, reason: string) => void): CapabilitiesStore => {
    // Typed as the RAW array the writes preserve, not as Capability[] — per-entry validation happens in `read`
    // below so one unreadable entry costs itself and not the manifest. The schema check here is only "is this
    // a JSON array at all"; anything else reads as empty, which is also what a torn file used to read as
    // before jsonFile made torn files unobservable.
    const file = jsonFile<unknown[]>(path, { parse: (raw) => (Array.isArray(raw) ? raw : undefined), fallback: () => [] });
    const read = async (): Promise<Capability[]> =>
        (await file.read()).flatMap((entry) => {
            const parsed = CapabilitySchema.safeParse(entry);
            if (parsed.success) {
                return [parsed.data];
            }
            onInvalid?.(rawId(entry) ?? "<unnamed>", parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; "));
            return [];
        });
    return {
        list: read,
        get: async (id) => (await read()).find((capability) => capability.id === id),
        upsert: async (capability) => {
            await file.update((entries) => [...entries.filter((entry) => rawId(entry) !== capability.id), capability]);
        },
        remove: async (id) => {
            let removed = false;
            await file.update((entries) => {
                const next = entries.filter((entry) => rawId(entry) !== id);
                removed = next.length !== entries.length;
                // Unchanged by reference when nothing matched, so a remove of an absent id writes nothing.
                return removed ? next : entries;
            });
            return removed;
        },
    };
};
