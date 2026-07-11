import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { type Capability, CapabilitySchema } from "@intentic/sandbox-contract";
import { z } from "zod";

// The sandbox-owned manifest of active capabilities (<workspace>/.intentic/capabilities.json). Source of truth
// for what's active; mcp entries also feed the agent's MCP servers. On the secret denylist (an mcp token lives
// in its config) so the agent can't read it via the file routes. Replaces the old external-tools store.
export interface CapabilitiesStore {
    readonly list: () => Promise<Capability[]>;
    readonly get: (id: string) => Promise<Capability | undefined>;
    // Upsert by id (re-adding the same id edits its config).
    readonly upsert: (capability: Capability) => Promise<void>;
    // True when a capability of that id existed and was removed.
    readonly remove: (id: string) => Promise<boolean>;
}

// A JSON file store, used in production at <workspace>/.intentic/capabilities.json.
export const fileCapabilitiesStore = (path: string): CapabilitiesStore => {
    const read = async (): Promise<Capability[]> => {
        try {
            const parsed = z.array(CapabilitySchema).safeParse(JSON.parse(await readFile(path, "utf8")));
            return parsed.success ? parsed.data : [];
        } catch {
            return [];
        }
    };
    const write = async (capabilities: Capability[]): Promise<void> => {
        await mkdir(dirname(path), { recursive: true });
        await writeFile(path, `${JSON.stringify(capabilities, undefined, 2)}\n`);
    };
    return {
        list: read,
        get: async (id) => (await read()).find((capability) => capability.id === id),
        upsert: async (capability) => {
            await write([...(await read()).filter((existing) => existing.id !== capability.id), capability]);
        },
        remove: async (id) => {
            const capabilities = await read();
            const next = capabilities.filter((capability) => capability.id !== id);
            if (next.length === capabilities.length) {
                return false;
            }
            await write(next);
            return true;
        },
    };
};
