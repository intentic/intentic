import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { KeyedProvider } from "@intentic/sandbox-contract";
import { z } from "zod";
import type { Config } from "../env.config.js";

// The sandbox-owned store of provider API keys (<workspace>/.intentic/provider-keys.json) the Claude Code harness
// uses — through the bundled translator — to serve non-Claude providers (codex → OpenAI, grok → xAI). One flat
// record of secrets, written 0600 and denylisted from agent reads like the capability tokens; only ever surfaced
// to the UI as hasKey booleans. Mirrors settings-store.ts: a small JSON file the /provider-keys routes edit.
const FileSchema = z.object({ codex: z.string().optional(), grok: z.string().optional() });
type File = z.infer<typeof FileSchema>;

export interface ProviderKeysStore {
    // The stored key for a provider, or undefined when none is set (callers fall back to the container-env key).
    readonly get: (provider: KeyedProvider) => Promise<string | undefined>;
    readonly set: (provider: KeyedProvider, key: string) => Promise<void>;
    readonly remove: (provider: KeyedProvider) => Promise<void>;
}

export const fileProviderKeysStore = (path: string): ProviderKeysStore => {
    const read = async (): Promise<File> => {
        try {
            const parsed = FileSchema.safeParse(JSON.parse(await readFile(path, "utf8")));
            return parsed.success ? parsed.data : {};
        } catch {
            return {};
        }
    };
    const write = async (file: File): Promise<void> => {
        await mkdir(dirname(path), { recursive: true });
        await writeFile(path, `${JSON.stringify(file, undefined, 2)}\n`, { mode: 0o600 });
    };
    return {
        get: async (provider) => (await read())[provider],
        set: async (provider, key) => write({ ...(await read()), [provider]: key }),
        remove: async (provider) => {
            const { [provider]: _removed, ...rest } = await read();
            await write(rest);
        },
    };
};

// The effective API key for a provider: the stored key, else the container-env fallback (OPENAI_API_KEY for codex,
// XAI_API_KEY for grok). undefined ⇒ no key anywhere ⇒ the provider can't run under the Claude Code harness.
export const resolveProviderKey = async (store: ProviderKeysStore, config: Config, provider: KeyedProvider): Promise<string | undefined> => {
    const stored = await store.get(provider);
    if (stored !== undefined) {
        return stored;
    }
    const envKey = provider === "codex" ? config.openaiApiKey : config.xaiApiKey;
    return envKey !== "" ? envKey : undefined;
};
