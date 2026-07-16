import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import type { Config } from "../env.config.js";
import { fileProviderKeysStore, resolveProviderKey } from "./provider-keys.js";

const tmpStore = async (): Promise<string> => join(await mkdtemp(join(tmpdir(), "provider-keys-")), "provider-keys.json");

test("the store round-trips per-provider keys and removes them independently", async () => {
    const store = fileProviderKeysStore(await tmpStore());
    expect(await store.get("codex")).toBeUndefined();
    await store.set("codex", "sk-openai");
    await store.set("grok", "xai-key");
    expect(await store.get("codex")).toBe("sk-openai");
    expect(await store.get("grok")).toBe("xai-key");
    await store.remove("codex");
    expect(await store.get("codex")).toBeUndefined();
    expect(await store.get("grok")).toBe("xai-key");
});

test("resolveProviderKey prefers the stored key, else the container-env fallback, else undefined", async () => {
    const store = fileProviderKeysStore(await tmpStore());
    const config = { openaiApiKey: "env-openai", xaiApiKey: "" } as unknown as Config;
    // No stored key ⇒ the container-env fallback serves codex; grok has neither, so undefined.
    expect(await resolveProviderKey(store, config, "codex")).toBe("env-openai");
    expect(await resolveProviderKey(store, config, "grok")).toBeUndefined();
    // A stored key wins over the env fallback.
    await store.set("codex", "sk-stored");
    expect(await resolveProviderKey(store, config, "codex")).toBe("sk-stored");
});
