import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { type Capability, CapabilitySchema } from "@intentic/sandbox-contract";

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
    // The file's entries, unvalidated — what the writes preserve.
    const readRaw = async (): Promise<unknown[]> => {
        try {
            const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
            return Array.isArray(parsed) ? parsed : [];
        } catch {
            return [];
        }
    };
    const read = async (): Promise<Capability[]> =>
        (await readRaw()).flatMap((entry) => {
            const parsed = CapabilitySchema.safeParse(entry);
            if (parsed.success) {
                return [parsed.data];
            }
            onInvalid?.(rawId(entry) ?? "<unnamed>", parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; "));
            return [];
        });
    const write = async (entries: unknown[]): Promise<void> => {
        await mkdir(dirname(path), { recursive: true });
        await writeFile(path, `${JSON.stringify(entries, undefined, 2)}\n`);
    };
    return {
        list: read,
        get: async (id) => (await read()).find((capability) => capability.id === id),
        upsert: async (capability) => {
            await write([...(await readRaw()).filter((entry) => rawId(entry) !== capability.id), capability]);
        },
        remove: async (id) => {
            const entries = await readRaw();
            const next = entries.filter((entry) => rawId(entry) !== id);
            if (next.length === entries.length) {
                return false;
            }
            await write(next);
            return true;
        },
    };
};
